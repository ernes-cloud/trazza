import { describe, it, expect, vi } from 'vitest';
import {
  isoDayOf, brokerFxFor, resolveRate, collectFxNeeds, preloadTaxRates, MAX_FX_LOOKBACK_DAYS,
} from './fxByDate';

describe('isoDayOf', () => {
  it('acepta los dos formatos del pipeline', () => {
    expect(isoDayOf('15-03-2025')).toBe('2025-03-15');
    expect(isoDayOf('2025-03-15T10:00:00')).toBe('2025-03-15');
    expect(isoDayOf('')).toBe('');
    expect(isoDayOf(undefined)).toBe('');
  });
});

describe('brokerFxFor', () => {
  it('solo vale para convertir la divisa de la propia operación a EUR', () => {
    const row = { moneda: 'USD', fxRate: 0.91 };
    expect(brokerFxFor(row, 'USD', 'EUR')).toBe(0.91);
    // fx_rate es transaction_currency → EUR: no sirve si la preferida no es EUR
    expect(brokerFxFor(row, 'USD', 'GBP')).toBeNull();
    // ni para otra divisa (comisión de compraventa facturada en EUR sobre una acción USD)
    expect(brokerFxFor(row, 'EUR', 'EUR')).toBeNull();
    expect(brokerFxFor({ moneda: 'USD', fx_rate: '0.9' }, 'USD', 'EUR')).toBe(0.9);
    expect(brokerFxFor({ moneda: 'USD', fxRate: 0 }, 'USD', 'EUR')).toBeNull();
    expect(brokerFxFor({ moneda: 'USD' }, 'USD', 'EUR')).toBeNull();
  });
});

describe('resolveRate', () => {
  const table = {
    USD: {
      '2024-06-07': { rate: 0.92, date: '2024-06-07' }, // viernes
      '2024-06-10': { rate: 0.95, date: '2024-06-10' }, // lunes
    },
  };

  it('misma divisa que la preferida → 1, fuente eur', () => {
    expect(resolveRate({ currency: 'EUR', date: '2024-06-09', table })).toEqual({
      rate: 1, source: 'eur', rateDate: '2024-06-09',
    });
  });

  it('el fx_rate del bróker gana a la tabla', () => {
    const r = resolveRate({ currency: 'USD', date: '2024-06-07', brokerFx: 0.9, table });
    expect(r).toEqual({ rate: 0.9, source: 'broker', rateDate: '2024-06-07' });
  });

  it('día con tipo en la tabla → ese', () => {
    expect(resolveRate({ currency: 'USD', date: '2024-06-07', table })).toEqual({
      rate: 0.92, source: 'historical', rateDate: '2024-06-07',
    });
  });

  it('fin de semana → día hábil ANTERIOR, nunca el lunes siguiente', () => {
    const r = resolveRate({ currency: 'USD', date: '2024-06-09', table }); // domingo
    expect(r.rate).toBe(0.92);
    expect(r.rateDate).toBe('2024-06-07');
  });

  it('una entrada de la tabla con fecha real posterior se rechaza', () => {
    const bad = { USD: { '2024-06-09': { rate: 0.95, date: '2024-06-10' } } };
    const r = resolveRate({ currency: 'USD', date: '2024-06-09', table: bad });
    expect(r.rate).toBeNull();
    expect(r.reason).toBe('no_rate');
  });

  it(`no mira más de ${MAX_FX_LOOKBACK_DAYS} días atrás`, () => {
    const old = { USD: { '2024-06-01': 0.9 } };
    expect(resolveRate({ currency: 'USD', date: '2024-06-08', table: old }).rate).toBe(0.9);
    expect(resolveRate({ currency: 'USD', date: '2024-06-09', table: old }).rate).toBeNull();
    // ni un tipo "cacheado" de hace semanas apuntado bajo la fecha pedida
    const stale = { USD: { '2024-06-09': { rate: 0.9, date: '2024-05-20' } } };
    expect(resolveRate({ currency: 'USD', date: '2024-06-09', table: stale }).rate).toBeNull();
  });

  it('sin tipo → null con motivo (y nunca un tipo de hoy)', () => {
    expect(resolveRate({ currency: 'JPY', date: '2024-06-07', table })).toEqual({ rate: null, reason: 'no_rate' });
    expect(resolveRate({ currency: 'USD', date: '', table })).toEqual({ rate: null, reason: 'no_date' });
  });
});

describe('collectFxNeeds', () => {
  it('pide venta, cada lote, dividendos y comisiones; salta EUR y lo que trae fx del bróker', () => {
    const needs = collectFxNeeds({
      sales: [{
        fecha: '15-03-2025', moneda: 'USD',
        lots: [
          { date: '10-01-2024', qty: 1, unitCost: 10, fxRate: null },
          { date: '11-01-2024', qty: 1, unitCost: 10, fxRate: 0.9 }, // del bróker: no se pide
        ],
      }, {
        fecha: '16-03-2025', moneda: 'EUR', lots: [{ date: '01-01-2024', qty: 1, unitCost: 1 }],
      }],
      dividends: [{ fecha: '10-06-2025', moneda: 'USD' }, { fecha: '10-06-2025', moneda: 'USD' }],
      commissions: [
        { fecha: '15-03-2025', moneda: 'USD', isTradeCommission: true }, // EUR → no
        { fecha: '01-02-2025', moneda: 'GBP', type: 'FEE' },
      ],
      preferredCurrency: 'EUR',
    });
    expect(needs).toEqual([
      { currency: 'GBP', date: '2025-02-01' },
      { currency: 'USD', date: '2024-01-10' },
      { currency: 'USD', date: '2025-03-15' },
      { currency: 'USD', date: '2025-06-10' },
    ]);
  });

  it('con preferida no EUR, las comisiones en EUR también necesitan tipo', () => {
    const needs = collectFxNeeds({
      commissions: [{ fecha: '15-03-2025', moneda: 'USD', isTradeCommission: true }],
      preferredCurrency: 'USD',
    });
    expect(needs).toEqual([{ currency: 'EUR', date: '2025-03-15' }]);
  });
});

describe('preloadTaxRates', () => {
  it('deduplica, limita la concurrencia y guarda la fecha real del tipo', async () => {
    let inFlight = 0;
    let peak = 0;
    const getRate = vi.fn(async (from, to, date) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      if (from === 'JPY') return null;
      if (date === '2024-06-09') return { rate: 0.92, date: '2024-06-07' };
      return 0.9;
    });
    const needs = [
      { currency: 'USD', date: '2024-06-09' },
      { currency: 'USD', date: '2024-06-09' },
      { currency: 'USD', date: '2024-06-03' },
      { currency: 'USD', date: '2024-06-04' },
      { currency: 'USD', date: '2024-06-05' },
      { currency: 'JPY', date: '2024-06-05' },
    ];
    const { table, errors } = await preloadTaxRates(needs, { getRate, preferredCurrency: 'EUR', concurrency: 2 });
    expect(getRate).toHaveBeenCalledTimes(5);
    expect(getRate).toHaveBeenCalledWith('USD', 'EUR', '2024-06-09');
    expect(peak).toBeLessThanOrEqual(2);
    expect(table.USD['2024-06-09']).toEqual({ rate: 0.92, date: '2024-06-07' });
    expect(table.USD['2024-06-03']).toEqual({ rate: 0.9, date: '2024-06-03' });
    expect(table.JPY).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('un getRate que lanza no tumba el resto: se anota en errors', async () => {
    const getRate = vi.fn(async (from) => {
      if (from === 'GBP') throw new Error('429');
      return 0.9;
    });
    const { table, errors } = await preloadTaxRates(
      [{ currency: 'GBP', date: '2024-06-03' }, { currency: 'USD', date: '2024-06-03' }],
      { getRate }
    );
    expect(table.USD['2024-06-03'].rate).toBe(0.9);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ currency: 'GBP', date: '2024-06-03' });
  });
});
