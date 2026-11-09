/**
 * POST /api/score-portfolio
 *
 * Generates an AI narrative analysis of the portfolio's score breakdown.
 * The frontend computes the algorithmic scores; this route only adds the
 * qualitative interpretation from Groq.
 *
 * Body: { score, breakdown, nPositions, currency, lang,
 *         brokerNames, absoluteValues, top5, worst3, assetClasses }
 * Response: { insight: string, processingMs: number }
 */

import { getGroq } from '../lib/groqClient.js';
import { addLog } from '../lib/logBuffer.js';
import { TEXT_MODEL } from '../lib/groqModels.js';
import { narrativeParams, isTruncated } from '../lib/groqNarrative.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';

const MODEL = TEXT_MODEL;

// ── Asset class label translation ─────────────────────────────────────────────
// Prevents raw DB class names ("Others", "Unknown", "stock") from leaking
// into the AI prompt or the final user-facing analysis.
const CLASS_LABELS_ES = {
  stock: 'Renta Variable / Stock Picking',
  stocks: 'Renta Variable / Stock Picking',
  equity: 'Renta Variable',
  equities: 'Renta Variable',
  etf: 'ETF Indexado',
  bond: 'Renta Fija',
  bonds: 'Renta Fija',
  'fixed income': 'Renta Fija',
  crypto: 'Criptoactivos',
  cryptocurrency: 'Criptoactivos',
  cash: 'Liquidez',
  fund: 'Fondo de Inversión',
  funds: 'Fondos de Inversión',
  reit: 'Inmobiliario (REIT)',
  commodity: 'Materias Primas',
  commodities: 'Materias Primas',
  others: 'Renta Variable',
  other: 'Renta Variable',
  unknown: 'Renta Variable',
};
const CLASS_LABELS_EN = {
  stock: 'Equities / Stock Picking',
  stocks: 'Equities / Stock Picking',
  equity: 'Equities',
  equities: 'Equities',
  etf: 'Index ETF',
  bond: 'Fixed Income',
  bonds: 'Fixed Income',
  'fixed income': 'Fixed Income',
  crypto: 'Crypto',
  cryptocurrency: 'Crypto',
  cash: 'Cash',
  fund: 'Investment Fund',
  funds: 'Investment Funds',
  reit: 'Real Estate (REIT)',
  commodity: 'Commodities',
  commodities: 'Commodities',
  others: 'Equities',
  other: 'Equities',
  unknown: 'Equities',
};

const translateClass = (cls, isEs) => {
  const map = isEs ? CLASS_LABELS_ES : CLASS_LABELS_EN;
  return map[(cls || '').toLowerCase()] || cls;
};

export async function scorePortfolio(req, res) {
  const start = Date.now();
  const {
    score, breakdown, nPositions = 0, lang = 'es', currency = 'EUR',
    brokerNames = [], absoluteValues = {}, top5 = [], worst3 = [], assetClasses = [],
    sectors = [], countries = [], performance: twr = null,
  } = req.body || {};

  if (typeof score !== 'number' || typeof breakdown !== 'object' || breakdown === null) {
    return res.status(400).json({ error: 'score and breakdown are required' });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  const { diversification, performance, costs, liquidity } = breakdown;
  const income = breakdown.income || { dividendYield: 0 };
  const isEs = lang !== 'en';
  const sym  = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  // Máximo REAL de cada pilar (WEIGHTS 30/30/20/20 desde 2026-09-11). Escribir
  // "/25" a mano producía "28/25" en cuanto un pilar superaba el máximo viejo.
  const maxOf = (pillar, fallback) => (Number.isFinite(pillar?.max) ? Math.round(pillar.max) : fallback);

  // ── Format helpers ────────────────────────────────────────────────────────
  // es-ES: "32.146 €"; en: "€32,146". useGrouping 'always' para que 4 cifras lleven punto.
  const fmtMoney = (n) => {
    if (n === undefined || n === null || !Number.isFinite(Number(n))) return isEs ? `— ${sym}` : `${sym}—`;
    const v = Math.round(Number(n));
    const abs = Math.abs(v).toLocaleString(isEs ? 'es-ES' : 'en-US', { useGrouping: 'always' });
    const sign = v < 0 ? '-' : '';
    return isEs ? `${sign}${abs} ${sym}` : `${sign}${sym}${abs}`;
  };
  const fmtPct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—');

  // ── Strategy detection hint ───────────────────────────────────────────────
  // Passed to the model so it doesn't misjudge a Growth portfolio as income-starved.
  const isGrowthProfile = income.dividendYield < 1 && performance.gainPct > 8;
  const strategyHint = isEs
    ? isGrowthProfile
      ? 'Perfil detectado: GROWTH (yield <1%, ROI alto). No sugerir estrategias de dividendos.'
      : income.dividendYield >= 3
        ? 'Perfil detectado: INCOME / DIVIDENDOS (yield alto).'
        : 'Perfil mixto o indefinido.'
    : isGrowthProfile
      ? 'Detected profile: GROWTH (yield <1%, high ROI). Do not suggest dividend strategies.'
      : income.dividendYield >= 3
        ? 'Detected profile: INCOME / DIVIDEND (high yield).'
        : 'Mixed or undefined profile.';

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = isEs
    ? `Eres Trazza AI, analista financiero senior. Tu comunicación es directa y precisa, sin frases de relleno.
Tienes los datos REALES de la cartera. Genera el análisis en EXACTAMENTE TRES secciones, usando este formato:

📊 Diagnóstico Actual
(Máximo 2 frases. Resume el valor total de la cartera, la plusvalía/minusvalía y el principal factor de riesgo. Si el efectivo es negativo, llámalo "apalancamiento" o "margen activo" — nunca "liquidez negativa".)

⚠️ Puntos Críticos
· [bullet directo con número en negrita]
· [bullet directo con número en negrita]
(2 o 3 bullets. Solo lo que realmente importa: concentración, apalancamiento, ratio de costes, etc.)

🎯 Movimientos Estratégicos
· [acción concreta basada en los datos]
· [acción concreta basada en los datos]
(2 o 3 bullets. Razona desde los datos reales — no generes consejos genéricos.)

REGLAS MILITARES — absolutas e inapelables:
1. COSTES: Si el ratio de comisiones es INFERIOR al 1,00%, está ESTRICTAMENTE PROHIBIDO mencionarlo como riesgo ni decir que erosiona la rentabilidad. Lo calificarás explícitamente como "Óptimo y eficiente". Solo es Punto Crítico si SUPERA el 1,5% anual.
2. ANTI-DIDÁCTICA: Nunca expliques las consecuencias básicas de un concepto financiero. PROHIBIDO: "La concentración aumenta el riesgo si una acción cae". CORRECTO: "Alta concentración (HHI 0.228) — 78,2% del patrimonio en 3 posiciones tecnológicas."
3. TELEGRÁFICO: Cada directiva de Movimientos Estratégicos tiene un MÁXIMO de 15 palabras. Cero paja. Orden táctica directa.
4. GROWTH (yield <1%, ROI alto): no recomendar dividendos ni renta fija como prioridad.
5. FISCAL: PROHIBIDO recomendar vender, recortar o reducir cualquier posición en ganancias (venderla tributa). Para diversificar o subir la liquidez, la vía es dirigir las APORTACIONES FUTURAS, nunca vender.
6. No recomiendes comprar valores concretos (sí tipos de activo, p. ej. "ETF de salud"). Puedes NOMBRAR una posición de los datos al describir un riesgo. Sin datos inventados.
7. Clases de activos ya traducidas — úsalas tal cual.
8. Números clave en **negrita** (markdown). Importes en formato español: "1.250 €", nunca "€1,250".
9. Las cabeceras de sección van tal cual (emoji + texto), sin negrita.
10. La rentabilidad ponderada por tiempo (TWR) mide la gestión sin el efecto de las aportaciones; si está disponible, úsala para juzgar el rendimiento.`
    : `You are Trazza AI, a senior financial analyst. Your communication is direct and precise — no filler phrases.
You have the user's REAL portfolio data. Generate the analysis in EXACTLY THREE sections, using this format:

📊 Current Diagnosis
(Maximum 2 sentences. Summarise total portfolio value, gain/loss, and the main risk factor. If cash is negative, call it "leverage" or "active margin" — never "negative liquidity".)

⚠️ Critical Points
· [direct bullet with key figure in bold]
· [direct bullet with key figure in bold]
(2 or 3 bullets. Only what truly matters: concentration, leverage, cost ratio, etc.)

🎯 Strategic Moves
· [concrete action based on the data]
· [concrete action based on the data]
(2 or 3 bullets. Reason from real data — no generic advice.)

MILITARY RULES — absolute and non-negotiable:
1. COSTS: If the fee ratio is BELOW 1.00%, it is STRICTLY FORBIDDEN to mention it as a risk or say it erodes returns. You must explicitly qualify it as "Optimal and efficient". Only a Critical Point if it EXCEEDS 1.5% annually.
2. ANTI-DIDACTICS: Never explain basic consequences of financial concepts. FORBIDDEN: "Concentration increases risk if a stock falls". CORRECT: "High concentration (HHI 0.228) — 78.2% of assets in 3 tech positions."
3. TELEGRAPHIC: Each Strategic Move directive has a MAXIMUM of 15 words. Zero filler. Direct tactical order.
4. GROWTH (yield <1%, high ROI): no dividend or fixed income recommendations as priorities.
5. TAX: FORBIDDEN to recommend selling, trimming or reducing any position that is in gain (selling is taxable). To diversify or raise cash, the route is directing FUTURE CONTRIBUTIONS, never selling.
6. Do not recommend buying specific securities (asset types are fine, e.g. "healthcare ETF"). You MAY name a position from the data when describing a risk. No invented data.
7. Asset class names already translated — use them as-is.
8. Key figures in **bold** (markdown).
9. Section headers go as-is (emoji + text), not bold.
10. Time-weighted return (TWR) measures management without the effect of contributions; when available, use it to judge performance.`;

  // ── Build rich data block ─────────────────────────────────────────────────
  const av = absoluteValues;
  const cashValue = av.cashPosition ?? 0;
  const cashLabel = isEs
    ? cashValue < 0
      ? `APALANCAMIENTO ACTIVO (margen negativo): ${fmtMoney(cashValue)}`
      : `Liquidez disponible: ${fmtMoney(cashValue)}`
    : cashValue < 0
      ? `ACTIVE LEVERAGE (negative margin): ${fmtMoney(cashValue)}`
      : `Available cash: ${fmtMoney(cashValue)}`;

  const posLine = top5.length > 0
    ? top5.map(p => `  · ${p.name} (${p.ticker}): **${p.weight}%** cartera, ROI ${p.gainPct >= 0 ? '+' : ''}${p.gainPct}%`).join('\n')
    : isEs ? '  (sin datos de posiciones)' : '  (no position data)';

  const worstLine = worst3.length > 0
    ? worst3.map(p => `  · ${p.name} (${p.ticker}): **${p.gainPct}%**`).join('\n')
    : isEs ? '  · Ninguna en pérdidas significativas' : '  · None with significant losses';

  // Translate class names so the model never sees raw DB values
  const classLine = assetClasses.length > 0
    ? assetClasses.map(c => `${translateClass(c.cls, isEs)} **${c.pct}%**`).join(' | ')
    : isEs ? '(sin clasificación)' : '(no classification)';

  const brokersLine = brokerNames.length > 0 ? brokerNames.join(', ') : isEs ? 'no especificado' : 'not specified';

  const mixLine = (list) => (Array.isArray(list) && list.length
    ? list.slice(0, 6).map(s => `${String(s.name).slice(0, 40)} **${Number(s.pct).toFixed(1)}%**`).join(' | ')
    : (isEs ? '(sin datos)' : '(no data)'));
  const sectorLine = mixLine(sectors);
  const countryLine = mixLine(countries);

  // Rentabilidad ponderada por tiempo (la misma serie del gráfico del Dashboard).
  const twrLine = twr && Number.isFinite(twr.twrTotalPct)
    ? (isEs
      ? `TWR total ${fmtPct(twr.twrTotalPct)}${twr.since ? ` desde ${twr.since}` : ''} · anualizada ${fmtPct(twr.annualizedPct)} · en el año ${fmtPct(twr.ytdPct)} · último mes ${fmtPct(twr.oneMonthPct)}`
      : `Total TWR ${fmtPct(twr.twrTotalPct)}${twr.since ? ` since ${twr.since}` : ''} · annualised ${fmtPct(twr.annualizedPct)} · YTD ${fmtPct(twr.ytdPct)} · last month ${fmtPct(twr.oneMonthPct)}`)
    : (isEs ? 'no disponible (no lo inventes)' : 'not available (do not invent it)');

  const dataBlock = isEs
    ? `=== DATOS DE CARTERA ===
${strategyHint}
Posiciones abiertas: ${nPositions} | Puntuación global: **${Math.round(score)}/100**
Brokers: ${brokersLine}
Composición por clase de activo: ${classLine}
Sectores: ${sectorLine}
Países: ${countryLine}
Rentabilidad ponderada por tiempo: ${twrLine}

VALORES ABSOLUTOS (${currency}):
- Valor total cartera: **${fmtMoney(av.totalWealth)}**
- Capital invertido (coste histórico): ${fmtMoney(av.totalInvested)}
- ${cashLabel}
- Comisiones pagadas (acumulado): ${fmtMoney(av.totalFees)}
- Dividendos cobrados (acumulado): ${fmtMoney(av.totalDividends)}

TOP 5 POSICIONES POR PESO:
${posLine}

POSICIONES EN PÉRDIDAS:
${worstLine}

MÉTRICAS DE PUNTUACIÓN:
- Diversificación **${Math.round(diversification.score)}/${maxOf(diversification, 30)}** — HHI ${diversification.hhi.toFixed(3)} (${diversification.hhi < 0.15 ? 'muy diversificada' : diversification.hhi < 0.35 ? 'diversificación moderada' : 'muy concentrada'})
- Rentabilidad **${Math.round(performance.score)}/${maxOf(performance, 30)}** — ROI ${performance.gainPct >= 0 ? '+' : ''}${performance.gainPct.toFixed(1)}%
- Costes **${Math.round(costs.score)}/${maxOf(costs, 20)}** — ratio comisiones ${costs.feeRatio.toFixed(2)}% anualizado
- Liquidez **${Math.round(liquidity.score)}/${maxOf(liquidity, 20)}** — efectivo ${liquidity.cashPct.toFixed(1)}%${liquidity.cashPct < 0 ? ' ⚠️ MARGEN ACTIVO' : ''}
- Yield de dividendos ${income.dividendYield.toFixed(2)}% (contexto: NO puntúa en el score)`
    : `=== PORTFOLIO DATA ===
${strategyHint}
Open positions: ${nPositions} | Global score: **${Math.round(score)}/100**
Brokers: ${brokersLine}
Asset class mix: ${classLine}
Sectors: ${sectorLine}
Countries: ${countryLine}
Time-weighted return: ${twrLine}

ABSOLUTE VALUES (${currency}):
- Total portfolio value: **${fmtMoney(av.totalWealth)}**
- Invested capital (historical cost): ${fmtMoney(av.totalInvested)}
- ${cashLabel}
- Total fees paid (cumulative): ${fmtMoney(av.totalFees)}
- Total dividends received (cumulative): ${fmtMoney(av.totalDividends)}

TOP 5 POSITIONS BY WEIGHT:
${posLine}

POSITIONS IN LOSS:
${worstLine}

SCORE METRICS:
- Diversification **${Math.round(diversification.score)}/${maxOf(diversification, 30)}** — HHI ${diversification.hhi.toFixed(3)} (${diversification.hhi < 0.15 ? 'very diversified' : diversification.hhi < 0.35 ? 'moderate diversification' : 'highly concentrated'})
- Performance **${Math.round(performance.score)}/${maxOf(performance, 30)}** — ROI ${performance.gainPct >= 0 ? '+' : ''}${performance.gainPct.toFixed(1)}%
- Costs **${Math.round(costs.score)}/${maxOf(costs, 20)}** — fee ratio ${costs.feeRatio.toFixed(2)}% annualised
- Liquidity **${Math.round(liquidity.score)}/${maxOf(liquidity, 20)}** — cash ${liquidity.cashPct.toFixed(1)}%${liquidity.cashPct < 0 ? ' ⚠️ ACTIVE MARGIN' : ''}
- Dividend yield ${income.dividendYield.toFixed(2)}% (context only: it does NOT score)`;

  try {
    const completion = await getGroq(30_000).chat.completions.create({
      model: MODEL,
      temperature: 0.25,
      ...narrativeParams(MODEL, 750),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: dataBlock },
      ],
    });

    const insight = completion.choices[0]?.message?.content?.trim() || '';

    // Empty/blank completion is not a usable analysis — surface it as a fallback
    // and DON'T consume the user's AI quota for a response they can't see.
    if (!insight || isTruncated(completion)) {
      addLog('error', 'ai', 'Portfolio score: empty AI response (usage not counted)');
      return res.status(200).json({ isFallback: true, processingMs: Date.now() - start });
    }

    await req.incrementUsage?.();

    const ms = Date.now() - start;
    addLog('ok', 'ai', `Portfolio score analysis (${lang}) · ${ms}ms`, { score: Math.round(score), model: MODEL });
    return res.json({ insight, processingMs: ms });

  } catch (err) {
    console.error('[score-portfolio] Groq error:', err.message);
    addLog('error', 'ai', `Portfolio score error: ${err.message}`);
    return res.status(200).json({ isFallback: true, processingMs: Date.now() - start });
  }
}
