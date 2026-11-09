import { describe, it, expect } from 'vitest';
import {
  madridParts, isWeeklyReportWindow, madridWeekStartUtc,
  buildWeeklyReport, renderWeeklyReportEmail, positionGroupKey,
  SNAPSHOTS_LIVE_SINCE,
} from './weeklyReport.js';

// Los fixtures usan fechas de septiembre de 2026: los tests que no tratan del
// corte de fotos fiables lo desactivan. El corte tiene sus propios tests abajo.
const build = (snaps, opts = {}) => buildWeeklyReport(snaps, { liveSince: '2000-01-01', ...opts });

const snap = (date, total, extra = {}) => ({ snapshot_date: date, total_value_eur: total, cash_eur: 0, breakdown: [], ...extra });

describe('ventana de envío (Madrid)', () => {
  it('lunes a las 08:00 de Madrid sí; a las 07:59 no (horario de verano, UTC+2)', () => {
    expect(isWeeklyReportWindow(new Date('2026-10-05T06:00:00Z'))).toBe(true);   // 08:00 Madrid
    expect(isWeeklyReportWindow(new Date('2026-10-05T05:59:00Z'))).toBe(false);  // 07:59 Madrid
  });

  it('usa la hora de Madrid también en invierno (UTC+1)', () => {
    expect(isWeeklyReportWindow(new Date('2026-11-02T07:00:00Z'))).toBe(true);   // 08:00 Madrid
    expect(isWeeklyReportWindow(new Date('2026-11-02T06:30:00Z'))).toBe(false);  // 07:30 Madrid
  });

  it('domingo a las 23:30 UTC ya es lunes en Madrid, pero de madrugada: no toca', () => {
    const now = new Date('2026-10-04T23:30:00Z'); // lunes 01:30 Madrid
    expect(madridParts(now).weekday).toBe(1);
    expect(isWeeklyReportWindow(now)).toBe(false);
  });

  it('martes no', () => {
    expect(isWeeklyReportWindow(new Date('2026-10-06T10:00:00Z'))).toBe(false);
  });
});

describe('madridWeekStartUtc', () => {
  it('devuelve el lunes 00:00 de Madrid de esa semana', () => {
    // Jueves 8-oct-2026 → lunes 5-oct 00:00 Madrid = 4-oct 22:00 UTC
    expect(madridWeekStartUtc(new Date('2026-10-08T15:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });

  it('el domingo pertenece a la semana que empezó el lunes anterior', () => {
    expect(madridWeekStartUtc(new Date('2026-10-11T20:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });

  it('no se descuadra en la semana del cambio de hora (25-oct-2026)', () => {
    // Domingo 25-oct por la tarde: la semana empezó el lunes 19-oct, aún en verano (UTC+2)
    expect(madridWeekStartUtc(new Date('2026-10-25T18:00:00Z')).toISOString()).toBe('2026-10-18T22:00:00.000Z');
    // Lunes 26-oct ya en invierno (UTC+1)
    expect(madridWeekStartUtc(new Date('2026-10-26T09:00:00Z')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});

describe('buildWeeklyReport', () => {
  it('compara con la foto de hace exactamente 7 días', () => {
    const r = build([
      snap('2026-09-28', 10000), snap('2026-10-01', 10200), snap('2026-10-05', 10500),
    ]);
    expect(r).toMatchObject({ date: '2026-10-05', value: 10500, prevDate: '2026-09-28', change: 500, changePct: 5 });
  });

  it('si falta ese día usa la anterior, nunca una más cercana (no sería una semana)', () => {
    const r = build([snap('2026-09-25', 9000), snap('2026-09-30', 9500), snap('2026-10-05', 9900)]);
    expect(r.prevDate).toBe('2026-09-25');
    expect(r.change).toBe(900);
  });

  it('sin una semana de historial: informe sin variación', () => {
    const r = build([snap('2026-10-02', 5000), snap('2026-10-05', 5100)]);
    expect(r).toMatchObject({ value: 5100, prevDate: null, change: null, changePct: null });
  });

  it('acepta los NUMERIC de Postgres como texto y en cualquier orden', () => {
    const r = build([snap('2026-10-05', '1100.5'), snap('2026-09-28', '1000')]);
    expect(r).toMatchObject({ value: 1100.5, change: 100.5, changePct: 10.05 });
  });

  it('no genera informe para una cartera vacía o sin fotos', () => {
    expect(build([])).toBeNull();
    expect(build(null)).toBeNull();
    expect(build([snap('2026-10-05', 0)])).toBeNull();
  });

  it('lista TODAS las posiciones, ordenadas por valor, con su peso', () => {
    const breakdown = [
      { t: 'AAPL', v: 300 }, { t: 'MSFT', v: 200 }, { t: 'IWDA', v: 1000 },
      { t: 'NVDA', v: 100 }, { t: 'META', v: 50 }, { t: 'KO', v: 40 }, { t: 'X', v: 0 },
    ];
    const r = build([snap('2026-10-05', 2000, { breakdown, cash_eur: 310 })]);
    expect(r.positions.map((p) => p.name)).toEqual(['IWDA', 'AAPL', 'MSFT', 'NVDA', 'META', 'KO']); // la de valor 0 no
    expect(r.positions[0]).toMatchObject({ name: 'IWDA', value: 1000, weightPct: 50 });
    expect(r.cash).toBe(310);
  });

  it('enseña el nombre de la empresa en lugar del ISIN (caso real de DeGiro)', () => {
    const names = new Map([
      ['US5949181045 (USD)', 'Microsoft Corp'],
      ['CA21037X1006 (CAD)', 'CONSTELLATION SOFTWARE INC'],
    ]);
    const breakdown = [{ t: 'US5949181045 (USD)', v: 600 }, { t: 'CA21037X1006 (CAD)', v: 400 }];
    const r = build([snap('2026-10-05', 1000, { breakdown })], { names });
    expect(r.positions.map((p) => p.name)).toEqual(['Microsoft Corp', 'Constellation Software Inc']);
  });

  it('junta por ISIN la misma acción comprada en dos divisas y prefiere el nombre largo al símbolo', () => {
    const names = {
      'US0231351067 (USD)': 'Amazon.com Inc',
      'US0231351067 (EUR)': 'AMZN',
      'US02079K3059 (EUR)': 'GOOGL',
    };
    const breakdown = [
      { t: 'US0231351067 (USD)', v: 3000 }, { t: 'US0231351067 (EUR)', v: 800 },
      { t: 'US02079K3059 (EUR)', v: 1200 },
    ];
    const r = build([snap('2026-10-05', 5000, { breakdown })], { names });
    expect(r.positions).toMatchObject([
      { name: 'Amazon.com Inc', value: 3800, weightPct: 76 },
      { name: 'GOOGL', value: 1200, weightPct: 24 },   // solo hay símbolo: mejor que el ISIN
    ]);
  });

  it('sin nombre conocido cae al ISIN (o al ticker si no lo es)', () => {
    const breakdown = [{ t: 'IE00B4L5Y983 (EUR)', v: 700 }, { t: 'BTC-EUR', v: 300 }];
    const r = build([snap('2026-10-05', 1000, { breakdown })]);
    expect(r.positions.map((p) => p.name)).toEqual(['IE00B4L5Y983', 'BTC-EUR']);
  });
});

describe('positionGroupKey', () => {
  it.each([
    ['US0231351067 (USD)', 'US0231351067'],
    ['CA21037X1006 [TSE] (CAD)', 'CA21037X1006'],
    ['AAPL', 'AAPL'],
    ['BTC-EUR', 'BTC-EUR'],
  ])('%s → %s', (t, key) => expect(positionGroupKey(t)).toBe(key));
});

describe('renderWeeklyReportEmail', () => {
  const base = build([
    snap('2026-09-28', 10000),
    snap('2026-10-05', 9500, { breakdown: [{ t: '<script>', v: 9000 }], cash_eur: 500 }),
  ]);

  it('el asunto lleva el valor y el signo de la variación', () => {
    const { subject } = renderWeeklyReportEmail(base);
    expect(subject).toContain('9.500,00');   // con punto de miles
    expect(subject).toContain('−');
  });

  it('avisa de que la variación no es una rentabilidad', () => {
    const { text, html } = renderWeeklyReportEmail(base);
    expect(text).toMatch(/no la rentabilidad/);
    expect(html).toMatch(/no la rentabilidad/);
  });

  it('escapa los tickers en el HTML', () => {
    const { html } = renderWeeklyReportEmail(base);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sin historial no inventa variación', () => {
    const { subject, text } = renderWeeklyReportEmail(build([snap('2026-10-05', 1000)]));
    expect(subject).not.toMatch(/[+−]/);
    expect(text).toMatch(/Todavía no hay una semana/);
  });
});

describe('mercado frente a operaciones', () => {
  const prev = snap('2026-09-28', 10000, { breakdown: [{ t: 'A', v: 6000 }, { t: 'B', v: 4000 }] });

  it('sin operaciones ni movimientos de efectivo: toda la variación es de mercado', () => {
    const now = snap('2026-10-05', 10300, { breakdown: [{ t: 'A', v: 6300 }, { t: 'B', v: 4000 }] });
    const r = build([prev, now], { trades: new Map() });
    expect(r.noActivity).toBe(true);
    expect(r.market).toEqual({ change: 300, pct: 3, covers: 2 });
    const { subject, text } = renderWeeklyReportEmail(r);
    expect(text).toMatch(/toda la variación viene del mercado/);
    expect(text).not.toMatch(/no la rentabilidad/);
    expect(subject).toMatch(/\+3 % esta semana/);
  });

  it('una posición operada se marca y NO entra en el cálculo de mercado', () => {
    const now = snap('2026-10-05', 11500, { breakdown: [{ t: 'A', v: 6600 }, { t: 'B', v: 4900 }] });
    const r = build([prev, now], { trades: new Map([['B', new Set(['BUY'])]]) });
    expect(r.noActivity).toBe(false);
    expect(r.market).toEqual({ change: 600, pct: 10, covers: 1 });     // solo A
    expect(r.positions.find((p) => p.name === 'B')).toMatchObject({ tag: 'buy', weekPct: null });
    const { subject, text } = renderWeeklyReportEmail(r);
    // \s: Intl separa el "€" con un espacio irrompible (U+00A0)
    expect(text).toMatch(/Mercado: ▲ 600,00\s€ \(\+10 %\) en las posiciones en las que no operaste/);
    expect(text).toMatch(/B: 4\.900,00\s€ · 42,6 % · Compra/);
    expect(subject).toMatch(/Mercado \+10 %/);
  });

  it('la operación en una divisa marca al grupo entero (mismo ISIN)', () => {
    const p0 = snap('2026-09-28', 2000, { breakdown: [{ t: 'US0231351067 (USD)', v: 2000 }] });
    const p1 = snap('2026-10-05', 2600, { breakdown: [{ t: 'US0231351067 (USD)', v: 2100 }, { t: 'US0231351067 (EUR)', v: 500 }] });
    const r = build([p0, p1], { trades: new Map([['US0231351067 (EUR)', new Set(['BUY'])]]) });
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ tag: 'buy', weekPct: null });
    expect(r.market).toBeNull();
  });

  it('posición nueva sin operación registrada: "Nueva", fuera del mercado', () => {
    const now = snap('2026-10-05', 10800, { breakdown: [{ t: 'A', v: 6000 }, { t: 'B', v: 4000 }, { t: 'C', v: 800 }] });
    const r = build([prev, now], { trades: new Map() });
    expect(r.positions.find((p) => p.name === 'C').tag).toBe('new');
    expect(r.noActivity).toBe(false);
    expect(r.market.change).toBe(0);
  });

  it('lo vendido del todo aparece como "Ya no tienes"', () => {
    const now = snap('2026-10-05', 6100, { breakdown: [{ t: 'A', v: 6100 }] });
    const r = build([prev, now], { trades: new Map([['B', new Set(['SELL'])]]) });
    expect(r.closed).toEqual(['B']);
    expect(renderWeeklyReportEmail(r).text).toMatch(/Ya no tienes: B/);
  });

  it('un ingreso de efectivo impide decir que todo es mercado', () => {
    const now = snap('2026-10-05', 12000, { breakdown: [{ t: 'A', v: 6000 }, { t: 'B', v: 4000 }] });
    const r = build([prev, now], { trades: new Map(), cashMoved: true });
    expect(r.noActivity).toBe(false);
    expect(renderWeeklyReportEmail(r).text).toMatch(/movimientos de efectivo/);
  });

  it('si no se pudieron leer las operaciones, no separa nada y avisa como antes', () => {
    const now = snap('2026-10-05', 10300, { breakdown: [{ t: 'A', v: 6300 }, { t: 'B', v: 4000 }] });
    const r = build([prev, now], { trades: null });
    expect(r.market).toBeNull();
    expect(r.positions.every((p) => p.weekPct === null && p.tag === null)).toBe(true);
    expect(renderWeeklyReportEmail(r).text).toMatch(/no la rentabilidad/);
  });

  it('nombra lo que más subió y lo que más bajó', () => {
    const now = snap('2026-10-05', 10000, { breakdown: [{ t: 'A', v: 6600 }, { t: 'B', v: 3400 }] });
    const r = build([prev, now], { trades: new Map() });
    expect(r.best).toEqual({ name: 'A', pct: 10 });
    expect(r.worst).toEqual({ name: 'B', pct: -15 });
    expect(renderWeeklyReportEmail(r).text).toMatch(/Lo que más subió: A \(\+10 %\) · Lo que más bajó: B \(−15 %\)/);
  });
});

describe('la semana que viene', () => {
  const s = snap('2026-10-05', 1000, { breakdown: [{ t: 'US5949181045 (USD)', v: 1000 }] });
  const names = new Map([['US5949181045 (USD)', 'Microsoft Corp']]);

  it('solo los 7 días siguientes, ordenados, sin duplicar por divisa', () => {
    const events = [
      { date: '2026-10-09', kind: 'exdiv', t: 'US5949181045 (USD)', estimated: true },
      { date: '2026-10-07', kind: 'earnings', t: 'US5949181045 (USD)' },
      { date: '2026-10-07', kind: 'earnings', t: 'US5949181045 (EUR)' },   // mismo ISIN
      { date: '2026-10-05', kind: 'earnings', t: 'X' },                   // hoy: ya no es "que viene"
      { date: '2026-10-13', kind: 'earnings', t: 'Y' },                   // más de 7 días
    ];
    const r = build([s], { names, events });
    expect(r.upcoming).toEqual([
      { date: '2026-10-07', kind: 'earnings', estimated: false, name: 'Microsoft Corp' },
      { date: '2026-10-09', kind: 'exdiv', estimated: true, name: 'Microsoft Corp' },
    ]);
    const { text, html } = renderWeeklyReportEmail(r);
    expect(text).toMatch(/Microsoft Corp presenta resultados/);
    expect(text).toMatch(/fecha ex-dividendo \(estimada\)/);
    expect(html).toMatch(/antes de su fecha ex-dividendo/);
  });

  it('sin eventos lo dice; si no se pudo consultar, no pinta el bloque', () => {
    expect(renderWeeklyReportEmail(build([s], { events: [] })).text).toMatch(/Sin resultados ni dividendos previstos/);
    expect(renderWeeklyReportEmail(build([s], { events: null })).text).not.toMatch(/La semana que viene/);
  });
});

describe('formato', () => {
  it('punto de miles también en importes de 4 cifras', () => {
    const r = build([snap('2026-10-05', 9752.87, { breakdown: [{ t: 'A', v: 9752.87 }] })]);
    expect(renderWeeklyReportEmail(r).text).toMatch(/9\.752,87\s€/);
  });

  it('cabecera con el rango de la semana', () => {
    const r = build([snap('2026-09-25', 1000), snap('2026-10-02', 1100)]);
    expect(renderWeeklyReportEmail(r).text).toMatch(/^Semana del 25 sept? al 2 oct/);
  });
});

describe('operaciones en bruto (transactions)', () => {
  const p0 = snap('2026-09-28', 10000, { breakdown: [{ t: 'A', v: 6000 }, { t: 'B', v: 4000 }] });
  const p1 = snap('2026-10-05', 10500, { breakdown: [{ t: 'A', v: 6200 }, { t: 'B', v: 4300 }] });

  it('cuenta solo las operaciones posteriores a la foto anterior y hasta la actual', () => {
    const r = build([p0, p1], {
      transactions: [
        { t: 'B', type: 'BUY', date: '2026-09-28T10:00:00Z' },   // el día de la foto anterior: ya estaba dentro
        { t: 'A', type: 'SELL', date: '2026-10-06T09:00:00Z' },  // después de la foto actual
        { t: 'B', type: 'DIVIDEND', date: '2026-10-01T00:00:00Z' },
      ],
    });
    expect(r.noActivity).toBe(true);
    expect(r.market).toEqual({ change: 500, pct: 5, covers: 2 });
  });

  it('BUY dentro de la ventana marca la posición; TRANSFER marca efectivo', () => {
    const r = build([p0, p1], {
      transactions: [
        { t: 'B', type: 'BUY', date: '2026-10-02T15:00:00Z' },
        { t: 'CASH_EUR', type: 'TRANSFER', date: '2026-10-03T08:00:00Z' },
      ],
    });
    expect(r.positions.find((p) => p.name === 'B').tag).toBe('buy');
    expect(r.market).toEqual({ change: 200, pct: 3.33, covers: 1 });
    expect(r.noActivity).toBe(false);
  });
});

describe('fotos anteriores a SNAPSHOTS_LIVE_SINCE (valoradas con precios viejos)', () => {
  it(`por defecto no compara contra una foto anterior al ${SNAPSHOTS_LIVE_SINCE}`, () => {
    const r = buildWeeklyReport([snap('2026-09-16', 34000), snap('2026-09-23', 34500)]);
    expect(r).toMatchObject({ prevDate: null, change: null });
    expect(renderWeeklyReportEmail(r).text).toMatch(/Todavía no hay una semana/);
  });

  it('a partir de la fecha de corte compara con normalidad', () => {
    const r = buildWeeklyReport([snap(SNAPSHOTS_LIVE_SINCE, 1000), snap('2026-10-05', 1100)]);
    expect(r).toMatchObject({ prevDate: SNAPSHOTS_LIVE_SINCE, change: 100 });
  });
});

describe('renderWeeklyReportEmail — inglés', () => {
  const p0 = snap('2026-09-28', 10000, { breakdown: [{ t: 'A', v: 6000 }, { t: 'B', v: 4000 }] });
  const p1 = snap('2026-10-05', 10300, { breakdown: [{ t: 'A', v: 6300 }, { t: 'B', v: 4000 }] });
  const r = build([p0, p1], { trades: new Map(), events: [{ date: '2026-10-07', kind: 'exdiv', t: 'A', estimated: true }] });

  it('textos, asunto y formato numérico en inglés', () => {
    const { subject, text, html } = renderWeeklyReportEmail(r, { lang: 'en' });
    expect(subject).toBe('📊 Your portfolio +3% this week · €10,300.00');
    expect(text).toMatch(/^Week of 28 Sept? – 5 Oct/);
    expect(text).toMatch(/You made no trades this week/);
    expect(text).toMatch(/A: €6,300.00 · 61.2% · \+5%/);
    expect(text).toMatch(/A: ex-dividend date \(estimated\)/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Open my portfolio');
    expect(html).not.toMatch(/Tus posiciones|Liquidez/);
  });

  it('un idioma desconocido cae a español', () => {
    expect(renderWeeklyReportEmail(r, { lang: 'fr' }).subject).toMatch(/Tu cartera/);
    expect(renderWeeklyReportEmail(r).subject).toMatch(/Tu cartera/);
  });
});
