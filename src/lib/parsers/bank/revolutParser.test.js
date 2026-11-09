import { describe, it, expect } from 'vitest';
import { parseRevolutStatement, isRevolutStatement, RevolutParseError } from './revolutParser';
import { auditRunningBalance } from './bankCsv';

/**
 * FIXTURE SINTÉTICO — ninguna fila procede de un extracto real.
 *
 * Reproduce la ESTRUCTURA medida en un export real (242 filas, 28 meses,
 * es-ES): comercios, contrapartes, importes y saldos son inventados. Ver el
 * encabezado de bbvaParser.test.js para el porqué de no redactar un volcado.
 *
 * Casos representados (todos observados en el export real):
 *  - orden VIEJO→NUEVO (al revés que BBVA)
 *  - Comisión en columna aparte, NO incluida en Importe
 *  - "Cambio" = patas de conversión de divisa Y transferencias de cripto
 *  - "Transferir" = P2P, hucha de ahorro y fondos monetarios en el mismo Tipo
 *  - "Recargas" ambiguas: traspaso propio Y nómina de una empresa
 *  - descripciones mezclando español e inglés en un export es-ES
 *  - prefijos direccionales ("To ", "Pago de ") que parten un mismo comercio
 *  - fila no liquidada, que no movió dinero
 */
const HEADER = 'Tipo,Producto,Fecha de inicio,Fecha de finalización,Descripción,Importe,Comisión,Divisa,State,Saldo';

const FIXTURE = [
  HEADER,
  'Recargas,Actual,2026-01-05 10:00:00,2026-01-05 10:00:02,Recarga con open banking,1000.00,0.00,EUR,COMPLETADO,1000.00',
  'Pago con tarjeta,Actual,2026-01-06 12:30:00,2026-01-07 03:00:00,Super Demo,-25.40,0.00,EUR,COMPLETADO,974.60',
  'Pago con tarjeta,Actual,2026-01-06 20:15:00,2026-01-06 20:15:00,Streaming Demo,-9.99,0.00,EUR,COMPLETADO,964.61',
  'Cambio,Actual,2026-01-08 09:00:00,2026-01-08 09:00:00,Conversión a USD,-100.00,1.50,EUR,COMPLETADO,863.11',
  'Cambio,Actual,2026-01-09 09:00:00,2026-01-09 09:00:00,Transfer to Revolut Digital Assets Europe Ltd,-50.00,0.00,EUR,COMPLETADO,813.11',
  'Transferir,Actual,2026-01-10 08:00:00,2026-01-10 08:00:00,Savings Vault topup,-200.00,0.00,EUR,COMPLETADO,613.11',
  'Transferir,Actual,2026-01-11 08:00:00,2026-01-11 08:00:00,To Fondos Monetarios Flexibles,-150.00,0.00,EUR,COMPLETADO,463.11',
  'Transferir,Actual,2026-01-12 08:00:00,2026-01-12 08:00:00,From Fondos Monetarios Flexibles,150.00,0.00,EUR,COMPLETADO,613.11',
  'Transferir,Actual,2026-01-13 19:00:00,2026-01-13 19:00:00,To Persona Demo,-30.00,0.00,EUR,COMPLETADO,583.11',
  'Cobro,Actual,2026-01-14 06:00:00,2026-01-14 06:00:00,Tarifa del plan Premium,-9.99,0.00,EUR,COMPLETADO,573.12',
  'Reembolso de tarjeta,Actual,2026-01-15 11:00:00,2026-01-15 11:00:00,Super Demo,25.40,0.00,EUR,COMPLETADO,598.52',
  'Recargas,Actual,2026-01-25 07:00:00,2026-01-25 07:00:00,Pago de EMPRESA DEMO SL,1500.00,0.00,EUR,COMPLETADO,2098.52',
  'Pago con tarjeta,Actual,2026-01-26 13:00:00,2026-01-26 13:00:00,Cafeteria Demo,-3.50,0.00,EUR,DECLINADO,2098.52',
].join('\n');

const parsed = parseRevolutStatement(FIXTURE);
const byDetail = (needle) => parsed.find((m) => m.detail.includes(needle));

describe('parseRevolutStatement — estructura del export', () => {
  it('parsea los movimientos liquidados y descarta los que no movieron dinero', () => {
    // La fila DECLINADO no llegó a tocar el saldo: importarla cobraría al
    // usuario un pago que su banco rechazó.
    expect(parsed).toHaveLength(12);
    expect(parsed.some((m) => m.detail.includes('Cafeteria Demo'))).toBe(false);
  });

  it('lanza un error tipado si el texto no es un extracto de Revolut', () => {
    expect(() => parseRevolutStatement('a,b\n1,2')).toThrow(RevolutParseError);
    expect(isRevolutStatement('a,b\n1,2')).toBe(false);
    expect(isRevolutStatement(FIXTURE)).toBe(true);
  });

  it('usa la fecha de INICIO y guarda la de finalización', () => {
    // 56 de 242 filas reales liquidan en un día natural posterior: la elección
    // mueve esos movimientos de mes.
    const card = byDetail('Super Demo');
    expect(card.date).toBe('2026-01-06');
    expect(card.bookedDate).toBe('2026-01-07');
  });

  it('descarta la hora (entry_date es un DATE, no un timestamp)', () => {
    expect(parsed.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date))).toBe(true);
  });

  it('conserva el producto como cuenta', () => {
    expect(parsed.every((m) => m.account === 'Actual')).toBe(true);
  });
});

describe('parseRevolutStatement — comisión separada del importe', () => {
  it('no la suma al importe: son dos magnitudes distintas', () => {
    const fx = byDetail('Conversión a USD');
    expect(fx.amount).toBe(-100);
    expect(fx.fee).toBe(1.5);
  });

  it('las filas sin comisión llevan 0, no null', () => {
    expect(byDetail('Super Demo').fee).toBe(0);
  });
});

describe('parseRevolutStatement — clasificación estructural', () => {
  it('separa las patas de FX del gasto real', () => {
    expect(byDetail('Conversión a USD').kind).toBe('fx_exchange');
  });

  it('detecta la cripto aunque el banco la etiquete como "Cambio"', () => {
    // "Transfer to Revolut Digital Assets Europe Ltd" llega con Tipo=Cambio:
    // leer solo el Tipo la enterraría entre las conversiones de divisa.
    expect(byDetail('Digital Assets').kind).toBe('crypto_transfer');
  });

  it('reconoce los productos de ahorro dentro de "Transferir"', () => {
    // Hucha y fondos monetarios comparten Tipo con un P2P normal: el dinero no
    // se ha gastado, ha cambiado de bolsillo.
    expect(byDetail('Savings Vault topup').kind).toBe('savings_transfer');
    expect(byDetail('To Fondos Monetarios').kind).toBe('savings_transfer');
    expect(byDetail('From Fondos Monetarios').kind).toBe('savings_transfer');
  });

  it('un P2P normal sí es una transferencia, con el sentido en el signo', () => {
    expect(byDetail('To Persona Demo').kind).toBe('transfer_out');
  });

  it('distingue cuota, devolución de compra y recarga', () => {
    expect(byDetail('Tarifa del plan Premium').kind).toBe('fee');
    expect(parsed.find((m) => m.amount === 25.4).kind).toBe('card_refund');
    expect(byDetail('Recarga con open banking').kind).toBe('topup');
  });

  it('NO decide si una recarga es nómina o traspaso propio', () => {
    // En el export real 3 "Recargas" eran la nómina de una empresa y el resto
    // traspasos del propio usuario. El parser no puede distinguirlas y no debe
    // fingir que sí: ambas salen como `topup` y decide el clasificador de ruido.
    const topups = parsed.filter((m) => m.kind === 'topup');
    expect(topups).toHaveLength(2);
    expect(new Set(topups.map((m) => m.kind)).size).toBe(1);
  });
});

describe('parseRevolutStatement — comercio', () => {
  it('quita el prefijo direccional para no partir un comercio en dos claves', () => {
    // "To Fondos Monetarios" y "From Fondos Monetarios" son la MISMA
    // contraparte; conservar el prefijo duplicaría la clave de la caché
    // comercio→categoría y hundiría su tasa de acierto.
    expect(byDetail('To Fondos Monetarios').merchant).toBe('Fondos Monetarios Flexibles');
    expect(byDetail('From Fondos Monetarios').merchant).toBe('Fondos Monetarios Flexibles');
    expect(byDetail('Pago de EMPRESA DEMO SL').merchant).toBe('EMPRESA DEMO SL');
  });

  it('deja intacto un comercio que no lleva prefijo', () => {
    expect(byDetail('Streaming Demo').merchant).toBe('Streaming Demo');
  });
});

describe('auditRunningBalance — Revolut', () => {
  it('reconcilia restando la comisión y detecta el orden viejo→nuevo', () => {
    // Sin restar la comisión, el paso de la conversión a USD descuadra 1,50 €.
    // En el export real: 230/241 pasos sin comisión, 241/241 con ella.
    const audit = auditRunningBalance(parsed);
    expect(audit.ok).toBe(true);
    expect(audit.direction).toBe('asc');
    expect(audit.checked).toBe(11);
  });

  it('descuadra si se ignora la comisión (fija el hallazgo)', () => {
    const withoutFees = parsed.map((m) => ({ ...m, fee: 0 }));
    const audit = auditRunningBalance(withoutFees);
    expect(audit.ok).toBe(false);
  });
});
