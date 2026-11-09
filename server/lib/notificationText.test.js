import { describe, it, expect } from 'vitest';
import {
  lastBuyDay, daysBetween, exDividendNotice, dividendPaidNotice, earningsUpcomingNotice,
  earningsResultNotice, priceTargetNotice, percentMoveNotice, portfolioMoveNotice, recurringEndNotice,
} from './notificationText.js';
import { formatMoney } from './money.js';

describe('lastBuyDay — último día hábil antes del ex-dividendo', () => {
  it('ex el lunes → el viernes anterior (antes avisaba en domingo)', () => {
    expect(lastBuyDay('2026-10-19')).toBe('2026-10-16'); // lunes → viernes
  });
  it('ex entre semana → la víspera', () => {
    expect(lastBuyDay('2026-10-21')).toBe('2026-10-20'); // miércoles → martes
  });
  it('fecha inválida → null', () => {
    expect(lastBuyDay('')).toBe(null);
  });
});

describe('daysBetween', () => {
  it('cuenta días de calendario, sin depender de la hora', () => {
    expect(daysBetween('2026-10-17', '2026-10-24')).toBe(7);
    expect(daysBetween('2026-10-17T23:59:00Z', '2026-10-18')).toBe(1);
  });
});

describe('exDividendNotice', () => {
  const base = { ticker: 'MSFT', exDate: '2026-10-19', amount: 0.83, currency: 'USD' };

  it('el viernes avisa del ex-dividendo del lunes', () => {
    const n = exDividendNotice({ ...base, today: '2026-10-16' });
    expect(n.type).toBe('warning');
    expect(n.message).toContain('último día para comprar');
    expect(n.message.startsWith(n.dedup)).toBe(true);
  });

  it('el domingo ya no avisa (la bolsa está cerrada)', () => {
    expect(exDividendNotice({ ...base, today: '2026-10-18' })).toBe(null);
  });

  it('a 7 días, aviso de dividendo próximo', () => {
    const n = exDividendNotice({ ...base, today: '2026-10-12' });
    expect(n.type).toBe('dividend');
    expect(n.message).toContain('en 7 días');
  });

  it('la nota de fecha estimada va al final, fuera del prefijo del dedupe', () => {
    const n = exDividendNotice({ ...base, estimated: true, today: '2026-10-16' });
    expect(n.dedup).not.toContain('estimada');
    expect(n.message.endsWith('no anunciada')).toBe(true);
  });

  it('en inglés para un usuario en inglés', () => {
    const n = exDividendNotice({ ...base, today: '2026-10-16', lang: 'en' });
    expect(n.title).toBe('⚠️ Last day for the dividend');
    expect(n.message).toContain('/share');
  });
});

describe('dividendPaidNotice', () => {
  it('solo en los 3 días siguientes al pago', () => {
    const p = { ticker: 'KO', paymentDate: '2026-10-15', amount: 0.5, currency: 'USD', quantity: 10 };
    expect(dividendPaidNotice({ ...p, today: '2026-10-17' }).message).toContain('total estimado $5,00');
    expect(dividendPaidNotice({ ...p, today: '2026-10-19' })).toBe(null);
    expect(dividendPaidNotice({ ...p, today: '2026-10-14' })).toBe(null);
  });
});

describe('earningsUpcomingNotice — tipo propio, no "dividendo"', () => {
  it('a 7 días va como earnings (el correo decía "Dividendos")', () => {
    const n = earningsUpcomingNotice({ ticker: 'META', date: '2026-10-28', today: '2026-10-21' });
    expect(n.type).toBe('earnings');
    expect(n.title).toBe('📅 Resultados próximos');
  });

  it('hoy y mañana comparten prefijo: no se avisa dos veces', () => {
    const tomorrow = earningsUpcomingNotice({ ticker: 'META', date: '2026-10-28', today: '2026-10-27' });
    const today = earningsUpcomingNotice({ ticker: 'META', date: '2026-10-28', today: '2026-10-28' });
    expect(tomorrow.dedup).toBe(today.dedup);
    expect(tomorrow.message).toContain('(mañana)');
    expect(today.message).toContain('(hoy)');
  });

  it('a 3 días no avisa', () => {
    expect(earningsUpcomingNotice({ ticker: 'META', date: '2026-10-28', today: '2026-10-25' })).toBe(null);
  });
});

describe('earningsResultNotice', () => {
  it('el prefijo no lleva el EPS (Nasdaq lo corrige)', () => {
    const a = earningsResultNotice({ ticker: 'AAPL', date: '2026-10-30', epsActual: 1.5, epsForecast: 1.4 });
    const b = earningsResultNotice({ ticker: 'AAPL', date: '2026-10-30', epsActual: 1.52, epsForecast: 1.4 });
    expect(a.dedup).toBe(b.dedup);
    expect(a.type).toBe('success');
  });
});

describe('alertas', () => {
  it('precio objetivo: el mensaje en español no cambia (dedupe de avisos ya enviados)', () => {
    expect(priceTargetNotice({ ticker: 'AAPL', target: 150, currency: 'USD', upside: true }).message)
      .toBe('AAPL alcanzó el objetivo de $150 (Sube)');
  });

  it('variación diaria: el patrón casa con el mensaje en ambos idiomas', () => {
    for (const lang of ['es', 'en']) {
      const n = percentMoveNotice({ ticker: 'ASML.AS', change: -5.72, target: 5, lang });
      const re = new RegExp(`^${n.dedup.replace(/[.*+?^${}()|[\]\\±]/g, '\\$&').replace(/%/g, '.*')}`);
      expect(re.test(n.message)).toBe(true);
    }
  });

  it('cartera: con nombre de broker en el título', () => {
    const n = portfolioMoveNotice({ brokerName: 'DEGIRO', pct: -2.1, threshold: 2 });
    expect(n.title).toBe('📊 Alerta de cartera · DEGIRO');
    expect(n.type).toBe('warning');
  });
});

describe('recurringEndNotice', () => {
  it('categoría traducida e importe en el formato del idioma', () => {
    const p = { label: 'Netflix', category: 'subscriptions', type: 'expense', amount: 12.99, endDate: '2026-11-01', daysLeft: 7 };
    expect(recurringEndNotice(p).message).toContain('Son 12,99 €/mes');
    const en = recurringEndNotice({ ...p, lang: 'en' });
    expect(en.message).toContain('(Subscriptions)');
    expect(en.message).toContain('€12.99/month');
  });
});

describe('formatMoney — idioma', () => {
  it('español por defecto, inglés con lang', () => {
    expect(formatMoney(1234.5, 'EUR')).toBe('1.234,50 €');
    expect(formatMoney(1234.5, 'EUR', { lang: 'en' })).toBe('€1,234.50');
  });
});
