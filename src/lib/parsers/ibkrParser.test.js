import { describe, it, expect } from 'vitest';
import { parseIBKRCSV } from './ibkrParser.js';

// ─── helpers ────────────────────────────────────────────────────────────────

// Convenience wrapper: most tests only care about the transaction list
const parse = (csv) => parseIBKRCSV(csv).transactions;

const TH_HEADER = 'Transaction History,Header,Date,Account,Description,Transaction Type,Symbol,Quantity,Price,Price Currency,Gross Amount,Commission,Net Amount';
const SUMMARY_EUR   = 'Summary,Data,Divisa base,EUR';
const SUMMARY_CASH  = (amount) => `Summary,Data,Efectivo final,${amount}`;
const WHEN_GEN      = 'Statement,Data,WhenGenerated,"2026-01-31, 12:00:00 EST"';

// Minimal Transaction History CSV (base currency EUR, no ending cash unless added)
const th = (...rows) => [
    SUMMARY_EUR,
    WHEN_GEN,
    TH_HEADER,
    ...rows,
].join('\n');

// Same but includes an Efectivo final + foreign currency set
const thWithCash = (endingCash, ...rows) => [
    SUMMARY_EUR,
    SUMMARY_CASH(endingCash),
    WHEN_GEN,
    TH_HEADER,
    ...rows,
].join('\n');

// ─── 1. Format detection ─────────────────────────────────────────────────────

describe('Detección de formato: Transaction History vs Activity Statement', () => {
    it('CSV sin la cabecera "Transaction History,Header" se trata como Activity Statement', () => {
        // A minimal activity statement has no Transaction History header line
        const activityCSV = [
            'Account Information,Header,Field Name,Field Value',
            'Account Information,Data,Base Currency,EUR',
            'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Net Amount',
            'Trades,Data,Order,Stocks,USD,AAPL,"2025-01-15, 10:00:00",10,200.00,-2000.00',
        ].join('\n');
        // Should not throw and should return some result (activity statement parser)
        expect(() => parseIBKRCSV(activityCSV)).not.toThrow();
    });

    it('CSV con la cabecera correcta se parsea como Transaction History', () => {
        const csv = th(
            'Transaction History,Data,2026-01-15,U12345,Buy 10 AAPL (US0378331005),BUY,AAPL,10,200.00,USD,-2005.00,-5.00,-2010.00',
        );
        const result = parseIBKRCSV(csv);
        expect(result.detectedFormat).toBe('transaction-history');
        expect(result.transactions.some(t => t.type === 'BUY' && t.producto === 'AAPL')).toBe(true);
    });

    it('CSV vacío devuelve transactions vacío', () => {
        expect(parseIBKRCSV('').transactions).toEqual([]);
    });

    it('CSV completamente desconocido devuelve warning ibkr_unknown_format', () => {
        const result = parseIBKRCSV('col1,col2,col3\nfoo,bar,baz');
        expect(result.detectedFormat).toBe('unknown');
        expect(result.warnings.some(w => w.code === 'ibkr_unknown_format')).toBe(true);
        expect(result.transactions).toHaveLength(0);
    });

    it('CSV con BOM UTF-8 al principio se parsea correctamente', () => {
        const csv = '﻿' + th(
            'Transaction History,Data,2026-01-15,U12345,Buy 1 AAPL (US0378331005),BUY,AAPL,1,200.00,USD,-205.00,-5.00,-210.00',
        );
        const result = parseIBKRCSV(csv);
        expect(result.detectedFormat).toBe('transaction-history');
        expect(result.transactions.some(t => t.type === 'BUY')).toBe(true);
    });

    it('Activity Statement se detecta correctamente', () => {
        const activityCSV = [
            'Account Information,Header,Field Name,Field Value',
            'Account Information,Data,Base Currency,EUR',
            'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Net Amount',
            'Trades,Data,Order,Stocks,USD,AAPL,"2025-01-15, 10:00:00",10,200.00,-2000.00',
        ].join('\n');
        const result = parseIBKRCSV(activityCSV);
        expect(result.detectedFormat).toBe('activity-statement');
    });
});

// ─── 2. Compra acción US (USD) ───────────────────────────────────────────────

describe('BUY de acción US en USD (AAPL)', () => {
    const csv = th(
        'Transaction History,Data,2026-01-15,U12345,Buy 10 Apple Inc (US0378331005),BUY,AAPL,10,200.00,USD,-2005.00,-5.00,-2010.00',
    );

    it('produce exactamente 1 transacción BUY', () => {
        expect(parse(csv).filter(t => t.type === 'BUY')).toHaveLength(1);
    });

    it('símbolo, cantidad y precio nativos correctos', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.producto).toBe('AAPL');
        expect(buy.cantidad).toBe(10);
        expect(buy.precio).toBeCloseTo(200.00, 2);
        expect(buy.moneda).toBe('USD');
    });

    it('total = qty × precio (NO el netAmount en EUR)', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.total).toBeCloseTo(2000.00, 2);
    });

    it('comisión en EUR (netAmount - grossAmount)', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.comisiones).toBeCloseTo(5.00, 2);
    });

    it('totalEUR = |grossAmount| SIN la comisión (regresión F2: doble conteo)', () => {
        // Con |netAmount| (2010) la comisión quedaba embebida en el coste base
        // Y además sumada a feesTotal vía `comisiones` — contada dos veces.
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.totalEUR).toBeCloseTo(2005.00, 2);
        expect(buy.totalEUR + buy.comisiones).toBeCloseTo(2010.00, 2); // net = gross + fee
    });

    it('ISIN extraído del paréntesis de la descripción', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.isin).toBe('US0378331005');
    });
});

// ─── 3. Compra acción no-USD (CAD) ───────────────────────────────────────────

describe('BUY de acción canadiense en CAD (CSU)', () => {
    // CSU trades on TSX in CAD. qty=2, price=3500 CAD, gross en EUR = -6000 EUR (ficticio), comm=-5 EUR
    const csv = th(
        'Transaction History,Data,2026-02-10,U12345,"Buy 2 Constellation Software (CA21037X1000)",BUY,CSU,2,3500.00,CAD,-5550.00,-5.00,-5555.00',
    );

    it('moneda nativa es CAD (no EUR)', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.moneda).toBe('CAD');
    });

    it('total = 2 × 3500 CAD (no el gross en EUR)', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.total).toBeCloseTo(7000.00, 2);
    });

    it('ISIN extraído de la descripción', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.isin).toBe('CA21037X1000');
    });
});

// ─── 4. Venta de acción ───────────────────────────────────────────────────────

describe('SELL de acción EUR (ASML)', () => {
    const csv = th(
        'Transaction History,Data,2026-03-05,U12345,Sell 1 ASML Holding NV (NL0010273215),SELL,ASML,-1,700.00,EUR,700.00,-4.00,696.00',
    );

    it('tipo SELL con cantidad positiva', () => {
        const sell = parse(csv).find(t => t.type === 'SELL');
        expect(sell).toBeDefined();
        expect(sell.cantidad).toBe(1);
    });

    it('precio en EUR, total = 1 × 700', () => {
        const sell = parse(csv).find(t => t.type === 'SELL');
        expect(sell.precio).toBeCloseTo(700.00, 2);
        expect(sell.moneda).toBe('EUR');
        expect(sell.total).toBeCloseTo(700.00, 2);
    });

    it('comisión 4 EUR almacenada correctamente', () => {
        const sell = parse(csv).find(t => t.type === 'SELL');
        expect(sell.comisiones).toBeCloseTo(4.00, 2);
    });
});

// ─── 5. Dividendo ────────────────────────────────────────────────────────────

describe('DIVIDEND de acción US (AAPL)', () => {
    const csv = th(
        'Transaction History,Data,2026-03-10,U12345,AAPL Dividend (US0378331005),DIVIDEND,AAPL,0,0,USD,0,-0,25.50',
    );

    it('tipo DIVIDEND con total = netAmount en EUR (moneda base)', () => {
        const div = parse(csv).find(t => t.type === 'DIVIDEND');
        expect(div).toBeDefined();
        expect(div.total).toBeCloseTo(25.50, 2);
        expect(div.moneda).toBe('EUR');
    });

    it('cantidad = 0 (no es compra/venta)', () => {
        const div = parse(csv).find(t => t.type === 'DIVIDEND');
        expect(div.cantidad).toBe(0);
    });
});

// ─── 6. Retención fiscal (Withholding Tax) ───────────────────────────────────

describe('Withholding Tax (retención sobre dividendo)', () => {
    const csv = th(
        'Transaction History,Data,2026-03-10,U12345,AAPL Withholding Tax (US0378331005),Withholding Tax,AAPL,0,0,USD,0,0,-7.65',
    );

    it('tipo TAX con importe absoluto en EUR (moneda base)', () => {
        const tax = parse(csv).find(t => t.type === 'TAX');
        expect(tax).toBeDefined();
        expect(tax.total).toBeCloseTo(7.65, 2);
        expect(tax.moneda).toBe('EUR');
    });
});

// ─── 7. Depósito bancario ────────────────────────────────────────────────────

describe('Depósito bancario (DEPOSIT)', () => {
    const csv = th(
        'Transaction History,Data,2026-01-05,U12345,Wire Transfer In,DEPOSIT,-,0,0,-,1500.00,0,1500.00',
    );

    it('tipo TRANSFER con importe positivo', () => {
        const dep = parse(csv).find(t => t.type === 'TRANSFER');
        expect(dep).toBeDefined();
        expect(dep.total).toBeCloseTo(1500.00, 2);
    });

    it('moneda = divisa base (EUR)', () => {
        const dep = parse(csv).find(t => t.type === 'TRANSFER');
        expect(dep.moneda).toBe('EUR');
    });
});

// ─── 8. Retirada bancaria (Withdrawal) ──────────────────────────────────────

describe('Retirada bancaria (WITHDRAWAL)', () => {
    const csv = th(
        'Transaction History,Data,2026-04-01,U12345,Wire Transfer Out,WITHDRAWAL,-,0,0,-,-800.00,0,-800.00',
    );

    it('tipo TRANSFER con importe negativo', () => {
        const wd = parse(csv).find(t => t.type === 'TRANSFER');
        expect(wd).toBeDefined();
        expect(wd.total).toBeCloseTo(-800.00, 2);
    });
});

// ─── 9. Comisión / Fee ───────────────────────────────────────────────────────

describe('Comisión standalone (COMMISSION)', () => {
    const csv = th(
        'Transaction History,Data,2026-01-31,U12345,Monthly Fee,COMMISSION,-,0,0,-,-10.00,0,-10.00',
    );

    it('tipo FEES con importe absoluto', () => {
        const fee = parse(csv).find(t => t.type === 'FEES');
        expect(fee).toBeDefined();
        expect(fee.total).toBeCloseTo(10.00, 2);
    });
});

// ─── 10. Misc Fee ────────────────────────────────────────────────────────────

describe('Misc. Fee (otra comisión)', () => {
    const csv = th(
        'Transaction History,Data,2026-01-31,U12345,Market Data Fee,MISC. FEE,-,0,0,-,-2.50,0,-2.50',
    );

    it('tipo FEES', () => {
        const fee = parse(csv).find(t => t.type === 'FEES');
        expect(fee).toBeDefined();
        expect(fee.total).toBeCloseTo(2.50, 2);
    });
});

// ─── 11. Snapshots de efectivo final ─────────────────────────────────────────

describe('Efectivo final (ending cash snapshots)', () => {
    // Portfolio: deposited 1500 EUR, bought 2 CSU at 3500 CAD each.
    // Efectivo final EUR = 44.44 (after commissions etc.)
    // CAD was used for BUY → foreignCurrencies includes CAD → snapshot CAD = 0
    const csv = thWithCash(44.44,
        'Transaction History,Data,2026-01-05,U12345,Wire Transfer In,DEPOSIT,-,0,0,-,1500.00,0,1500.00',
        'Transaction History,Data,2026-02-10,U12345,"Buy 2 CSU (CA21037X1000)",BUY,CSU,2,3500.00,CAD,-6200.00,-5.00,-6205.00',
    );

    it('genera snapshot isEndingCash=true para EUR con el saldo real', () => {
        const snaps = parse(csv).filter(t => t.isEndingCash);
        const eurSnap = snaps.find(s => s.moneda === 'EUR');
        expect(eurSnap).toBeDefined();
        expect(eurSnap.total).toBeCloseTo(44.44, 2);
    });

    it('genera snapshot isEndingCash=true para CAD con saldo cero', () => {
        const snaps = parse(csv).filter(t => t.isEndingCash);
        const cadSnap = snaps.find(s => s.moneda === 'CAD');
        expect(cadSnap).toBeDefined();
        expect(cadSnap.total).toBe(0);
    });

    it('ambos snapshots tienen idOrden únicos', () => {
        const snaps = parse(csv).filter(t => t.isEndingCash);
        const ids = snaps.map(s => s.idOrden);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('snapshot EUR tiene hora 23:59:59 (última del día)', () => {
        const eurSnap = parse(csv).find(t => t.isEndingCash && t.moneda === 'EUR');
        expect(eurSnap.hora).toBe('23:59:59');
    });

    it('sin Efectivo final no se generan snapshots', () => {
        const csvNoSnap = th(
            'Transaction History,Data,2026-01-05,U12345,Wire Transfer In,DEPOSIT,-,0,0,-,1500.00,0,1500.00',
        );
        const snaps = parse(csvNoSnap).filter(t => t.isEndingCash);
        expect(snaps).toHaveLength(0);
    });
});

// ─── 12. Múltiples activos y divisas ─────────────────────────────────────────

describe('Cartera diversificada: USD + CAD + EUR + dividendo + comisión', () => {
    const csv = thWithCash(200.00,
        'Transaction History,Data,2026-01-05,U12345,Wire Transfer In,DEPOSIT,-,0,0,-,2000.00,0,2000.00',
        'Transaction History,Data,2026-01-10,U12345,Buy 5 AAPL (US0378331005),BUY,AAPL,5,200.00,USD,-1005.00,-5.00,-1010.00',
        'Transaction History,Data,2026-01-20,U12345,"Buy 1 CSU (CA21037X1000)",BUY,CSU,1,3500.00,CAD,-2700.00,-5.00,-2705.00',
        'Transaction History,Data,2026-02-01,U12345,AAPL Dividend (US0378331005),DIVIDEND,AAPL,0,0,USD,0,0,3.75',
        'Transaction History,Data,2026-02-01,U12345,AAPL Withholding Tax (US0378331005),Withholding Tax,AAPL,0,0,USD,0,0,-0.75',
        'Transaction History,Data,2026-02-28,U12345,Monthly Fee,COMMISSION,-,0,0,-,-10.00,0,-10.00',
    );
    const result = parseIBKRCSV(csv);

    it('detecta 2 BUY, 1 DIVIDEND, 1 TAX, 1 TRANSFER, 1 FEES', () => {
        expect(result.transactions.filter(t => t.type === 'BUY')).toHaveLength(2);
        expect(result.transactions.filter(t => t.type === 'DIVIDEND')).toHaveLength(1);
        expect(result.transactions.filter(t => t.type === 'TAX')).toHaveLength(1);
        expect(result.transactions.filter(t => t.type === 'TRANSFER')).toHaveLength(1);
        expect(result.transactions.filter(t => t.type === 'FEES')).toHaveLength(1);
    });

    it('snapshots: EUR + USD + CAD', () => {
        const snaps = result.transactions.filter(t => t.isEndingCash);
        const currencies = snaps.map(s => s.moneda);
        expect(currencies).toContain('EUR');
        expect(currencies).toContain('USD');
        expect(currencies).toContain('CAD');
    });

    it('dividendo en EUR (divisa base), no en USD', () => {
        const div = result.transactions.find(t => t.type === 'DIVIDEND');
        expect(div.moneda).toBe('EUR');
        expect(div.total).toBeCloseTo(3.75, 2);
    });

    it('AAPL total = 5 × 200 USD (no el gross en EUR)', () => {
        const buy = result.transactions.find(t => t.type === 'BUY' && t.producto === 'AAPL');
        expect(buy.moneda).toBe('USD');
        expect(buy.total).toBeCloseTo(1000.00, 2);
    });

    it('sin tipos desconocidos → warnings vacío', () => {
        expect(result.warnings).toHaveLength(0);
    });
});

// ─── 13. Transferencia de posición entre cuentas ─────────────────────────────

describe('Transferencia de posición (TRANSFER de shares)', () => {
    const csv = th(
        'Transaction History,Data,2026-01-15,U12345,Position Transfer MSFT (US5949181045),TRANSFER,MSFT,15,410.00,USD,0,0,0',
    );

    it('transferencia positiva tratada como BUY', () => {
        const t = parse(csv).find(r => r.type === 'BUY' && r.producto === 'MSFT');
        expect(t).toBeDefined();
        expect(t.cantidad).toBe(15);
        expect(t.precio).toBeCloseTo(410.00, 2);
        expect(t.moneda).toBe('USD');
    });
});

// ─── 14. Forex Trade Component se omite ──────────────────────────────────────

describe('Forex Trade Component → descartado', () => {
    const csv = th(
        'Transaction History,Data,2026-01-10,U12345,USD.EUR Forex,Forex Trade Component,USD.EUR,1000,0.92,EUR,-920.00,0,-920.00',
        'Transaction History,Data,2026-01-10,U12345,Buy 5 AAPL (US0378331005),BUY,AAPL,5,200.00,USD,-1005.00,-5.00,-1010.00',
    );
    const result = parseIBKRCSV(csv);

    it('no genera transacciones de tipo FOREX', () => {
        const forex = result.transactions.filter(t => t.type === 'FOREX' || t.type === 'FOREX TRADE COMPONENT');
        expect(forex).toHaveLength(0);
    });

    it('sólo genera el BUY de AAPL', () => {
        expect(result.transactions.filter(t => t.type === 'BUY')).toHaveLength(1);
    });
});

// ─── 15. Fechas ──────────────────────────────────────────────────────────────

describe('Parseo de fechas en formato ISO (YYYY-MM-DD)', () => {
    const csv = th(
        'Transaction History,Data,2025-12-25,U12345,Buy 1 AAPL (US0378331005),BUY,AAPL,1,200.00,USD,-205.00,-5.00,-210.00',
    );

    it('fecha en formato DD-MM-YYYY', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        expect(buy.fecha).toBe('25-12-2025');
    });
});

// ─── 16. Base currency inglesa (EN locale) ────────────────────────────────────

describe('Base Currency (EN) en lugar de Divisa base (ES)', () => {
    const csv = [
        'Summary,Data,Base Currency,USD',
        SUMMARY_CASH(300.00),
        WHEN_GEN,
        TH_HEADER,
        'Transaction History,Data,2026-01-10,U12345,Buy 5 AAPL (US0378331005),BUY,AAPL,5,200.00,USD,-1005.00,-5.00,-1010.00',
    ].join('\n');

    it('detecta USD como moneda base', () => {
        const buy = parse(csv).find(t => t.type === 'BUY');
        // commission should be in USD (base currency)
        expect(buy.comisiones).toBeCloseTo(5.00, 2);
    });

    it('snapshot EUR de efectivo usa USD como moneda base', () => {
        const snap = parse(csv).find(t => t.isEndingCash);
        expect(snap).toBeDefined();
        expect(snap.moneda).toBe('USD');
        expect(snap.total).toBeCloseTo(300.00, 2);
    });
});

// ─── 17. CSV sin filas Transaction History Data → array vacío ───────────────

describe('Sin filas de datos válidas', () => {
    it('sólo la cabecera TH devuelve array vacío (sin transacciones)', () => {
        const csv = [SUMMARY_EUR, WHEN_GEN, TH_HEADER].join('\n');
        const result = parseIBKRCSV(csv);
        expect(result.transactions.filter(t => !t.isEndingCash)).toHaveLength(0);
    });
});

// ─── 18. Estructura mínima de cada transacción ───────────────────────────────

describe('Estructura de las transacciones de salida', () => {
    it('BUY tiene los campos mínimos requeridos', () => {
        const csv = th(
            'Transaction History,Data,2026-01-10,U12345,Buy 3 META (US30303M1027),BUY,META,3,600.00,USD,-1808.00,-8.00,-1816.00',
        );
        const t = parse(csv).find(r => r.type === 'BUY');
        expect(t).toMatchObject({
            type: 'BUY',
            isin: expect.any(String),
            fecha: expect.any(String),
            cantidad: expect.any(Number),
            precio: expect.any(Number),
            moneda: expect.any(String),
            total: expect.any(Number),
            idOrden: expect.any(String),
        });
    });

    it('todas las transacciones tienen fecha no vacía', () => {
        const csv = thWithCash(500.00,
            'Transaction History,Data,2026-01-10,U12345,Buy 1 AAPL (US0378331005),BUY,AAPL,1,200.00,USD,-205.00,-5.00,-210.00',
            'Transaction History,Data,2026-01-20,U12345,AAPL Dividend (US0378331005),DIVIDEND,AAPL,0,0,USD,0,0,5.00',
        );
        parse(csv).forEach(t => {
            expect(t.fecha).toBeTruthy();
        });
    });
});

// ─── 19. Tipos desconocidos → warning ─────────────────────────────────────────

describe('Tipos de transacción no reconocidos (D — unknown bucket)', () => {
    it('tipo desconocido genera warning ibkr_unknown_types con el tipo listado', () => {
        const csv = th(
            'Transaction History,Data,2026-06-01,U12345,Stock Split NVDA,STOCK SPLIT,NVDA,0,0,USD,0,0,0',
            'Transaction History,Data,2026-06-02,U12345,Rights Issue VOW,RIGHTS ISSUE,VOW,0,0,EUR,0,0,0',
        );
        const result = parseIBKRCSV(csv);
        const w = result.warnings.find(w => w.code === 'ibkr_unknown_types');
        expect(w).toBeDefined();
        expect(w.types).toContain('STOCK SPLIT');
        expect(w.types).toContain('RIGHTS ISSUE');
    });

    it('tipos conocidos no generan warnings', () => {
        const csv = th(
            'Transaction History,Data,2026-01-10,U12345,Buy 1 AAPL (US0378331005),BUY,AAPL,1,200.00,USD,-205.00,-5.00,-210.00',
            'Transaction History,Data,2026-01-20,U12345,AAPL Dividend (US0378331005),DIVIDEND,AAPL,0,0,USD,0,0,5.00',
        );
        const result = parseIBKRCSV(csv);
        expect(result.warnings.filter(w => w.code === 'ibkr_unknown_types')).toHaveLength(0);
    });

    it('transacciones conocidas no se descartan por la presencia de tipos desconocidos', () => {
        const csv = th(
            'Transaction History,Data,2026-01-10,U12345,Buy 1 AAPL (US0378331005),BUY,AAPL,1,200.00,USD,-205.00,-5.00,-210.00',
            'Transaction History,Data,2026-06-01,U12345,Stock Split NVDA,STOCK SPLIT,NVDA,0,0,USD,0,0,0',
        );
        const result = parseIBKRCSV(csv);
        expect(result.transactions.some(t => t.type === 'BUY' && t.producto === 'AAPL')).toBe(true);
        expect(result.warnings.some(w => w.code === 'ibkr_unknown_types')).toBe(true);
    });
});

// ─── 20. Interés de margen (INTEREST) ────────────────────────────────────────

describe('Interés de margen / efectivo (INTEREST)', () => {
    it('interés positivo se clasifica como DIVIDEND', () => {
        const csv = th(
            'Transaction History,Data,2026-02-28,U12345,USD Cash Interest,INTEREST,-,0,0,-,0,0,3.20',
        );
        const t = parse(csv).find(r => r.type === 'DIVIDEND');
        expect(t).toBeDefined();
        expect(t.total).toBeCloseTo(3.20, 2);
    });

    it('interés negativo (debit) se clasifica como FEES', () => {
        const csv = th(
            'Transaction History,Data,2026-02-28,U12345,Margin Interest,DEBIT INTEREST,-,0,0,-,-12.50,0,-12.50',
        );
        const t = parse(csv).find(r => r.type === 'FEES');
        expect(t).toBeDefined();
        expect(t.total).toBeCloseTo(12.50, 2);
    });
});
