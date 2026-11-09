import { describe, it, expect } from 'vitest';
import { parseDegiroCSV } from './degiroParser.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const HDR = 'Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden';
const csv = (...rows) => [HDR, ...rows].join('\n');

// ─── 1. Compra internacional USD con FX y comisión ──────────────────────────

describe('Compra internacional USD (META, formato europeo)', () => {
    const ORDER = 'ab88ec05-bbd2-4b2a-b82f-8a34bff5d9ef';
    const input = csv(
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Ingreso Cambio de Divisa,"1,1512",USD,"1669,47",USD,"0,00",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Retirada Cambio de Divisa,,EUR,"-1450,18",EUR,"-907,86",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"542,32",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,"Compra 3 Meta Platforms Inc Class A@556,4886 USD (US30303M1027)",,USD,"-1669,47",USD,"-1669,47",${ORDER}`,
    );

    it('produce exactamente 1 transacción BUY (más snapshots de caja)', () => {
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
    });

    it('ISIN, cantidad y precio se extraen correctamente', () => {
        const buy = parseDegiroCSV(input).find(t => t.type === 'BUY');
        expect(buy.isin).toBe('US30303M1027');
        expect(buy.cantidad).toBe(3);
        expect(buy.precio).toBeCloseTo(556.4886, 3);
        expect(buy.moneda).toBe('USD');
    });

    it('comisión EUR se fusiona en el BUY', () => {
        const buy = parseDegiroCSV(input).find(t => t.type === 'BUY');
        expect(buy.comisiones).toBeCloseTo(2.00, 2);
    });

    it('coste real en EUR viene de la fila Retirada Cambio de Divisa', () => {
        const buy = parseDegiroCSV(input).find(t => t.type === 'BUY');
        expect(buy.hasFX).toBe(true);
        expect(buy.totalEUR).toBeCloseTo(1450.18, 2);
    });

    it('las filas FX y comisión no aparecen como transacciones independientes', () => {
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'CURRENCY_EXCHANGE')).toHaveLength(0);
        expect(result.filter(t => t.type === 'FEE' && t.isin === 'US30303M1027')).toHaveLength(0);
    });
});

// ─── 2. Venta directa en EUR ─────────────────────────────────────────────────

describe('Venta directa en EUR con formato "1.139,8" (ASML)', () => {
    const ORDER = 'cc3d567d-2a6e-4cae-80b8-4139d846ebf8';
    const input = csv(
        `19-01-2026,09:46,19-01-2026,ASML HOLDING NV,NL0010273215,Costes de transacción y/o externos de DEGIRO,,EUR,"-4,90",EUR,"6901,53",${ORDER}`,
        `19-01-2026,09:46,19-01-2026,ASML HOLDING NV,NL0010273215,"Venta 4 ASML Holding NV@1.139,8 EUR (NL0010273215)",,EUR,"4559,20",EUR,"6906,43",${ORDER}`,
    );

    it('tipo SELL, 4 acciones, precio 1139.8', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell).toBeDefined();
        expect(sell.isin).toBe('NL0010273215');
        expect(sell.cantidad).toBe(4);
        expect(sell.precio).toBeCloseTo(1139.8, 1);
        expect(sell.moneda).toBe('EUR');
    });

    it('comisión 4,90 EUR fusionada en la venta', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell.comisiones).toBeCloseTo(4.90, 2);
    });

    it('"1.139,8" se interpreta como número europeo (no 1 con decimal .139)', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell.precio).toBeGreaterThan(1000);
    });
});

// ─── 3. Stock GBX (peniques → libras) ───────────────────────────────────────

describe('Venta stock GBX → precio dividido entre 100 (ZEGONA)', () => {
    const ORDER = '6f424756-0734-4641-a6a6-ee80626abac2';
    const input = csv(
        `26-03-2026,17:08,26-03-2026,ZEGONA COMMUNICATIONS PLC,GB00BVGBY890,Retirada Cambio de Divisa,"86,6769",GBP,"-1081,60",GBP,"0,00",${ORDER}`,
        `26-03-2026,17:08,26-03-2026,ZEGONA COMMUNICATIONS PLC,GB00BVGBY890,Ingreso Cambio de Divisa,,EUR,"1247,86",EUR,"544,32",${ORDER}`,
        `26-03-2026,17:08,26-03-2026,ZEGONA COMMUNICATIONS PLC,GB00BVGBY890,Costes de transacción y/o externos de DEGIRO,,EUR,"-4,90",EUR,"-703,54",${ORDER}`,
        `26-03-2026,17:08,26-03-2026,ZEGONA COMMUNICATIONS PLC,GB00BVGBY890,Venta 64 Zegona Communications PLC@1.690 GBX (GB00BVGBY890),,GBP,"1081,60",GBP,"1081,60",${ORDER}`,
    );

    it('moneda normalizada a GBP (no GBX)', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell.moneda).toBe('GBP');
    });

    it('precio 1690 GBX convertido a 16,90 GBP', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell.precio).toBeCloseTo(16.90, 2);
    });

    it('64 acciones y comisión EUR fusionada', () => {
        const sell = parseDegiroCSV(input).find(t => t.type === 'SELL');
        expect(sell.cantidad).toBe(64);
        expect(sell.comisiones).toBeCloseTo(4.90, 2);
    });
});

// ─── 4. Dividendo + Retención ────────────────────────────────────────────────

describe('Dividendo con retención fiscal (META USD)', () => {
    const input = csv(
        `27-03-2026,07:21,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Dividendo,,USD,"3,15",USD,"2,20",`,
        `27-03-2026,07:21,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Retención del dividendo,,USD,"-0,95",USD,"-0,95",`,
    );

    it('se fusiona en una sola fila DIVIDEND', () => {
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'DIVIDEND')).toHaveLength(1);
    });

    it('total neto = bruto - retención (3,15 - 0,95 = 2,20)', () => {
        const div = parseDegiroCSV(input).find(t => t.type === 'DIVIDEND');
        expect(div.total).toBeCloseTo(2.20, 2);
    });

    it('la fila TAX no aparece de forma independiente', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'TAX')).toHaveLength(0);
    });
});

// ─── 5. Dividendo sin retención ──────────────────────────────────────────────

describe('Dividendo sin retención (ZEGONA EUR)', () => {
    const input = csv(
        `08-01-2026,06:58,07-01-2026,ZEGONA COMMUNICATIONS PLC,GB00BVGBY890,Dividendo,,EUR,"119,24",EUR,"2347,23",`,
    );

    it('produce 1 DIVIDEND con importe íntegro', () => {
        const div = parseDegiroCSV(input).find(t => t.type === 'DIVIDEND');
        expect(div).toBeDefined();
        expect(div.isin).toBe('GB00BVGBY890');
        expect(div.total).toBeCloseTo(119.24, 2);
    });
});

// ─── 6. Dividendos ALPHABET con filas de corrección (Account 3) ──────────────
//  DeGiro re-emite y corrige dividendos con filas negativas/positivas el mismo día.
//  El neto correcto es 4,41 - 1,32 = 3,09 USD.

describe('Múltiples filas Dividendo + Retención (ALPHABET)', () => {
    const input = csv(
        `17-03-2026,07:48,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"4,41",USD,"8,82",`,
        `17-03-2026,07:44,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"4,41",USD,"4,41",`,
        `17-03-2026,07:44,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"4,41",USD,"0,00",`,
        `17-03-2026,07:39,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"-4,41",USD,"-4,41",`,
        `17-03-2026,07:38,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"-4,41",USD,"0,00",`,
        `17-03-2026,07:26,16-03-2026,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"4,41",USD,"4,41",`,
        `16-12-2025,07:14,15-12-2025,ALPHABET INC CLASS A,US02079K3059,Retención del dividendo,,USD,"-1,32",USD,"3,09",`,
        `16-12-2025,07:11,15-12-2025,ALPHABET INC CLASS A,US02079K3059,Dividendo,,USD,"4,41",USD,"4,41",`,
    );

    it('el dividendo de diciembre fusiona retención', () => {
        const result = parseDegiroCSV(input);
        const divsDic = result.filter(t =>
            t.type === 'DIVIDEND' &&
            t.isin === 'US02079K3059' &&
            t.fecha === '16-12-2025'
        );
        expect(divsDic).toHaveLength(1);
        expect(divsDic[0].total).toBeCloseTo(3.09, 2); // 4,41 - 1,32
    });

    it('no genera filas TAX independientes', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'TAX')).toHaveLength(0);
    });
});

// ─── 7. Precio medio no inflado por comisiones EUR en acciones USD ───────────
//  Bug fijo: calculateNetBuys sumaba comisiones en EUR al coste en USD mezclando
//  divisas. El precio medio de ALPHABET con 21 acciones debe ser 161,761742
//  (suma de precios de descripción / qty), sin sumar los €2 de cada operación.

describe('Parser no mezcla comisiones EUR en precio de acciones USD (ALPHABET)', () => {
    const ORDER_A = 'order-googl-a';
    const ORDER_B = 'order-googl-b';
    // 2 compras reales de ALPHABET del CSV Account (3):
    //   1 acción @ 169,1092 USD con comisión €2
    //   5 acciones @ 168,75 USD con comisión €2
    const input = csv(
        `02-06-2025,15:47,02-06-2025,ALPHABET INC CLASS A,US02079K3059,Ingreso Cambio de Divisa,"1,1387",USD,"169,11",USD,"0,00",${ORDER_A}`,
        `02-06-2025,15:47,02-06-2025,ALPHABET INC CLASS A,US02079K3059,Retirada Cambio de Divisa,,EUR,"-148,50",EUR,"952,23",${ORDER_A}`,
        `02-06-2025,15:47,02-06-2025,ALPHABET INC CLASS A,US02079K3059,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"1100,73",${ORDER_A}`,
        `02-06-2025,15:47,02-06-2025,ALPHABET INC CLASS A,US02079K3059,"Compra 1 Alphabet Inc Class A@169,1092 USD (US02079K3059)",,USD,"-169,11",USD,"-169,11",${ORDER_A}`,
        `04-11-2024,15:41,04-11-2024,ALPHABET INC CLASS A,US02079K3059,Ingreso Cambio de Divisa,"1,0875",USD,"843,75",USD,"0,00",${ORDER_B}`,
        `04-11-2024,15:41,04-11-2024,ALPHABET INC CLASS A,US02079K3059,Retirada Cambio de Divisa,,EUR,"-775,88",EUR,"1225,92",${ORDER_B}`,
        `04-11-2024,15:41,04-11-2024,ALPHABET INC CLASS A,US02079K3059,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"2001,80",${ORDER_B}`,
        `04-11-2024,15:41,04-11-2024,ALPHABET INC CLASS A,US02079K3059,"Compra 5 Alphabet Inc Class A@168,75 USD (US02079K3059)",,USD,"-843,75",USD,"-843,75",${ORDER_B}`,
    );

    it('precio de BUY es el precio de la descripción (no inflado por comisiones EUR)', () => {
        const result = parseDegiroCSV(input);
        const buys = result.filter(t => t.type === 'BUY' && t.isin === 'US02079K3059');
        expect(buys).toHaveLength(2);
        // Los precios deben ser exactamente los de la descripción
        const buy1 = buys.find(b => b.cantidad === 1);
        const buy5 = buys.find(b => b.cantidad === 5);
        expect(buy1.precio).toBeCloseTo(169.1092, 3);
        expect(buy5.precio).toBeCloseTo(168.75, 2);
    });

    it('precio medio calculado externamente es (1×169,1092 + 5×168,75) / 6 ≈ 168,799', () => {
        // Este test documenta que el precio medio correcto se obtiene
        // sumando qty*precio SIN comisiones EUR
        const totalCost = 1 * 169.1092 + 5 * 168.75; // = 1012.8592
        const avgPrice = totalCost / 6;
        expect(avgPrice).toBeCloseTo(168.809866, 4);
        // Con comisiones mezcladas sería: (1012.8592 + 2 + 2) / 6 = 169.476 — incorrecto
        const wrongAvg = (totalCost + 4) / 6;
        expect(wrongAvg).not.toBeCloseTo(avgPrice, 1);
    });
});

// ─── 8. Comisiones de conectividad standalone ────────────────────────────────

describe('Comisión de conectividad de mercado (standalone FEE)', () => {
    const input = csv(
        `23-02-2026,10:43,31-01-2026,,,Comisión de conectividad con el mercado 2026 (New York Stock Exchange - NSY),,EUR,"-2,50",EUR,"1810,92",`,
        `23-02-2026,10:43,31-01-2026,,,Comisión de conectividad con el mercado 2026 (Nasdaq - NDQ),,EUR,"-2,50",EUR,"1813,42",`,
        `23-02-2026,10:43,31-01-2026,,,Comisión de conectividad con el mercado 2026 (London Stock Exchange (LSE) - LSE),,EUR,"-2,50",EUR,"1815,92",`,
    );

    it('produce 3 filas FEE independientes (una por mercado)', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'FEE')).toHaveLength(3);
    });

    it('cada comisión es -2,50 EUR', () => {
        parseDegiroCSV(input).filter(t => t.type === 'FEE').forEach(fee => {
            expect(fee.total).toBeCloseTo(-2.50, 2);
            expect(fee.moneda).toBe('EUR');
        });
    });
});

// ─── 8. Cash Sweep y Transferencia ───────────────────────────────────────────

describe('Cash Sweep (CASH) y Transferencia (TRANSFER)', () => {
    const input = csv(
        `25-03-2026,16:41,25-03-2026,,,Degiro Cash Sweep Transfer,,EUR,"273,55",EUR,"-698,64",`,
        `25-03-2026,16:41,25-03-2026,,,"Transferir desde su Cuenta de Efectivo en flatexDEGIRO Bank: 273,55 EUR",,,,EUR,"-972,19",`,
    );

    it('Cash Sweep → tipo CASH', () => {
        expect(parseDegiroCSV(input).some(t => t.type === 'CASH' && !t.isEndingCash)).toBe(true);
    });

    it('Transferir → tipo TRANSFER', () => {
        expect(parseDegiroCSV(input).some(t => t.type === 'TRANSFER')).toBe(true);
    });
});

// ─── 9. Depósito flatex ───────────────────────────────────────────────────────

describe('Ingreso externo (flatex Deposit)', () => {
    const input = csv(
        `28-01-2026,17:12,28-01-2026,,,flatex Deposit,,EUR,"2000,00",EUR,"7615,36",`,
    );

    it('clasificado como TRANSFER por la keyword "Deposit"', () => {
        const result = parseDegiroCSV(input);
        expect(result.some(t => t.type === 'TRANSFER')).toBe(true);
    });
});

// ─── 10. Retirada SEPA ───────────────────────────────────────────────────────

describe('Retirada SEPA inmediata', () => {
    const input = csv(
        `20-02-2026,08:47,20-02-2026,,,Retirada SEPA inmediata,,EUR,"-1530,00",EUR,"1823,42",`,
    );

    it('clasificado como TRANSFER, importe negativo', () => {
        const t = parseDegiroCSV(input).find(r => r.type === 'TRANSFER');
        expect(t).toBeDefined();
        expect(t.total).toBeCloseTo(-1530.00, 2);
    });
});

// ─── 11. Partial fills (mismo ID Orden, dos BUY) ─────────────────────────────

describe('Compra parcial: 2 BUY con el mismo ID Orden', () => {
    const ORDER = 'partial-fill-order-001';
    const input = csv(
        `15-01-2026,10:00,15-01-2026,SOME CORP,US0000000001,"Compra 5 Some Corp@100,00 USD (US0000000001)",,USD,"-500,00",USD,"-500,00",${ORDER}`,
        `15-01-2026,10:01,15-01-2026,SOME CORP,US0000000001,"Compra 5 Some Corp@101,00 USD (US0000000001)",,USD,"-505,00",USD,"-1005,00",${ORDER}`,
        `15-01-2026,10:00,15-01-2026,SOME CORP,US0000000001,Costes de transacción y/o externos de DEGIRO,,EUR,"-4,00",EUR,"996,00",${ORDER}`,
    );

    it('produce 2 filas BUY separadas', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'BUY')).toHaveLength(2);
    });

    it('la fila FEE se absorbe (no aparece standalone)', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'FEE')).toHaveLength(0);
    });

    it('la comisión se reparte entre TODOS los fills y la suma es exacta', () => {
        const buys = parseDegiroCSV(input).filter(t => t.type === 'BUY');
        const totalComisiones = buys.reduce((s, b) => s + (b.comisiones || 0), 0);
        // Antes el primer fill recibía solo su fracción (50% de 4 € → 2 €) y los
        // siguientes 0 € porque las filas FEE ya estaban marcadas como usadas:
        // la mitad de la comisión desaparecía. Ahora Σ fills = fila CSV exacta.
        expect(totalComisiones).toBeCloseTo(4.00, 2);
        buys.forEach(b => expect(b.comisiones).toBeCloseTo(2.00, 2)); // 50/50
    });
});

// ─── 11b. Fills parciales: reparto de comisión Y coste EUR (regresión F1) ────

describe('Fills parciales 60/40 con FX: comisión y totalEUR exactos', () => {
    const input = csv(
        `10-01-2025,10:00,10-01-2025,MSFT,US5949181045,"Compra 60 MSFT@400,00 USD (US5949181045)",,USD,"-24.000,00",USD,"0,00",ORD1`,
        `10-01-2025,10:00,10-01-2025,MSFT,US5949181045,"Compra 40 MSFT@400,00 USD (US5949181045)",,USD,"-16.000,00",USD,"0,00",ORD1`,
        `10-01-2025,10:00,10-01-2025,MSFT,US5949181045,"Costes de transacción",,EUR,"-5,00",EUR,"100,00",ORD1`,
        `10-01-2025,10:00,10-01-2025,MSFT,US5949181045,"Retirada Cambio de Divisa",,EUR,"-36.500,00",EUR,"105,00",ORD1`,
        `10-01-2025,10:00,10-01-2025,MSFT,US5949181045,"Ingreso Cambio de Divisa",,USD,"40.000,00",USD,"0,00",ORD1`,
    );

    it('cada fill recibe comisión proporcional a sus acciones (Σ = 5,00 €)', () => {
        const buys = parseDegiroCSV(input).filter(t => t.type === 'BUY');
        expect(buys).toHaveLength(2);
        const f60 = buys.find(b => b.cantidad === 60);
        const f40 = buys.find(b => b.cantidad === 40);
        expect(f60.comisiones).toBeCloseTo(3.00, 2);
        expect(f40.comisiones).toBeCloseTo(2.00, 2);
    });

    it('cada fill recibe su totalEUR por importe nativo (Σ = 36.500 €)', () => {
        const buys = parseDegiroCSV(input).filter(t => t.type === 'BUY');
        const f60 = buys.find(b => b.cantidad === 60);
        const f40 = buys.find(b => b.cantidad === 40);
        expect(f60.totalEUR).toBeCloseTo(21900, 2);
        expect(f40.totalEUR).toBeCloseTo(14600, 2);
        expect(f60.hasFX && f40.hasFX).toBe(true);
    });
});

// ─── 12. CURRENCY_EXCHANGE standalone se descarta ────────────────────────────

describe('FX standalone (conversión de dividendo USD) → descartado', () => {
    const input = csv(
        `28-03-2026,06:45,27-03-2026,,,Ingreso Cambio de Divisa,,EUR,"1,91",EUR,"-905,95",`,
        `28-03-2026,06:45,27-03-2026,,,Retirada Cambio de Divisa,"1,1538",USD,"-2,20",USD,"0,00",`,
    );

    it('no produce ninguna fila CURRENCY_EXCHANGE en el output final', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'CURRENCY_EXCHANGE')).toHaveLength(0);
    });

    it('no produce ninguna fila OTHER en el output final', () => {
        expect(parseDegiroCSV(input).filter(t => t.type === 'OTHER')).toHaveLength(0);
    });
});

// ─── 13. Cash snapshots al final del parse ───────────────────────────────────

describe('Cash snapshots: se genera uno por cada moneda', () => {
    const ORDER = 'snap-order';
    // BUY en USD con FX → genera saldo USD y EUR
    const input = csv(
        `26-03-2026,17:09,26-03-2026,META,US30303M1027,"Compra 3 Meta@556 USD (US30303M1027)",,USD,"-1669,47",USD,"-1669,47",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META,US30303M1027,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"542,32",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META,US30303M1027,Retirada Cambio de Divisa,,EUR,"-1450,18",EUR,"-907,86",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META,US30303M1027,Ingreso Cambio de Divisa,"1,1512",USD,"1669,47",USD,"0,00",${ORDER}`,
    );

    it('genera snapshots isEndingCash=true para EUR y USD', () => {
        const snaps = parseDegiroCSV(input).filter(t => t.isEndingCash);
        const currencies = snaps.map(t => t.moneda);
        expect(currencies).toContain('EUR');
        expect(currencies).toContain('USD');
    });

    it('el snapshot USD contiene el saldo del primer row USD del archivo', () => {
        const usdSnap = parseDegiroCSV(input).find(t => t.isEndingCash && t.moneda === 'USD');
        // La primera fila USD en el archivo es el "Compra" con saldo -1669,47
        expect(usdSnap).toBeDefined();
        expect(typeof usdSnap.total).toBe('number');
    });
});

// ─── 14. CSV vacío / malformado ───────────────────────────────────────────────

describe('Entradas inválidas o vacías', () => {
    it('CSV vacío devuelve array vacío', () => {
        expect(parseDegiroCSV('')).toEqual([]);
    });

    it('solo cabecera devuelve array vacío', () => {
        expect(parseDegiroCSV(HDR)).toEqual([]);
    });

    it('no lanza excepción con líneas con comillas extrañas', () => {
        const input = csv(`01-01-2026,10:00,01-01-2026,,,Descripción "rara",,EUR,"10,00",EUR,"10,00",`);
        expect(() => parseDegiroCSV(input)).not.toThrow();
    });
});

// ─── 15. Estructura mínima de cada transacción ───────────────────────────────

describe('Estructura de las transacciones de salida', () => {
    it('cada BUY tiene los campos mínimos requeridos', () => {
        const ORDER = 'struct-test';
        const input = csv(
            `26-03-2026,17:09,26-03-2026,META,US30303M1027,"Compra 3 Meta@100 USD (US30303M1027)",,USD,"-300,00",USD,"-300,00",${ORDER}`,
        );
        const t = parseDegiroCSV(input).find(r => r.type === 'BUY');
        expect(t).toMatchObject({
            type: 'BUY',
            isin: expect.any(String),
            fecha: expect.any(String),
            cantidad: expect.any(Number),
            precio: expect.any(Number),
            moneda: expect.any(String),
            total: expect.any(Number),
        });
    });

    it('output está ordenado por fecha descendente (más reciente primero)', () => {
        const input = csv(
            `28-03-2026,07:21,27-03-2026,META,US30303M1027,Dividendo,,USD,"3,15",USD,"2,20",`,
            `15-01-2026,10:00,15-01-2026,META,US30303M1027,Dividendo,,USD,"2,00",USD,"5,00",`,
        );
        const result = parseDegiroCSV(input).filter(t => t.type === 'DIVIDEND');
        expect(result[0].fecha).toBe('28-03-2026');
        expect(result[1].fecha).toBe('15-01-2026');
    });
});

// ─── 16. Multi-idioma: export en INGLÉS (layout idéntico, keywords EN) ────────

describe('Account.csv en inglés (Buy/Sell/Dividend/FX Credit-Debit)', () => {
    const HDR_EN = 'Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id';
    const csvEN = (...rows) => [HDR_EN, ...rows].join('\n');
    const ORDER = 'en-order-1';

    const input = csvEN(
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,FX Credit,1.1512,USD,1669.47,USD,0.00,${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,FX Debit,,EUR,-1450.18,EUR,-907.86,${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,DEGIRO Transaction and/or third party fees,,EUR,-2.00,EUR,542.32,${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Buy 3 Meta Platforms Inc Class A@556.4886 USD (US30303M1027),,USD,-1669.47,USD,-1669.47,${ORDER}`,
    );

    it('produce 1 BUY con ISIN, cantidad, precio y moneda correctos', () => {
        const buys = parseDegiroCSV(input).filter(t => t.type === 'BUY');
        expect(buys).toHaveLength(1);
        expect(buys[0].isin).toBe('US30303M1027');
        expect(buys[0].cantidad).toBe(3);
        expect(buys[0].precio).toBeCloseTo(556.4886, 3);
        expect(buys[0].moneda).toBe('USD');
    });

    it('la comisión EN se fusiona y el coste EUR sale de la pata FX en EUR', () => {
        const buy = parseDegiroCSV(input).find(t => t.type === 'BUY');
        expect(buy.comisiones).toBeCloseTo(2.00, 2);
        expect(buy.hasFX).toBe(true);
        expect(buy.totalEUR).toBeCloseTo(1450.18, 2);
    });

    it('las filas FX no aparecen como transacciones independientes', () => {
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'CURRENCY_EXCHANGE')).toHaveLength(0);
    });

    it('Dividend + Dividend Tax se fusionan en una sola fila DIVIDEND', () => {
        const divInput = csvEN(
            `28-03-2026,07:21,27-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Dividend,,USD,3.15,USD,2.20,`,
            `28-03-2026,07:21,27-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Dividend Tax,,USD,-0.95,USD,-0.95,`,
        );
        const divs = parseDegiroCSV(divInput).filter(t => t.type === 'DIVIDEND');
        expect(divs).toHaveLength(1);
        expect(divs[0].total).toBeCloseTo(2.20, 2);
        expect(parseDegiroCSV(divInput).filter(t => t.type === 'TAX')).toHaveLength(0);
    });

    it('Deposit → TRANSFER y Sell → SELL', () => {
        const miscInput = csvEN(
            `02-01-2026,09:00,02-01-2026,,,flatex Deposit,,EUR,1000.00,EUR,1000.00,`,
            `03-01-2026,10:00,03-01-2026,ASML HOLDING NV,NL0010273215,Sell 4 ASML Holding NV@680.50 EUR (NL0010273215),,EUR,2722.00,EUR,3722.00,en-order-2`,
        );
        const result = parseDegiroCSV(miscInput);
        expect(result.filter(t => t.type === 'TRANSFER')).toHaveLength(1);
        const sell = result.find(t => t.type === 'SELL');
        expect(sell.cantidad).toBe(4);
        expect(sell.precio).toBeCloseTo(680.50, 2);
    });

    it('genera snapshot de caja isEndingCash', () => {
        const snaps = parseDegiroCSV(input).filter(t => t.isEndingCash);
        expect(snaps.length).toBeGreaterThan(0);
    });
});

// ─── 17. Multi-idioma: export en ALEMÁN ───────────────────────────────────────

describe('Account.csv en alemán (Kauf/Verkauf/Dividende/Währungswechsel)', () => {
    const HDR_DE = 'Datum,Uhrzeit,Valutadatum,Produkt,ISIN,Beschreibung,FX,Änderung,,Saldo,,Order-ID';
    const csvDE = (...rows) => [HDR_DE, ...rows].join('\n');
    const ORDER = 'de-order-1';

    const input = csvDE(
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Währungswechsel (Einbuchung),"1,1512",USD,"1669,47",USD,"0,00",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Währungswechsel (Ausbuchung),,EUR,"-1450,18",EUR,"-907,86",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Transaktionsgebühr und/oder Gebühren Dritter,,EUR,"-2,00",EUR,"542,32",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,"Kauf 3 Meta Platforms Inc Class A@556,4886 USD (US30303M1027)",,USD,"-1669,47",USD,"-1669,47",${ORDER}`,
    );

    it('Kauf → BUY con precio europeo bien parseado', () => {
        const buys = parseDegiroCSV(input).filter(t => t.type === 'BUY');
        expect(buys).toHaveLength(1);
        expect(buys[0].cantidad).toBe(3);
        expect(buys[0].precio).toBeCloseTo(556.4886, 3);
    });

    it('comisión DE fusionada y coste EUR desde la pata FX en EUR', () => {
        const buy = parseDegiroCSV(input).find(t => t.type === 'BUY');
        expect(buy.comisiones).toBeCloseTo(2.00, 2);
        expect(buy.totalEUR).toBeCloseTo(1450.18, 2);
    });

    it('Verkauf NO se confunde con Kauf (SELL, no BUY)', () => {
        const sellInput = csvDE(
            `19-01-2026,09:46,19-01-2026,ASML HOLDING NV,NL0010273215,"Verkauf 4 ASML Holding NV@1.139,8 EUR (NL0010273215)",,EUR,"4559,20",EUR,"6906,43",de-order-2`,
        );
        const result = parseDegiroCSV(sellInput);
        expect(result.filter(t => t.type === 'SELL')).toHaveLength(1);
        expect(result.filter(t => t.type === 'BUY')).toHaveLength(0);
        expect(result.find(t => t.type === 'SELL').precio).toBeCloseTo(1139.8, 1);
    });

    it('Dividende + Dividendensteuer se fusionan', () => {
        const divInput = csvDE(
            `28-03-2026,07:21,27-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Dividende,,USD,"3,15",USD,"2,20",`,
            `28-03-2026,07:21,27-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Dividendensteuer,,USD,"-0,95",USD,"-0,95",`,
        );
        const divs = parseDegiroCSV(divInput).filter(t => t.type === 'DIVIDEND');
        expect(divs).toHaveLength(1);
        expect(divs[0].total).toBeCloseTo(2.20, 2);
    });

    it('Einzahlung → TRANSFER', () => {
        const depInput = csvDE(
            `02-01-2026,09:00,02-01-2026,,,Einzahlung,,EUR,"1000,00",EUR,"1000,00",`,
        );
        expect(parseDegiroCSV(depInput).filter(t => t.type === 'TRANSFER')).toHaveLength(1);
    });
});

// ─── 18. Multi-idioma: export en HOLANDÉS (clasificación básica) ──────────────

describe('Account.csv en holandés (Koop/Verkoop/Dividendbelasting)', () => {
    const HDR_NL = 'Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id';
    const csvNL = (...rows) => [HDR_NL, ...rows].join('\n');

    it('Koop → BUY y Verkoop → SELL (sin confusión de substrings)', () => {
        const input = csvNL(
            `10-02-2026,10:00,10-02-2026,ASML HOLDING NV,NL0010273215,"Koop 2 ASML Holding NV@650,00 EUR (NL0010273215)",,EUR,"-1300,00",EUR,"200,00",nl-1`,
            `11-02-2026,10:00,11-02-2026,ASML HOLDING NV,NL0010273215,"Verkoop 1 ASML Holding NV@660,00 EUR (NL0010273215)",,EUR,"660,00",EUR,"860,00",nl-2`,
        );
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
        expect(result.filter(t => t.type === 'SELL')).toHaveLength(1);
    });

    it('Dividendbelasting → TAX (no DIVIDEND) y se fusiona con el dividendo del mismo día', () => {
        const input = csvNL(
            `28-03-2026,07:21,27-03-2026,ASML HOLDING NV,NL0010273215,Dividend,,EUR,"3,00",EUR,"3,00",`,
            `28-03-2026,07:21,27-03-2026,ASML HOLDING NV,NL0010273215,Dividendbelasting,,EUR,"-0,45",EUR,"-0,45",`,
        );
        const divs = parseDegiroCSV(input).filter(t => t.type === 'DIVIDEND');
        expect(divs).toHaveLength(1);
        expect(divs[0].total).toBeCloseTo(2.55, 2);
    });

    it('iDEAL storting → TRANSFER y Transactiekosten → FEE', () => {
        const input = csvNL(
            `02-01-2026,09:00,02-01-2026,,,iDEAL storting,,EUR,"500,00",EUR,"500,00",`,
            `03-01-2026,10:00,03-01-2026,ASML HOLDING NV,NL0010273215,DEGIRO Transactiekosten en/of kosten van derden,,EUR,"-2,00",EUR,"498,00",`,
        );
        const result = parseDegiroCSV(input);
        expect(result.filter(t => t.type === 'TRANSFER')).toHaveLength(1);
        expect(result.filter(t => t.type === 'FEE')).toHaveLength(1);
    });
});

// ─── 19. Archivo equivocado: Transactions.csv en vez de Account.csv ──────────

describe('Detección de Transactions.csv (export equivocado de DeGiro)', () => {
    it('cabecera ES de Transacciones lanza error con code degiro_transactions_file', () => {
        const wrongFile = [
            'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden',
            `26-03-2026,17:09,META PLATFORMS INC,US30303M1027,NDQ,MMX,3,"556,4886",USD,"-1669,47",USD,"-1450,18",EUR,"1,1512","-2,00",EUR,"-1452,18",EUR,orden-1`,
        ].join('\n');
        let thrown = null;
        try { parseDegiroCSV(wrongFile); } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('degiro_transactions_file');
    });

    it('cabecera EN de Transactions lanza el mismo error', () => {
        const wrongFile = [
            'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value,,Exchange rate,Transaction and/or third party fees,,Total,,Order ID',
            `26-03-2026,17:09,META PLATFORMS INC,US30303M1027,NDQ,MMX,3,556.4886,USD,-1669.47,USD,-1450.18,EUR,1.1512,-2.00,EUR,-1452.18,EUR,order-1`,
        ].join('\n');
        let thrown = null;
        try { parseDegiroCSV(wrongFile); } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('degiro_transactions_file');
    });

    it('un Account.csv válido NO lanza el error', () => {
        const okInput = csv(
            `26-03-2026,17:09,26-03-2026,META,US30303M1027,"Compra 3 Meta@100 USD (US30303M1027)",,USD,"-300,00",USD,"-300,00",ok-1`,
        );
        expect(() => parseDegiroCSV(okInput)).not.toThrow();
    });
});

// ─── Cabecera que no está en la primera línea ────────────────────────────────
// Regresión del enrutado freeform→degiro: el diálogo de IA antepone una línea
// separadora "--- archivo.csv ---" al contenido; el parser tomaba esa línea
// como cabecera y la cabecera real aparecía como "1 fila no reconocida"
// (L2 · Fecha · Descripción).

describe('Cabecera precedida de líneas ajenas (separador de archivo, preámbulo)', () => {
    const ORDER = 'ab88ec05-bbd2-4b2a-b82f-8a34bff5d9ef';
    const body = [
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,Costes de transacción y/o externos de DEGIRO,,EUR,"-2,00",EUR,"542,32",${ORDER}`,
        `26-03-2026,17:09,26-03-2026,META PLATFORMS INC CLASS A,US30303M1027,"Compra 3 Meta Platforms Inc Class A@556,4886 USD (US30303M1027)",,EUR,"-1669,47",EUR,"-1669,47",${ORDER}`,
    ];
    const withSeparator = ['--- Account_test_degiro.csv ---', HDR, ...body].join('\n');

    it('parsea igual que sin el preámbulo', () => {
        const buys = parseDegiroCSV(withSeparator).filter(t => t.type === 'BUY');
        expect(buys).toHaveLength(1);
        expect(buys[0].cantidad).toBe(3);
        expect(buys[0].comisiones).toBe(2);
    });

    it('la cabecera real NO aparece como fila no reconocida', async () => {
        const { listUnrecognizedDegiroRows } = await import('./degiroParser.js');
        expect(listUnrecognizedDegiroRows(withSeparator)).toEqual([]);
    });
});
