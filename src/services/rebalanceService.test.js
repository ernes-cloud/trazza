import { describe, it, expect } from 'vitest';
import { bandFor, buildRebalancePlan } from './rebalanceService';

// DB-shaped position row (as returned by positions.select('*, assets(*)'))
const pos = (over = {}, assetOver = {}) => ({
  id: 'p1',
  quantity: 10,
  entry_price: 100,
  target_percentage: 0,
  assets: {
    ticker: 'MSFT',
    isin: 'US5949181045',
    currency: 'EUR',
    current_price: 100,
    company_name: 'Microsoft',
    asset_class: 'Stock',
    ...assetOver,
  },
  ...over,
});

const cashPos = (qty = 1000, cur = 'EUR') => pos(
  { id: `cash_${cur}`, quantity: qty, entry_price: 1, target_percentage: 0 },
  { ticker: `CASH_${cur}`, isin: null, currency: cur, current_price: 1, asset_class: 'Cash', company_name: 'Cash' },
);

describe('bandFor', () => {
  it('strict = ±1pp, moderate = ±3pp para cualquier target', () => {
    expect(bandFor('strict', 40)).toBe(1);
    expect(bandFor('moderate', 40)).toBe(3);
  });

  it('swedroe (regla 5/25): min(5pp, 25% relativo del target)', () => {
    expect(bandFor('swedroe', 40)).toBe(5);    // 25% de 40 = 10 → gana el 5 absoluto
    expect(bandFor('swedroe', 10)).toBe(2.5);  // 25% de 10 = 2.5 → gana el relativo
    expect(bandFor('swedroe', 0)).toBe(0);
  });
});

describe('buildRebalancePlan — modo trade', () => {
  it('BUY cuando el drift cae por debajo de la banda, con importe = |moneyDelta|', () => {
    // A: 30% actual vs target 50 (drift −20) · B: 70% actual vs target 50 (drift +20)
    const rows = [
      pos({ id: 'a', quantity: 3, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 7, target_percentage: 50 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.totalCurrent).toBeCloseTo(1000, 10);
    const a = plan.rows.find(r => r.ticker === 'AAA');
    const b = plan.rows.find(r => r.ticker === 'BBB');
    expect(a.action).toBe('BUY');
    expect(a.amount).toBeCloseTo(200, 10);   // 50%×1000 − 300
    expect(a.tradeQty).toBeCloseTo(2, 10);   // 200 / 100
    expect(b.action).toBe('SELL');
    expect(b.amount).toBeCloseTo(200, 10);
  });

  it('HOLD dentro de la banda (moderate ±3pp tolera drift de 2pp)', () => {
    // 48% actual vs target 50 → drift −2pp
    const rows = [
      pos({ id: 'a', quantity: 48, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 52, target_percentage: 50 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'moderate' });
    expect(plan.rows.every(r => r.action === 'HOLD')).toBe(true);
    expect(plan.rows.every(r => r.amount === 0)).toBe(true);
  });

  it('convierte divisas con exchangeRates (regla: nunca mezclar divisas)', () => {
    // USD stock: 10 × $100 × 0.9 = 900€ · EUR stock: 100€ → total 1000€
    const rows = [
      pos({ id: 'u', quantity: 10, target_percentage: 50 }, { ticker: 'USDX', isin: 'ISIN_U', currency: 'USD' }),
      pos({ id: 'e', quantity: 1, target_percentage: 50 }, { ticker: 'EURX', isin: 'ISIN_E' }),
    ];
    const plan = buildRebalancePlan(rows, { exchangeRates: { USD: 0.9 }, bandMode: 'strict' });
    expect(plan.totalCurrent).toBeCloseTo(1000, 10);
    const u = plan.rows.find(r => r.ticker === 'USDX');
    expect(u.currentWeight).toBeCloseTo(90, 10);
    expect(u.action).toBe('SELL');
    // tradeQty usa el precio en divisa preferida (100×0.9)
    expect(u.tradeQty).toBeCloseTo(u.amount / 90, 10);
  });

  it('el cash cuenta en el total (denominador) pero no genera fila', () => {
    const rows = [
      pos({ id: 'a', quantity: 5, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      cashPos(500),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.totalCurrent).toBeCloseTo(1000, 10);
    expect(plan.cashValue).toBeCloseTo(500, 10);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].currentWeight).toBeCloseTo(50, 10);
  });

  it('el margen utilizado (cash negativo) resta del total', () => {
    // Activos 1000, margen -2944 → total neto = 1000 - 2944 = -1944.
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 100 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      cashPos(-2944.63),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.cashValue).toBeCloseTo(-2944.63, 2);
    expect(plan.totalCurrent).toBeCloseTo(1000 - 2944.63, 2);
  });

  it('con cashAsAsset la liquidez es una fila con target editable y participa del plan', () => {
    // Activos 900 (target 90), cash 100 (target 10) → total 1000, ambos a peso.
    const plan = buildRebalancePlan([
      pos({ id: 'a', quantity: 9, target_percentage: 90 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      pos({ id: 'cash_EUR', quantity: 100, target_percentage: 10 }, { ticker: 'CASH_EUR', isin: null, currency: 'EUR', current_price: 1, asset_class: 'Cash', company_name: 'Cash' }),
    ], { bandMode: 'strict', cashAsAsset: true });
    const cashRow = plan.rows.find(r => r.isCash);
    expect(cashRow).toBeTruthy();
    expect(cashRow.currentWeight).toBeCloseTo(10, 6);
    expect(cashRow.action).toBe('HOLD'); // ya en su 10%
    expect(plan.targetSum).toBeCloseTo(100, 6); // 90 + 10 incluye el target de cash
  });

  it('en contribute con cashAsAsset la liquidez con target absorbe parte de la aportación', () => {
    // AAA 900 (t90), cash 100 (t10). Aporto 1000 → newTotal 2000, objetivo cash 200,
    // déficit cash 100 → recibe 100 (se queda como liquidez).
    const rows = [
      pos({ id: 'a', quantity: 9, target_percentage: 90 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      pos({ id: 'cash_EUR', quantity: 100, target_percentage: 10 }, { ticker: 'CASH_EUR', isin: null, currency: 'EUR', current_price: 1, asset_class: 'Cash', company_name: 'Cash' }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 1000, cashAsAsset: true });
    const cashRow = plan.rows.find(r => r.isCash);
    expect(cashRow.amount).toBeCloseTo(100, 6);
  });

  it('sin cashAsAsset la liquidez nunca es fila (comportamiento por defecto)', () => {
    const rows = [
      pos({ id: 'a', quantity: 9, target_percentage: 90 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      pos({ id: 'cash_EUR', quantity: 100, target_percentage: 10 }, { ticker: 'CASH_EUR', isin: null, currency: 'EUR', current_price: 1, asset_class: 'Cash', company_name: 'Cash' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.rows.some(r => r.isCash)).toBe(false);
    expect(plan.untargetedRows.some(r => r.isCash)).toBe(false);
  });

  it('agrupa por ISIN el mismo activo en varios brokers (target = max, regla general-view)', () => {
    const rows = [
      pos({ id: 'p1', quantity: 3, target_percentage: 40 }),
      pos({ id: 'p2', quantity: 7, target_percentage: 0 }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].qty).toBeCloseTo(10, 10);
    expect(plan.rows[0].value).toBeCloseTo(1000, 10);
    expect(plan.rows[0].target).toBe(40);
    expect(plan.rows[0].positionIds).toEqual(['p1', 'p2']);
    expect(plan.untargetedCount).toBe(0);
  });

  it('expone las posiciones sin target como untargetedRows con peso y positionIds', () => {
    const rows = [
      pos({ id: 'a', quantity: 5, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b1', quantity: 3, target_percentage: 0 }, { ticker: 'BBB', isin: 'ISIN_B' }),
      pos({ id: 'b2', quantity: 2, target_percentage: 0 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.untargetedRows).toHaveLength(1);
    const u = plan.untargetedRows[0];
    expect(u.target).toBe(0);
    expect(u.currentWeight).toBeCloseTo(50, 10);
    expect(u.value).toBeCloseTo(500, 10);
    expect(u.positionIds).toEqual(['b1', 'b2']);
    // No forman parte del plan de acciones
    expect(plan.rows.some(r => r.key === u.key)).toBe(false);
  });

  it('las posiciones sin target no generan fila pero cuentan en total y en el aviso', () => {
    const rows = [
      pos({ id: 'a', quantity: 5, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 5, target_percentage: 0 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.rows).toHaveLength(1);
    expect(plan.totalCurrent).toBeCloseTo(1000, 10);
    expect(plan.untargetedCount).toBe(1);
    expect(plan.untargetedValue).toBeCloseTo(500, 10);
    expect(plan.targetSum).toBe(50);
  });

  it('ordena por drift ascendente (más infraponderado primero)', () => {
    const rows = [
      pos({ id: 'over', quantity: 8, target_percentage: 40 }, { ticker: 'OVER', isin: 'ISIN_O' }),
      pos({ id: 'under', quantity: 2, target_percentage: 40 }, { ticker: 'UNDER', isin: 'ISIN_U' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.rows[0].ticker).toBe('UNDER');
  });
});

describe('buildRebalancePlan — modo contribute (solo aportar, sin vender)', () => {
  it('cubre exactamente los déficits cuando la aportación alcanza', () => {
    // A 300 (target 50) · B 700 (target 50) · aporto 400 → newTotal 1400,
    // déficit A = 700−300 = 400, déficit B = 0 → todo a A y queda 50/50.
    const rows = [
      pos({ id: 'a', quantity: 3, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 7, target_percentage: 50 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 400 });
    const a = plan.rows.find(r => r.ticker === 'AAA');
    const b = plan.rows.find(r => r.ticker === 'BBB');
    expect(a.action).toBe('BUY');
    expect(a.amount).toBeCloseTo(400, 10);
    expect(b.action).toBe('HOLD');
    expect(b.amount).toBeCloseTo(0, 10);
    // Nunca se vende en modo aportación
    expect(plan.rows.some(r => r.action === 'SELL')).toBe(false);
  });

  it('escala proporcionalmente cuando la aportación no cubre los déficits', () => {
    // Déficits: A 400, B 100 (500 total) · aporto 250 → mitad de cada déficit.
    // A 100 (target 50), B 400 (target 50), total 500 + aporto 250 → newTotal 750,
    // objetivo por activo 375: déficit A 275, déficit B 0... ajustar:
    // → uso targets asimétricos: A target 60, B target 40, A 100, B 400.
    // newTotal 750 → objetivo A 450 (déficit 350), objetivo B 300 (déficit 0).
    // Aporto 250 < 350 → A recibe 250, B 0.
    const rows = [
      pos({ id: 'a', quantity: 1, target_percentage: 60 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 4, target_percentage: 40 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 250 });
    const a = plan.rows.find(r => r.ticker === 'AAA');
    const b = plan.rows.find(r => r.ticker === 'BBB');
    expect(a.amount).toBeCloseTo(250, 10);
    expect(b.amount).toBeCloseTo(0, 10);
    // La suma asignada nunca excede la aportación
    const sum = plan.rows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeLessThanOrEqual(250 + 1e-9);
  });

  it('reparte el sobrante proporcionalmente a targets cuando la aportación excede los déficits', () => {
    // Cartera ya en target 50/50 (500/500) · aporto 100 → déficits 50/50 exactos,
    // se cubren y no hay sobrante. Con targets 60/40 y cartera 600/400: déficits
    // A=60, B=40 → aporto 200: cubre 100 y reparte 100 restante 60/40.
    const rows = [
      pos({ id: 'a', quantity: 6, target_percentage: 60 }, { ticker: 'AAA', isin: 'ISIN_A' }),
      pos({ id: 'b', quantity: 4, target_percentage: 40 }, { ticker: 'BBB', isin: 'ISIN_B' }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 200 });
    const a = plan.rows.find(r => r.ticker === 'AAA');
    const b = plan.rows.find(r => r.ticker === 'BBB');
    // Déficit A: 60%×1200−600 = 120 · déficit B: 40%×1200−400 = 80 → suma 200 = aportación
    expect(a.amount).toBeCloseTo(120, 10);
    expect(b.amount).toBeCloseTo(80, 10);
    // Los pesos resultantes quedan clavados al target
    const newTotal = plan.totalCurrent + 200;
    expect(((600 + a.amount) / newTotal) * 100).toBeCloseTo(60, 10);
    expect(((400 + b.amount) / newTotal) * 100).toBeCloseTo(40, 10);
  });

  it('el sobrante NO se reparte a activos ya por encima de su target', () => {
    // Constellation domina (val 1619, target 5%) · Apple nuevo (val 0, target 5%).
    // Aporto 1000 → déficit Apple 5%×2619 ≈ 131, déficit Constellation 0 (sobrepasa).
    // El sobrante (~869) debe ir ÍNTEGRO a Apple, nada a Constellation.
    const rows = [
      pos({ id: 'c', quantity: 1, target_percentage: 5 }, { ticker: 'CSU', isin: 'ISIN_C', current_price: 1619.15 }),
      pos({ id: 'a', quantity: 0, target_percentage: 5, isVirtual: true }, { ticker: 'AAPL', isin: 'ISIN_A', current_price: 100 }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 1000 });
    const apple = plan.rows.find(r => r.ticker === 'AAPL');
    const csu = plan.rows.find(r => r.ticker === 'CSU');
    expect(apple.amount).toBeCloseTo(1000, 6);
    expect(csu.amount).toBeCloseTo(0, 6);
    expect(csu.action).toBe('HOLD');
  });

  it('si TODOS los targets ya superan su objetivo, reparte el sobrante entre todos', () => {
    // A y B ambos muy por encima de un target minúsculo: no hay infraponderados,
    // el dinero se reparte proporcional a targets (fallback) para que aterrice.
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 2 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      pos({ id: 'b', quantity: 10, target_percentage: 2 }, { ticker: 'BBB', isin: 'ISIN_B', current_price: 100 }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 100 });
    const sum = plan.rows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(100, 6); // el dinero se asigna, no se pierde
  });

  it('aportación 0 o negativa → todo HOLD sin importes', () => {
    const rows = [pos({ id: 'a', quantity: 5, target_percentage: 100 }, { ticker: 'AAA', isin: 'ISIN_A' })];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: -50 });
    expect(plan.rows[0].action).toBe('HOLD');
    expect(plan.rows[0].amount).toBe(0);
  });
});

describe('buildRebalancePlan — activos virtuales (compra nueva no poseída)', () => {
  const virtualPos = (over = {}, assetOver = {}) => pos(
    { id: `virtual-${assetOver.ticker || 'NEW'}`, quantity: 0, entry_price: 0, isVirtual: true, ...over },
    { current_price: 50, ...assetOver },
  );

  it('incluye un activo qty 0 marcado isVirtual y calcula la compra en modo trade', () => {
    // Cartera: AAA 1000 (target 50). Nuevo VWCE virtual (target 50, qty 0).
    // Total = 1000; VWCE currentWeight 0%, drift -50pp → BUY.
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      virtualPos({ target_percentage: 50 }, { ticker: 'VWCE', isin: '', current_price: 50 }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    const vwce = plan.rows.find(r => r.ticker === 'VWCE');
    expect(vwce).toBeTruthy();
    expect(vwce.isVirtual).toBe(true);
    expect(vwce.value).toBe(0);
    expect(vwce.action).toBe('BUY');
    expect(vwce.amount).toBeGreaterThan(0);
    // La cantidad a comprar = importe / precio (50)
    expect(vwce.tradeQty).toBeCloseTo(vwce.amount / 50, 6);
  });

  it('en modo aportación reparte la contribución al activo nuevo según su target', () => {
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      virtualPos({ target_percentage: 50 }, { ticker: 'VWCE', current_price: 50 }),
    ];
    const plan = buildRebalancePlan(rows, { mode: 'contribute', contribution: 1000 });
    const vwce = plan.rows.find(r => r.ticker === 'VWCE');
    // newTotal 2000, objetivo VWCE 1000, déficit 1000 → recibe toda la aportación
    expect(vwce.action).toBe('BUY');
    expect(vwce.amount).toBeCloseTo(1000, 6);
  });

  it('un activo virtual sin target aparece como untargeted (editable), no en el plan', () => {
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 100 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      virtualPos({ target_percentage: 0 }, { ticker: 'VWCE', current_price: 50 }),
    ];
    const plan = buildRebalancePlan(rows, {});
    expect(plan.rows.some(r => r.ticker === 'VWCE')).toBe(false);
    const untargeted = plan.untargetedRows.find(r => r.ticker === 'VWCE');
    expect(untargeted).toBeTruthy();
    expect(untargeted.isVirtual).toBe(true);
  });

  it('un activo real cerrado (qty 0, no virtual) sigue excluido', () => {
    const rows = [
      pos({ id: 'a', quantity: 10, target_percentage: 50 }, { ticker: 'AAA', isin: 'ISIN_A', current_price: 100 }),
      pos({ id: 'closed', quantity: 0, target_percentage: 50 }, { ticker: 'OLD', isin: 'ISIN_OLD', current_price: 10 }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    expect(plan.rows.some(r => r.ticker === 'OLD')).toBe(false);
    expect(plan.untargetedRows.some(r => r.ticker === 'OLD')).toBe(false);
  });
});

describe('buildRebalancePlan — agrupación entre brokers', () => {
  it('Amazon de DeGiro (con ISIN) y de IBKR (sin ISIN) es UNA fila, como en brokers', () => {
    // Caso real reportado: el parser de IBKR solo saca el ISIN de los dividendos,
    // así que un valor sin dividendo se guarda con isin '' y ticker 'AMZN (USD)'.
    const rows = [
      pos({ id: 'dg', quantity: 2, target_percentage: 1 },
        { ticker: 'US0231351067 (USD)', isin: 'US0231351067', company_name: 'Amazon.com Inc', current_price: 200 }),
      pos({ id: 'ib', quantity: 11, target_percentage: 12 },
        { ticker: 'AMZN (USD)', isin: '', company_name: 'AMZN', current_price: 200 }),
      pos({ id: 'ms', quantity: 10, target_percentage: 50 }, { ticker: 'MSFT', isin: 'US5949181045' }),
    ];
    const plan = buildRebalancePlan(rows, { bandMode: 'strict' });
    const amazon = plan.rows.filter((r) => /amazon|amzn/i.test(`${r.name} ${r.ticker}`));
    expect(amazon).toHaveLength(1);
    expect(amazon[0].value).toBeCloseTo(13 * 200, 6);
    expect(amazon[0].target).toBe(12); // regla de la vista general: target = máx.
    // La fila unida enseña el nombre y el ISIN reales, no el placeholder de IBKR.
    expect(amazon[0].name).toBe('Amazon.com Inc');
    expect(amazon[0].isin).toBe('US0231351067');
  });
});
