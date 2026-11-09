import { describe, it, expect } from 'vitest';
import { isQuotableTicker, createTickerGuard } from './tickerGuard';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: k => m.delete(k),
  };
}

describe('isQuotableTicker', () => {
  it('acepta los simbolos reales que usa la app', () => {
    for (const t of ['AAPL', 'CSU.TO', 'ASML.AS', 'MC.PA', 'BRK-B', '^SP500TR',
                     'EURUSD=X', '0P00019OG5.F', 'IE00B4L5Y983.EUFUND', 'BTC-USD']) {
      expect(isQuotableTicker(t), t).toBe(true);
    }
  });

  it('rechaza la LIQUIDEZ (era el 404 de CASH_EUR/CASH_USD del Dashboard)', () => {
    expect(isQuotableTicker('CASH')).toBe(false);
    expect(isQuotableTicker('CASH_EUR')).toBe(false);
    expect(isQuotableTicker('CASH_USD')).toBe(false);
    expect(isQuotableTicker('cash_gbp')).toBe(false);
  });

  it('rechaza descripciones con acentos (el "Interés" de DeGiro)', () => {
    expect(isQuotableTicker('Interés')).toBe(false);
    expect(isQuotableTicker('Comisión')).toBe(false);
  });

  it('rechaza nombres de fondo sin resolver (llevan espacios)', () => {
    expect(isQuotableTicker('BGIF World Tech')).toBe(false);
  });

  it('rechaza lo vacio y lo que no es texto', () => {
    expect(isQuotableTicker('')).toBe(false);
    expect(isQuotableTicker('   ')).toBe(false);
    expect(isQuotableTicker(null)).toBe(false);
    expect(isQuotableTicker(undefined)).toBe(false);
    expect(isQuotableTicker(42)).toBe(false);
  });

  it('NO pone tope de longitud: rompería los símbolos de fondos', () => {
    expect(isQuotableTicker('IE00B4L5Y983.EUFUND')).toBe(true);
  });
});

describe('caché negativa', () => {
  it('recuerda un 404 y deja de preguntar por ese símbolo', () => {
    const g = createTickerGuard({ storage: fakeStorage() });
    expect(g.shouldSkip('NLFLATEXACNT')).toBe(false);   // la heurística no lo ve
    g.markUnquotable('NLFLATEXACNT');
    expect(g.shouldSkip('NLFLATEXACNT')).toBe(true);    // ya no se vuelve a pedir
  });

  it('la marca CADUCA: un símbolo no queda proscrito para siempre', () => {
    let t = 1_000_000;
    const g = createTickerGuard({ storage: fakeStorage(), ttl: 1000, now: () => t });
    g.markUnquotable('XYZ');
    expect(g.isKnownUnquotable('XYZ')).toBe(true);
    t += 1001;
    expect(g.isKnownUnquotable('XYZ')).toBe(false);
  });

  it('no afecta a los demas simbolos', () => {
    const g = createTickerGuard({ storage: fakeStorage() });
    g.markUnquotable('BASURA');
    expect(g.shouldSkip('AAPL')).toBe(false);
  });

  it('sobrevive a un storage corrupto sin lanzar', () => {
    const s = fakeStorage();
    s.setItem('wf_unquotable_v1', '{roto');
    const g = createTickerGuard({ storage: s });
    expect(g.isKnownUnquotable('AAPL')).toBe(false);
    expect(() => g.markUnquotable('AAPL')).not.toThrow();
  });

  it('sin storage (modo privado) degrada a solo heuristica', () => {
    const g = createTickerGuard({ storage: null });
    expect(g.shouldSkip('CASH_EUR')).toBe(true);
    g.markUnquotable('XYZ');
    expect(g.shouldSkip('XYZ')).toBe(false);   // no puede recordar, pero no rompe
  });

  it('clear() olvida todo', () => {
    const g = createTickerGuard({ storage: fakeStorage() });
    g.markUnquotable('XYZ');
    g.clear();
    expect(g.isKnownUnquotable('XYZ')).toBe(false);
  });
});
