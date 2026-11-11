import { describe, it, expect } from 'vitest';
import {
  classifyMovementIntent, classifyStatement, detectOwnCounterparties, summarizeIntents,
} from './bankNoiseClassifier';
import { categorizeMerchant, collectUncategorizedMerchants } from './merchantRules';
import { buildImportKey, buildBankImportPlan, buildPreviewRows } from './bankImportMapper';
import { detectBankStatement } from '@/lib/parsers/bank/bankDetect';

/** Movimiento mínimo con el contrato BankMovement. */
const mv = (over = {}) => ({
  date: '2026-01-10',
  bookedDate: '2026-01-10',
  concept: 'Pago con tarjeta',
  detail: '',
  merchant: 'Comercio Demo',
  reference: null,
  kind: 'card',
  amount: -10,
  fee: 0,
  currency: 'EUR',
  balance: null,
  account: null,
  source: 'bbva',
  raw: '',
  ...over,
});

describe('bankNoiseClassifier — ruido que NO es gasto doméstico', () => {
  it('ignora patas de FX, cripto, ahorro y traspasos internos', () => {
    // Son el 52% de un extracto real de Revolut. Importarlos como gasto
    // destrozaría la tasa de ahorro y el objetivo anual.
    for (const kind of ['fx_exchange', 'crypto_transfer', 'savings_transfer', 'internal_transfer']) {
      expect(classifyMovementIntent(mv({ kind })).intent).toBe('ignore');
    }
  });

  it('ignora la financiación de un bróker, que Trazza ya cuenta como cartera', () => {
    // Un "Aporte de dinero a DeGiro" importado como gasto contaría el MISMO
    // euro dos veces: una como patrimonio y otra como gasto.
    const m = mv({ kind: 'transfer_out', merchant: 'Aporte de dinero a DeGiro', amount: -200 });
    expect(classifyMovementIntent(m)).toMatchObject({ intent: 'ignore', reason: 'broker_funding' });
  });

  it('detecta las cuentas propias porque aparecen en AMBOS sentidos', () => {
    const movements = [
      mv({ kind: 'transfer_in', merchant: 'De Titular Demo', amount: 100 }),
      mv({ kind: 'transfer_out', merchant: 'TITULAR DEMO', amount: -100 }),
      mv({ kind: 'transfer_out', merchant: 'Persona Ajena', amount: -20 }),
    ];
    const own = detectOwnCounterparties(movements);
    expect(own.has('titular demo')).toBe(true);
    expect(own.has('persona ajena')).toBe(false);
  });

  it('la detección de cuenta propia es insensible a mayúsculas y acentos', () => {
    // Un mismo nombre llegó de 4 formas distintas en un export real.
    const movements = [
      mv({ kind: 'transfer_in', merchant: 'De Ernésto Demó', amount: 50 }),
      mv({ kind: 'transfer_out', merchant: 'ERNESTO DEMO', amount: -50 }),
    ];
    expect(detectOwnCounterparties(movements).size).toBe(1);
  });

  it('acepta nombres declarados por el usuario además de los detectados', () => {
    const m = mv({ kind: 'transfer_out', merchant: 'Mi Otra Cuenta', amount: -300 });
    expect(classifyMovementIntent(m, { ownerNames: ['mi otra cuenta'] }).intent).toBe('ignore');
  });
});

describe('bankNoiseClassifier — lo que sí es gasto o ingreso', () => {
  it('una compra con tarjeta es gasto y una nómina es ingreso', () => {
    expect(classifyMovementIntent(mv()).intent).toBe('expense');
    expect(classifyMovementIntent(mv({ kind: 'payroll', amount: 1500 })).intent).toBe('income');
  });

  it('el signo manda cuando el banco no da más pistas', () => {
    expect(classifyMovementIntent(mv({ kind: 'other', amount: -5 })).intent).toBe('expense');
    expect(classifyMovementIntent(mv({ kind: 'other', amount: 5 })).intent).toBe('income');
  });

  it('una tarjeta en positivo es una devolución, no un gasto negativo', () => {
    expect(classifyMovementIntent(mv({ kind: 'card', amount: 25.4 })).intent).toBe('income');
  });
});

describe('bankNoiseClassifier — lo que NO se puede decidir solo', () => {
  it('marca la recarga para revisión en vez de adivinar', () => {
    // 3 de 26 "Recargas" de un export real eran la nómina de una empresa y el
    // resto traspasos del propio usuario: adivinar fallaría el 12% de las veces.
    const r = classifyMovementIntent(mv({ kind: 'topup', amount: 1000, merchant: 'Empresa Demo SL' }));
    expect(r).toMatchObject({ intent: 'ignore', needsReview: true });
  });

  it('una transferencia a un tercero se importa pero pide confirmación', () => {
    const r = classifyMovementIntent(mv({ kind: 'transfer_out', merchant: 'Persona Ajena', amount: -30 }));
    expect(r).toMatchObject({ intent: 'expense', needsReview: true });
  });

  it('resume los intents para la cabecera del preview', () => {
    const classified = classifyStatement([
      mv(), mv({ kind: 'payroll', amount: 900 }), mv({ kind: 'fx_exchange' }),
    ]);
    expect(summarizeIntents(classified)).toMatchObject({ expense: 1, income: 1, ignore: 1 });
  });
});

describe('merchantRules — categorización determinista', () => {
  it('reconoce comercios españoles habituales', () => {
    expect(categorizeMerchant('Lidl Alicante', 'expense')).toBe('groceries');
    expect(categorizeMerchant('IBERDROLA CLIENTES', 'expense')).toBe('utilities');
    expect(categorizeMerchant('DAZN Limited', 'expense')).toBe('subscriptions');
    expect(categorizeMerchant('Repsol Waylet', 'expense')).toBe('transport');
    expect(categorizeMerchant('Abono de nómina', 'income')).toBe('salary');
  });

  it('devuelve null cuando no está seguro, en vez de inventar', () => {
    // Una categoría equivocada es peor que ninguna: el usuario no revisa lo
    // que ya parece resuelto.
    expect(categorizeMerchant('ZXQ 8871', 'expense')).toBeNull();
    expect(categorizeMerchant('', 'expense')).toBeNull();
  });

  it('no confunde Uber Eats con Uber', () => {
    expect(categorizeMerchant('Uber Eats', 'expense')).toBe('restaurants');
    expect(categorizeMerchant('Uber BV', 'expense')).toBe('transport');
  });

  it('junta los comercios pendientes SIN repetir (es el input de la IA)', () => {
    const classified = classifyStatement([
      mv({ merchant: 'Zxq Uno' }), mv({ merchant: 'Zxq Uno' }),
      mv({ merchant: 'Lidl Alicante' }),
      mv({ kind: 'fx_exchange', merchant: 'Conversión a USD' }),
    ]);
    // 'Lidl' ya lo resuelve una regla y el FX está ignorado: solo queda uno.
    expect(collectUncategorizedMerchants(classified)).toEqual(['Zxq Uno']);
  });
});

describe('bankImportMapper — dedupe MULTISET', () => {
  const opts = { userId: 'u1', bank: 'bbva' };

  it('dos movimientos idénticos generan DOS filas distintas', () => {
    // Dos compras de 4,20 € el mismo día en el mismo sitio son dos compras.
    // Medido: 16 grupos así en un extracto real (22 filas que un Set se comería).
    const classified = classifyStatement([mv({ amount: -4.2 }), mv({ amount: -4.2 })]);
    const { rows } = buildBankImportPlan(classified, opts);
    expect(rows).toHaveLength(2);
    expect(rows[0].import_key).not.toBe(rows[1].import_key);
  });

  it('reimportar el mismo extracto no inserta nada', () => {
    const classified = classifyStatement([mv({ amount: -4.2 }), mv({ amount: -4.2 }), mv({ merchant: 'Otro' })]);
    const first = buildBankImportPlan(classified, opts);
    const existingKeys = new Set(first.rows.map((r) => r.import_key));
    const second = buildBankImportPlan(classified, { ...opts, existingKeys });
    expect(second.rows).toHaveLength(0);
    expect(second.duplicates).toBe(3);
  });

  it('un extracto solapado inserta SOLO lo nuevo', () => {
    const old = classifyStatement([mv({ date: '2026-01-01', merchant: 'A' })]);
    const overlapping = classifyStatement([
      mv({ date: '2026-01-01', merchant: 'A' }),
      mv({ date: '2026-02-01', merchant: 'B' }),
    ]);
    const existingKeys = new Set(buildBankImportPlan(old, opts).rows.map((r) => r.import_key));
    const plan = buildBankImportPlan(overlapping, { ...opts, existingKeys });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].notes).toBe('B');
    expect(plan.duplicates).toBe(1);
  });

  it('la clave distingue el ordinal de ocurrencia', () => {
    const m = mv();
    expect(buildImportKey(m, 'bbva', 0)).not.toBe(buildImportKey(m, 'bbva', 1));
  });
});

describe('bankImportMapper — filas generadas', () => {
  const opts = { userId: 'u1', bank: 'revolut' };

  it('el importe se guarda POSITIVO y el sentido va en el type', () => {
    // expense_entries tiene CHECK (amount > 0): el signo lo lleva `type`.
    const { rows } = buildBankImportPlan(classifyStatement([mv({ amount: -25.4 })]), opts);
    expect(rows[0]).toMatchObject({ type: 'expense', amount: 25.4, source: 'bank_import' });
  });

  it('no crea filas para el ruido', () => {
    const classified = classifyStatement([mv({ kind: 'fx_exchange' }), mv()]);
    const plan = buildBankImportPlan(classified, opts);
    expect(plan.rows).toHaveLength(1);
    expect(plan.ignored).toBe(1);
  });

  it('la comisión es un gasto APARTE, no se funde en el importe', () => {
    // Verificado en el extracto real: el saldo la descuenta por separado.
    const { rows } = buildBankImportPlan(classifyStatement([mv({ amount: -100, fee: 1.5 })]), opts);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([1.5, 100]);
    expect(rows[1].import_key.endsWith('|fee')).toBe(true);
  });

  it('respeta las filas que el usuario desmarca en el preview', () => {
    const classified = classifyStatement([mv(), mv({ merchant: 'Otro' })]);
    const plan = buildBankImportPlan(classified, { ...opts, excludedIndexes: new Set([0]) });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].notes).toBe('Otro');
  });

  it('nunca manda recurrencia de plantilla (un gasto importado no se repite solo)', () => {
    const { rows } = buildBankImportPlan(classifyStatement([mv()]), opts);
    expect(rows[0].recurrence).toBe('none');
    expect(rows[0].recurring_source_id).toBeUndefined();
  });
});

describe('buildPreviewRows — lo que ve el usuario', () => {
  it('marca duplicados, revisiones y categoría propuesta', () => {
    const classified = classifyStatement([
      mv({ merchant: 'Lidl Alicante', amount: -12 }),
      mv({ kind: 'topup', amount: 500, merchant: 'Empresa Demo SL' }),
    ]);
    const preview = buildPreviewRows(classified, { bank: 'bbva' });
    expect(preview[0]).toMatchObject({ category: 'groceries', intent: 'expense', isDuplicate: false });
    expect(preview[1]).toMatchObject({ intent: 'ignore', needsReview: true });
  });
});

describe('detectBankStatement — enrutado', () => {
  it('no reconoce un texto cualquiera', () => {
    expect(detectBankStatement('hola,mundo\n1,2')).toBeNull();
    expect(detectBankStatement('')).toBeNull();
  });

  it('reconoce un extracto de Revolut y devuelve sus movimientos', () => {
    const csv = [
      'Tipo,Producto,Fecha de inicio,Fecha de finalización,Descripción,Importe,Comisión,Divisa,State,Saldo',
      'Pago con tarjeta,Actual,2026-01-06 12:30:00,2026-01-06 12:30:00,Super Demo,-25.40,0.00,EUR,COMPLETADO,974.60',
    ].join('\n');
    expect(detectBankStatement(csv)).toMatchObject({ bank: 'revolut' });
  });
});
