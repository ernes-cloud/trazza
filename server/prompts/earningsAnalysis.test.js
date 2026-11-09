import { describe, it, expect } from 'vitest';
import { sanitizeEarningsPayload, buildEarningsPrompt, assessEpsPlausibility } from './earningsAnalysis.js';

// Control characters built programmatically so the source file stays printable-ASCII
const CTRL_NUL = String.fromCharCode(0);
const CTRL_ESC = String.fromCharCode(27);

const basePayload = {
  ticker: 'AAPL',
  name: 'Apple Inc.',
  lang: 'es',
  event: {
    date: '2026-07-30',
    epsActual: 1.52,
    epsForecast: 1.43,
    surprisePct: 6.29,
    time: 'time-after-hours',
    fiscalQuarter: 'Jun/2026',
  },
  history: [
    { date: '2026-03-31', epsActual: 1.61, epsEstimate: 1.55, surprisePct: 3.87 },
    { date: '2025-12-31', epsActual: 2.41, epsEstimate: 2.36, surprisePct: 2.12 },
  ],
  revenue: [{ quarter: '2Q2026', revenue: 94_000_000_000, earnings: 23_600_000_000 }],
  priceReaction: { changePct: 3.42, price: 214.9, currency: 'USD' },
};

describe('sanitizeEarningsPayload', () => {
  it('returns null when no ticker is provided', () => {
    expect(sanitizeEarningsPayload({ name: 'Apple' })).toBeNull();
    expect(sanitizeEarningsPayload(undefined)).toBeNull();
  });

  it('coerces non-numeric metrics to null instead of leaking them into the prompt', () => {
    const clean = sanitizeEarningsPayload({
      ticker: 'MSFT',
      event: { epsActual: 'N/A', epsForecast: NaN, surprisePct: null },
    });

    expect(clean.event.epsActual).toBeNull();
    expect(clean.event.epsForecast).toBeNull();
    expect(clean.event.surprisePct).toBeNull();
  });

  it('falls back to the ticker when no name is given and defaults lang to es', () => {
    const clean = sanitizeEarningsPayload({ ticker: 'MSFT' });
    expect(clean.name).toBe('MSFT');
    expect(clean.lang).toBe('es');
  });

  it('keeps en when explicitly requested', () => {
    expect(sanitizeEarningsPayload({ ticker: 'MSFT', lang: 'en' }).lang).toBe('en');
  });

  it('strips control characters and caps long strings coming from third-party APIs', () => {
    const clean = sanitizeEarningsPayload({
      ticker: 'X'.repeat(60),
      name: `Evil${CTRL_NUL}Corp${CTRL_ESC}Inc${'x'.repeat(200)}`,
    });

    expect(clean.ticker.length).toBeLessThanOrEqual(24);
    expect(clean.name.length).toBeLessThanOrEqual(80);
    expect(clean.name).not.toMatch(/[\u0000-\u001F\u007F]/);
  });

  it('caps history and revenue arrays', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ date: `q${i}`, epsActual: i }));
    const clean = sanitizeEarningsPayload({ ticker: 'AAPL', history: many, revenue: many });

    expect(clean.history.length).toBeLessThanOrEqual(8);
    expect(clean.revenue.length).toBeLessThanOrEqual(8);
  });

  it('tolerates non-array history/revenue', () => {
    const clean = sanitizeEarningsPayload({ ticker: 'AAPL', history: 'nope', revenue: null });
    expect(clean.history).toEqual([]);
    expect(clean.revenue).toEqual([]);
  });
});

describe('buildEarningsPrompt — published quarter', () => {
  const built = buildEarningsPrompt(sanitizeEarningsPayload(basePayload));

  it('flags the report as published', () => {
    expect(built.published).toBe(true);
    expect(built.user).toContain('RESULTADOS YA PUBLICADOS');
  });

  it('includes actual EPS, estimate and surprise', () => {
    expect(built.user).toContain('1.52');
    expect(built.user).toContain('1.43');
    expect(built.user).toContain('+6.3%');
  });

  it('includes the price reaction when available', () => {
    expect(built.user).toContain('+3.4%');
    expect(built.user).not.toContain('NO DISPONIBLE');
  });

  it('renders revenue in compact notation instead of raw 11-digit integers', () => {
    expect(built.user).toContain('94.00B');
    expect(built.user).not.toContain('94000000000');
  });

  it('lists the quarterly EPS history', () => {
    expect(built.user).toContain('2026-03-31');
    expect(built.user).toContain('2025-12-31');
  });

  it('forbids inventing data in the system prompt', () => {
    expect(built.system).toMatch(/PROHIBIDO inventar/);
  });
});

describe('buildEarningsPrompt — upcoming quarter', () => {
  const upcoming = sanitizeEarningsPayload({
    ...basePayload,
    event: { ...basePayload.event, epsActual: null, surprisePct: null },
    priceReaction: {},
  });
  const built = buildEarningsPrompt(upcoming);

  it('flags the report as not yet published', () => {
    expect(built.published).toBe(false);
    expect(built.user).toContain('PENDIENTE DE PUBLICAR');
  });

  it('instructs the model not to invent the outcome', () => {
    expect(built.system).toMatch(/Nunca hables de los resultados como si ya se conocieran/);
  });

  it('states explicitly that the price move is unavailable so the model cannot fabricate one', () => {
    expect(built.user).toContain('NO DISPONIBLE');
  });

  it('does not report an actual EPS', () => {
    expect(built.user).not.toContain('BPA real');
  });
});

describe('buildEarningsPrompt — language', () => {
  it('builds an English prompt when lang is en', () => {
    const built = buildEarningsPrompt(sanitizeEarningsPayload({ ...basePayload, lang: 'en' }));
    expect(built.system).toContain('Answer in English');
    expect(built.user).toContain('EARNINGS REPORT DATA');
    expect(built.user).toContain('Actual EPS');
  });

  it('marks missing revenue explicitly in both languages', () => {
    const es = buildEarningsPrompt(sanitizeEarningsPayload({ ...basePayload, revenue: [] }));
    const en = buildEarningsPrompt(sanitizeEarningsPayload({ ...basePayload, lang: 'en', revenue: [] }));
    expect(es.user).toContain('INGRESOS: sin datos disponibles.');
    expect(en.user).toContain('REVENUE: no data available.');
  });
});

describe('assessEpsPlausibility (guard de datos de calendario)', () => {
  const ev = (epsActual, surprisePct = null) => ({ epsActual, surprisePct });

  it('no marca nada cuando el trimestre no está publicado', () => {
    expect(assessEpsPlausibility(ev(null, 500), [])).toBeNull();
  });

  it('acepta una sorpresa trimestral normal', () => {
    expect(assessEpsPlausibility(ev(1.52, 6.29), [{ epsActual: 1.61 }, { epsActual: 2.41 }])).toBeNull();
  });

  it('marca la sorpresa desmesurada del caso GOOGL (+216%)', () => {
    const doubt = assessEpsPlausibility(ev(9.11, 216.3), []);
    expect(doubt).not.toBeNull();
    expect(doubt.reasonEs).toContain('216.3%');
  });

  it('marca también las sorpresas negativas desmesuradas', () => {
    expect(assessEpsPlausibility(ev(0.1, -150), [])).not.toBeNull();
  });

  it('marca un BPA muy por encima del máximo histórico aunque no haya sorpresa', () => {
    const doubt = assessEpsPlausibility(ev(9.11, null), [{ epsActual: 2.31 }, { epsActual: 1.89 }]);
    expect(doubt).not.toBeNull();
    expect(doubt.reasonEs).toContain('2.31');
  });

  it('ignora las filas upcoming al calcular el máximo histórico', () => {
    const history = [{ epsActual: null, epsEstimate: 9.0, upcoming: true }, { epsActual: 2.31 }];
    expect(assessEpsPlausibility(ev(9.11, null), history)).not.toBeNull();
  });

  it('no marca un crecimiento fuerte pero creíble', () => {
    expect(assessEpsPlausibility(ev(3.0, null), [{ epsActual: 2.31 }, { epsActual: 1.89 }])).toBeNull();
  });

  it('inyecta el aviso en el prompt y ordena no construir la tesis sobre la sorpresa', () => {
    const built = buildEarningsPrompt(sanitizeEarningsPayload({
      ...basePayload,
      event: { ...basePayload.event, epsActual: 9.11, epsForecast: 2.88, surprisePct: 216.3 },
    }));
    expect(built.user).toContain('AVISO DE CALIDAD DE DATOS');
    expect(built.user).toContain('POSIBLEMENTE ERRÓNEA');
  });

  it('no ensucia el prompt cuando el dato es creíble', () => {
    const built = buildEarningsPrompt(sanitizeEarningsPayload(basePayload));
    expect(built.user).not.toContain('AVISO DE CALIDAD DE DATOS');
  });
});
