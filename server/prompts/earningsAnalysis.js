/**
 * Prompt builder for POST /api/analyze-earnings — PURE, no I/O.
 *
 * The route is a thin shell (sanitise → build → Groq → respond); every decision
 * about what the model sees lives here so it can be unit-tested offline.
 *
 * Two modes, driven by whether the quarter is already published:
 *  - published  (epsActual !== null) → post-mortem: what was reported + how the
 *    market read it (using the real price reaction when the client supplies it).
 *  - upcoming   (epsActual === null) → forward-looking: what the market expects.
 */

const MAX_HISTORY  = 8;   // quarters of EPS history
const MAX_REVENUE  = 8;   // quarters of revenue/earnings
const MAX_NAME_LEN = 80;
const MAX_TICKER_LEN = 24;

// Strips control chars and caps length — company names and quarter labels come
// from third-party APIs and are interpolated into the prompt verbatim.
const clean = (value, max) => {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return stripped ? stripped.slice(0, max) : null;
};

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Normalises an untrusted request body into the exact shape buildEarningsPrompt
 * expects. Returns null when the payload has no usable ticker.
 */
export function sanitizeEarningsPayload(body) {
  const raw = body || {};
  const ticker = clean(raw.ticker, MAX_TICKER_LEN);
  if (!ticker) return null;

  const ev = raw.event || {};
  const px = raw.priceReaction || {};

  return {
    ticker,
    name: clean(raw.name, MAX_NAME_LEN) || ticker,
    lang: raw.lang === 'en' ? 'en' : 'es',
    currency: clean(raw.currency, 8) || 'USD',
    event: {
      date: clean(ev.date, 30),
      epsActual: num(ev.epsActual),
      epsForecast: num(ev.epsForecast),
      surprisePct: num(ev.surprisePct),
      time: clean(ev.time, 30),
      fiscalQuarter: clean(ev.fiscalQuarter, 30),
    },
    history: (Array.isArray(raw.history) ? raw.history : [])
      .slice(0, MAX_HISTORY)
      .map(q => ({
        date: clean(q?.date, 30),
        epsActual: num(q?.epsActual),
        epsEstimate: num(q?.epsEstimate),
        surprisePct: num(q?.surprisePct),
        upcoming: q?.upcoming === true,
      })),
    revenue: (Array.isArray(raw.revenue) ? raw.revenue : [])
      .slice(0, MAX_REVENUE)
      .map(q => ({
        quarter: clean(q?.quarter, 20),
        revenue: num(q?.revenue),
        earnings: num(q?.earnings),
      })),
    priceReaction: {
      changePct: num(px.changePct),
      price: num(px.price),
      currency: clean(px.currency, 8),
      fiftyTwoWeekChangePct: num(px.fiftyTwoWeekChangePct),
    },
  };
}

// ── Guard de plausibilidad del BPA ────────────────────────────────────────────
// Los calendarios de terceros (Nasdaq/EODHD) publican a veces un "eps" que no es
// el BPA trimestral comparable con la estimación: acumulados del ejercicio, cifras
// de otra clase de acción o de otro periodo. El caso que lo destapó: GOOGL Jun/2026
// con real 9.11 vs est. 2.88 → sorpresa "+216%", que el modelo celebraba como un
// batacazo histórico. Mismo espíritu que isPlausiblePriceUpdate en el front: no
// borramos el dato, lo marcamos para que el análisis no se construya encima.

const SURPRISE_ABS_LIMIT = 100;   // % — por encima de esto la cifra es sospechosa
const HISTORY_RATIO_LIMIT = 3;    // veces el mayor BPA histórico conocido

/**
 * Devuelve null si el dato es creíble, o { reasonEs, reasonEn } describiendo por qué no.
 */
export function assessEpsPlausibility(event, history) {
  if (event.epsActual === null) return null;

  if (event.surprisePct !== null && Math.abs(event.surprisePct) >= SURPRISE_ABS_LIMIT) {
    const pct = fmtPct(event.surprisePct);
    return {
      reasonEs: `sorpresa declarada de ${pct}, magnitud impropia de un resultado trimestral real`,
      reasonEn: `reported surprise of ${pct}, a magnitude a real quarterly result does not reach`,
    };
  }

  const actuals = history
    .filter(q => !q.upcoming && q.epsActual !== null)
    .map(q => Math.abs(q.epsActual));
  if (actuals.length > 0) {
    const maxKnown = Math.max(...actuals);
    if (maxKnown > 0 && Math.abs(event.epsActual) > maxKnown * HISTORY_RATIO_LIMIT) {
      return {
        reasonEs: `BPA real ${fmtEps(event.epsActual)} frente a un máximo histórico de ${fmtEps(maxKnown)}`,
        reasonEn: `actual EPS ${fmtEps(event.epsActual)} versus a historical maximum of ${fmtEps(maxKnown)}`,
      };
    }
  }

  return null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmtEps = (n) => (n === null ? null : n.toFixed(2));
const fmtPct = (n) => (n === null ? null : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);

// 1.23e9 → "1.23B" so the model never has to reason about 10-digit integers
const fmtBig = (n) => {
  if (n === null) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return `${n}`;
};

const timeLabel = (time, isEs) => {
  if (time === 'time-before-hours') return isEs ? 'antes de apertura' : 'before market open';
  if (time === 'time-after-hours') return isEs ? 'tras el cierre' : 'after market close';
  return null;
};

// ── System prompts ────────────────────────────────────────────────────────────

const SYSTEM_PUBLISHED_ES = `Eres Trazza AI, analista senior de renta variable. Analizas la presentación de resultados YA PUBLICADA de UNA empresa, a partir de datos REALES que se te entregan.
Escribe EXACTAMENTE tres secciones con este formato:

📊 Los números
(Máximo 2 frases. Qué presentó: BPA real frente al estimado, sorpresa en %, y tendencia de ingresos si hay datos.)

💬 Reacción del mercado
(Máximo 2 frases. Cómo lo ha leído el mercado. Si se aporta el movimiento de la cotización, parte de él. Si NO se aporta, dilo y ofrece la lectura probable basada en el historial de sorpresas — etiquétala como lectura, no como hecho.)

🔭 Qué vigilar
· [bullet directo]
· [bullet directo]
(2 o 3 bullets, máximo 15 palabras cada uno.)

REGLAS ABSOLUTAS:
1. SOLO los datos aportados. Está PROHIBIDO inventar cifras, guidance, márgenes, segmentos o declaraciones de directivos que no aparezcan en los datos.
2. Si falta un dato, dilo en una cláusula corta ("sin dato de ingresos") — nunca lo estimes.
3. Nada de recomendaciones de compra/venta, precios objetivo ni valoraciones tipo "está barata".
4. ANTI-DIDÁCTICA: no expliques qué es el BPA ni por qué batir estimaciones suele subir la acción.
5. Telegráfico, cero relleno. Cifras clave en **negrita** (markdown).
6. Responde en español.`;

const SYSTEM_PUBLISHED_EN = `You are Trazza AI, a senior equity analyst. You analyse an ALREADY PUBLISHED earnings report for ONE company, using the REAL data provided to you.
Write EXACTLY three sections in this format:

📊 The numbers
(Maximum 2 sentences. What was reported: actual EPS vs estimate, surprise %, and revenue trend if data exists.)

💬 Market reaction
(Maximum 2 sentences. How the market read it. If a price move is provided, start from it. If NOT provided, say so and give the likely reading based on the surprise history — label it as a reading, not a fact.)

🔭 What to watch
· [direct bullet]
· [direct bullet]
(2 or 3 bullets, maximum 15 words each.)

ABSOLUTE RULES:
1. ONLY the data provided. It is FORBIDDEN to invent figures, guidance, margins, segments or management quotes that are not in the data.
2. If a data point is missing, say so in a short clause ("no revenue data") — never estimate it.
3. No buy/sell recommendations, no price targets, no "it's cheap" valuations.
4. ANTI-DIDACTICS: never explain what EPS is or why beating estimates tends to lift a stock.
5. Telegraphic, zero filler. Key figures in **bold** (markdown).
6. Answer in English.`;

const SYSTEM_UPCOMING_ES = `Eres Trazza AI, analista senior de renta variable. La empresa AÚN NO ha publicado estos resultados: tu análisis es previo, sobre las expectativas.
Escribe EXACTAMENTE tres secciones con este formato:

📊 Qué se espera
(Máximo 2 frases. BPA estimado, fecha y momento de publicación, y qué implica frente a los trimestres anteriores.)

💬 Sensación del mercado
(Máximo 2 frases. Lectura del posicionamiento a partir del historial de sorpresas y de la evolución de ingresos/BPA aportada. Etiquétala como expectativa, nunca como hecho consumado.)

🔭 Qué vigilar
· [bullet directo]
· [bullet directo]
(2 o 3 bullets, máximo 15 palabras cada uno.)

REGLAS ABSOLUTAS:
1. SOLO los datos aportados. PROHIBIDO inventar cifras, guidance, consenso de analistas o declaraciones que no aparezcan en los datos.
2. Nunca hables de los resultados como si ya se conocieran. No inventes el desenlace.
3. Si falta un dato, dilo en una cláusula corta — nunca lo estimes.
4. Nada de recomendaciones de compra/venta ni precios objetivo.
5. ANTI-DIDÁCTICA: no expliques conceptos financieros básicos.
6. Telegráfico, cero relleno. Cifras clave en **negrita** (markdown).
7. Responde en español.`;

const SYSTEM_UPCOMING_EN = `You are Trazza AI, a senior equity analyst. The company has NOT reported this quarter yet: your analysis is a preview about expectations.
Write EXACTLY three sections in this format:

📊 What's expected
(Maximum 2 sentences. Estimated EPS, reporting date and time, and what it implies versus previous quarters.)

💬 Market sentiment
(Maximum 2 sentences. Read the positioning from the surprise history and the revenue/EPS trend provided. Label it as an expectation, never as a settled fact.)

🔭 What to watch
· [direct bullet]
· [direct bullet]
(2 or 3 bullets, maximum 15 words each.)

ABSOLUTE RULES:
1. ONLY the data provided. FORBIDDEN to invent figures, guidance, analyst consensus or quotes not present in the data.
2. Never write about the results as if they were already known. Do not invent the outcome.
3. If a data point is missing, say so in a short clause — never estimate it.
4. No buy/sell recommendations, no price targets.
5. ANTI-DIDACTICS: never explain basic financial concepts.
6. Telegraphic, zero filler. Key figures in **bold** (markdown).
7. Answer in English.`;

/**
 * Builds { system, user, published } for a sanitised payload.
 */
export function buildEarningsPrompt(payload) {
  const { ticker, name, lang, event, history, revenue, priceReaction } = payload;
  const isEs = lang !== 'en';
  const published = event.epsActual !== null;

  const lines = [];
  lines.push(isEs ? '=== DATOS DE LA PRESENTACIÓN ===' : '=== EARNINGS REPORT DATA ===');
  lines.push(`${name} (${ticker})`);
  if (event.date) lines.push(isEs ? `Fecha del informe: ${event.date}` : `Report date: ${event.date}`);
  if (event.fiscalQuarter) lines.push(isEs ? `Trimestre fiscal: ${event.fiscalQuarter}` : `Fiscal quarter: ${event.fiscalQuarter}`);

  const tl = timeLabel(event.time, isEs);
  if (tl) lines.push(isEs ? `Momento de publicación: ${tl}` : `Reporting time: ${tl}`);

  lines.push(published
    ? (isEs ? 'Estado: RESULTADOS YA PUBLICADOS' : 'Status: RESULTS ALREADY PUBLISHED')
    : (isEs ? 'Estado: PENDIENTE DE PUBLICAR' : 'Status: NOT REPORTED YET'));

  if (published) {
    lines.push(isEs
      ? `BPA real: **${fmtEps(event.epsActual)}**${event.epsForecast !== null ? ` | BPA estimado: ${fmtEps(event.epsForecast)}` : ' | sin estimación disponible'}`
      : `Actual EPS: **${fmtEps(event.epsActual)}**${event.epsForecast !== null ? ` | Estimated EPS: ${fmtEps(event.epsForecast)}` : ' | no estimate available'}`);
    if (event.surprisePct !== null) {
      lines.push(isEs ? `Sorpresa: **${fmtPct(event.surprisePct)}**` : `Surprise: **${fmtPct(event.surprisePct)}**`);
    }
    const doubt = assessEpsPlausibility(event, history);
    if (doubt) {
      lines.push(isEs
        ? `AVISO DE CALIDAD DE DATOS: la cifra de BPA real viene de un calendario de terceros y NO cuadra con la empresa (${doubt.reasonEs}). Trátala como POSIBLEMENTE ERRÓNEA: dilo de forma explícita en la primera sección, NO la presentes como un batacazo histórico y NO construyas la lectura de mercado sobre esa sorpresa.`
        : `DATA QUALITY WARNING: the actual EPS figure comes from a third-party calendar and does NOT fit the company (${doubt.reasonEn}). Treat it as POSSIBLY WRONG: say so explicitly in the first section, do NOT present it as a historic beat, and do NOT build the market reading on that surprise.`);
    }
  } else if (event.epsForecast !== null) {
    lines.push(isEs ? `BPA estimado: **${fmtEps(event.epsForecast)}**` : `Estimated EPS: **${fmtEps(event.epsForecast)}**`);
  } else {
    lines.push(isEs ? 'Sin estimación de BPA disponible' : 'No EPS estimate available');
  }

  // Price reaction — the single most valuable input for "how did the market take it"
  const px = priceReaction;
  if (px.changePct !== null) {
    const cur = px.currency || '';
    lines.push(isEs
      ? `Cotización: ${px.price !== null ? `${px.price} ${cur} · ` : ''}variación de la sesión **${fmtPct(px.changePct)}**`
      : `Quote: ${px.price !== null ? `${px.price} ${cur} · ` : ''}session change **${fmtPct(px.changePct)}**`);
  } else {
    lines.push(isEs
      ? 'Movimiento de la cotización: NO DISPONIBLE (no lo inventes)'
      : 'Price move: NOT AVAILABLE (do not invent it)');
  }
  if (px.fiftyTwoWeekChangePct !== null) {
    lines.push(isEs
      ? `Variación 52 semanas: ${fmtPct(px.fiftyTwoWeekChangePct)}`
      : `52-week change: ${fmtPct(px.fiftyTwoWeekChangePct)}`);
  }

  const pastQuarters = history.filter(q => !q.upcoming && q.epsActual !== null);
  if (pastQuarters.length > 0) {
    lines.push('');
    lines.push(isEs ? 'HISTORIAL DE BPA (más reciente primero):' : 'EPS HISTORY (most recent first):');
    pastQuarters.forEach(q => {
      const parts = [`  · ${q.date || '—'}: ${isEs ? 'real' : 'actual'} ${fmtEps(q.epsActual)}`];
      if (q.epsEstimate !== null) parts.push(`${isEs ? 'est.' : 'est.'} ${fmtEps(q.epsEstimate)}`);
      if (q.surprisePct !== null) parts.push(`${isEs ? 'sorpresa' : 'surprise'} ${fmtPct(q.surprisePct)}`);
      lines.push(parts.join(' | '));
    });
  }

  const revQuarters = revenue.filter(q => q.revenue !== null || q.earnings !== null);
  if (revQuarters.length > 0) {
    lines.push('');
    lines.push(isEs ? 'INGRESOS Y BENEFICIO POR TRIMESTRE:' : 'REVENUE AND EARNINGS PER QUARTER:');
    revQuarters.forEach(q => {
      const parts = [`  · ${q.quarter || '—'}`];
      if (q.revenue !== null) parts.push(`${isEs ? 'ingresos' : 'revenue'} ${fmtBig(q.revenue)}`);
      if (q.earnings !== null) parts.push(`${isEs ? 'beneficio' : 'earnings'} ${fmtBig(q.earnings)}`);
      lines.push(parts.join(' | '));
    });
  } else {
    lines.push('');
    lines.push(isEs ? 'INGRESOS: sin datos disponibles.' : 'REVENUE: no data available.');
  }

  const system = published
    ? (isEs ? SYSTEM_PUBLISHED_ES : SYSTEM_PUBLISHED_EN)
    : (isEs ? SYSTEM_UPCOMING_ES : SYSTEM_UPCOMING_EN);

  return { system, user: lines.join('\n'), published };
}
