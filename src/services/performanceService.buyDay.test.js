import { describe, it, expect } from 'vitest';
import { performanceService } from './performanceService.js';

/**
 * El sub-periodo del DÍA DE COMPRA en la cadena TTWROR.
 *
 * Caso real que motivó estos tests (auditoría 2026-07-31): 1 acción de CSU.TO
 * comprada en la apertura del 2026-02-26 a C$2465,01, cierre de ese día
 * C$2607,72. El gráfico mostraba +15,94% cuando la rentabilidad real desde el
 * precio pagado era +22,52%: el día de la compra aportaba 0,0000% porque
 * `assetsAtStart` está vacío y `startTotalValueBase` valía 0.
 *
 * Invariante que fijan estos tests: con UNA compra y sin flujos posteriores,
 * TTWROR == rentabilidad del precio pagado hasta hoy.
 */

const day = (d) => `2026-02-${String(d).padStart(2, '0')}`;
// Serie diaria sintética; el día 26 es el de la compra.
const priceSeries = (closes) => Object.entries(closes).map(([d, close]) => ({ time: d, close }));

const buy = (over = {}) => ({
  transaction_date: `${day(26)}T09:30:00`,
  transaction_type: 'BUY',
  quantity: 1,
  price: 100,
  isin: 'TEST0000001',
  positions: { assets: { ticker: 'TEST', currency: 'EUR', company_name: 'Test Co' } },
  ...over,
});

// resolveTicker: el ISIN no resuelve (como en producción), el producto/ticker sí.
const resolve = (t) => (t && t.startsWith('TEST0') ? null : t);

const run = (txs, prices, opts = {}) => performanceService.calculateDailyTWR(
  txs, prices, opts.fx || {}, opts.rates || {}, 'EUR', {}, resolve, opts.roiTxs || txs,
);

describe('TTWROR — sub-periodo del día de compra', () => {
  it('captura el movimiento entre el precio de ejecución y el cierre del día', () => {
    // Compra a 100, cierra a 105,79 (+5,79% ese día), luego sube a 120.
    const out = run([buy()], {
      TEST: priceSeries({ [day(26)]: 105.79, [day(27)]: 110, [day(28)]: 120 }),
    });
    const last = out[out.length - 1];
    // Rentabilidad real desde el precio pagado: 120/100 − 1 = +20%
    expect(last.ttwror).toBeCloseTo(20, 6);
    // Y el día de la compra ya no es un eslabón muerto
    expect(out[0].ttwror).toBeCloseTo(5.79, 6);
  });

  it('coincide con el ROI simple cuando hay una sola compra y nada más', () => {
    const out = run([buy({ price: 2465.01, eur_total: 2465.01 })], {
      TEST: priceSeries({ [day(26)]: 2607.72, [day(27)]: 2800, [day(28)]: 3020.02 }),
    });
    const last = out[out.length - 1];
    expect(last.ttwror).toBeCloseTo(last.simpleROI, 6);
    expect(last.ttwror).toBeCloseTo((3020.02 / 2465.01 - 1) * 100, 6);
  });

  it('incluye el efecto divisa del día de compra en la misma cadena', () => {
    // Activo en USD: precio +10% y divisa +10% → (1,1 × 1,1) − 1 = +21%
    const fx = { USD: priceSeries({ [day(26)]: 1.1, [day(27)]: 1.1 }) };
    const out = run(
      [buy({ price: 100, positions: { assets: { ticker: 'TEST', currency: 'USD', company_name: 'Test Co' } } })],
      { TEST: priceSeries({ [day(26)]: 110, [day(27)]: 110 }) },
      { fx, rates: { USD: 1 } },
    );
    // El coste del día usa el FX del día (1,1) igual que el valor → el día capta
    // solo el precio; la divisa entra en los días siguientes vía lastFX.
    expect(out[out.length - 1].ttwror).toBeCloseTo(10, 6);
  });

  it('NO cuenta las compras consolidadas: un snapshot no genera rentabilidad', () => {
    const out = run([buy({ isConsolidated: true, price: 80 })], {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 100 }),
    });
    // El precio pasa de 80 (declarado) a 100 (cierre) pero es un snapshot histórico:
    // la cadena debe quedarse en 0, no inventar un +25%.
    expect(out[0].ttwror).toBeCloseTo(0, 9);
    expect(out[out.length - 1].ttwror).toBeCloseTo(0, 9);
  });

  it('un snapshot consolidado no diluye el rendimiento de los activos ya en cartera', () => {
    // Día 26: compra real de A. Día 27: A sube 10% y entra un seed consolidado de B.
    const txs = [
      buy({ price: 100 }),
      {
        transaction_date: `${day(27)}T00:00:00`, transaction_type: 'BUY', isConsolidated: true,
        quantity: 100, price: 50, isin: 'TEST0000002',
        positions: { assets: { ticker: 'SEED', currency: 'EUR', company_name: 'Seed Co' } },
      },
    ];
    const out = run(txs, {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 110, [day(28)]: 110 }),
      SEED: priceSeries({ [day(27)]: 50, [day(28)]: 50 }),
    });
    // El día 27 A hace +10% y el seed no debe diluirlo hacia +0,2%.
    expect(out[1].ttwror).toBeCloseTo(10, 6);
  });

  it('no crea eslabón si la divisa de ejecución no es la de cotización', () => {
    // AMZN comprado en Xetra: se paga en EUR, Yahoo cotiza en USD. Comparar el
    // precio de ejecución con el cierre mediría el tipo de cambio, no el mercado.
    const out = run([buy({
      price: 100, transaction_currency: 'EUR',
      positions: { assets: { ticker: 'TEST', currency: 'USD', company_name: 'Test Co' } },
    })], { TEST: priceSeries({ [day(26)]: 115, [day(27)]: 115 }) }, { rates: { USD: 1 } });
    // 115/100 = +15% sería puro FX inventado: el día de compra no aporta nada.
    expect(out[0].ttwror).toBeCloseTo(0, 9);
  });

  it('descarta el eslabón cuando el precio de compra es absurdo (fila corrupta)', () => {
    // Precio de ejecución 10× el cierre y fuera del patrón de split conocido:
    // −93% en un día es dato malo, no mercado.
    const out = run([buy({ price: 1500 })], {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 100 }),
    });
    expect(out[0].ttwror).toBeCloseTo(0, 9);
  });

  it('una compra pre-split no dispara la cadena (qty y precio se reconcilian)', () => {
    // Compra a 1000 con la serie ya ajustada a 100 → split 10:1 detectado.
    const out = run([buy({ price: 1000 })], {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 100 }),
    });
    expect(out[0].ttwror).toBeCloseTo(0, 6);
    expect(out[out.length - 1].ttwror).toBeCloseTo(0, 6);
  });

  it('una venta no mueve la cadena: el TWR solo responde al precio', () => {
    const txs = [
      buy({ price: 100 }),
      {
        transaction_date: `${day(28)}T10:00:00`, transaction_type: 'SELL', quantity: 0.9,
        price: 110, isin: 'TEST0000001',
        positions: { assets: { ticker: 'TEST', currency: 'EUR', company_name: 'Test Co' } },
      },
    ];
    const out = run(txs, {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 110, [day(28)]: 110, [day(29)]: 110 }),
    });
    // Precio 100 → 110 = +10%, se venda o no el 90% por el camino.
    expect(out[out.length - 1].ttwror).toBeCloseTo(10, 6);
  });

  it('días sin compras conservan exactamente la fórmula anterior', () => {
    const out = run([buy({ price: 100 })], {
      TEST: priceSeries({ [day(26)]: 100, [day(27)]: 110, [day(28)]: 99 }),
    });
    // Día 27: +10% sobre el cierre anterior. Día 28: −10% sobre 110.
    expect(out[1].ttwror).toBeCloseTo(10, 6);
    expect(out[2].ttwror).toBeCloseTo(-1, 6);
  });
});
