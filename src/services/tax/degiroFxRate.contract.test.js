import { describe, it, expect } from 'vitest';
import { parseDegiroCSV } from '../../lib/parsers/degiroParser.js';
import { brokerFxFor, resolveRate } from './fxByDate.js';

// Contrato de `fx_rate` (revisión F1F2, punto 5 / BAJA): fxByDate lo lee como
// EUR POR UNIDAD de la divisa de la operación (COMMENT de la migración 20260610).
// El «Tipo de cambio» del Account.csv de DEGIRO va al revés: unidades de divisa
// por EUR (aquí 1,1512 USD/EUR). Hoy ningún parser rellena fxRate; si alguien lo
// cablea con el «Tipo» SIN invertir, el informe fiscal valoraría la compra de
// META en 1921 € en vez de 1450 €. Este test lo impide: todo fxRate que salga
// del parser tiene que reproducir el importe en EUR que el propio CSV apunta.

const HDR = 'Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden';
const ORDER = 'ab88ec05-bbd2-4b2a-b82f-8a34bff5d9ef';
const META = [
  HDR,
  `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Ingreso Cambio de Divisa,"1,1512",USD,"1669,47",USD,"0,00",${ORDER}`,
  `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Retirada Cambio de Divisa,,EUR,"-1450,18",EUR,"-907,86",${ORDER}`,
  `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"542,32",${ORDER}`,
  `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,"Compra 3 Meta Platforms Inc Class A@556,4886 USD (US30303M1027)",,USD,"-1669,47",USD,"-1669,47",${ORDER}`,
].join('\n');

/** Lo que el informe fiscal haría con el fx del bróker de la operación (importPlanner guarda t.fxRate en fx_rate). */
const eurValueWithBrokerFx = (t) => {
  const r = resolveRate({ currency: t.moneda, date: '2026-03-26', preferredCurrency: 'EUR', brokerFx: brokerFxFor(t, t.moneda, 'EUR'), table: {} });
  return r.rate == null ? null : t.cantidad * t.precio * r.rate;
};

describe('fx_rate del bróker: sentido EUR por unidad de divisa', () => {
  it('si el parser de DEGIRO da un fxRate, reproduce el importe en EUR del CSV (1450,18), nunca el «Tipo» sin invertir', () => {
    const trades = parseDegiroCSV(META).filter((t) => t.type === 'BUY' || t.type === 'SELL');
    expect(trades).toHaveLength(1);
    for (const t of trades) {
      const fx = t.fxRate ?? t.fx_rate;
      if (fx == null) continue; // hoy: sin fxRate, el informe usa la tabla histórica
      expect(fx).toBeLessThan(1); // USD → EUR con el euro por encima del dólar
      expect(eurValueWithBrokerFx(t)).toBeCloseTo(t.totalEUR, 0);
    }
  });

  it('el «Tipo» de DEGIRO hay que invertirlo: tal cual da 1921 €, invertido da 1450 €', () => {
    const tipoDegiro = 1.1512; // USD por EUR
    const buy = { moneda: 'USD', cantidad: 3, precio: 556.4886 };
    expect(eurValueWithBrokerFx({ ...buy, fxRate: tipoDegiro })).toBeCloseTo(1921.86, 1);
    expect(eurValueWithBrokerFx({ ...buy, fxRate: 1 / tipoDegiro })).toBeCloseTo(1450.18, 0);
  });
});
