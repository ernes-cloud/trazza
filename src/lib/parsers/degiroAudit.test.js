import { describe, it, expect } from 'vitest';
import { auditDegiroLedger, listUnrecognizedDegiroRows, classifyDegiroDescription } from './degiroParser.js';

const HDR = 'Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden';
const csv = (...rows) => [HDR, ...rows].join('\n');

// Coherent EUR ledger, newest-first: each saldo = older saldo + variación.
//   oldest: deposit +1000 → saldo 1000
//   then:   buy    -300  → saldo 700
//   newest: fee    -2    → saldo 698
const LEDGER_OK = csv(
  `03-01-2026,10:00,03-01-2026,,,Comisión de conectividad,,EUR,"-2,00",EUR,"698,00",`,
  `02-01-2026,10:00,02-01-2026,ASML,NL0010273215,"Compra 1 ASML@300,00 EUR (NL0010273215)",,EUR,"-300,00",EUR,"700,00",o1`,
  `01-01-2026,09:00,01-01-2026,,,Ingreso,,EUR,"1000,00",EUR,"1000,00",`,
);

describe('auditDegiroLedger — reconciliación contra el saldo del propio CSV', () => {
  it('un ledger coherente reconcilia al 100%', () => {
    const audit = auditDegiroLedger(LEDGER_OK);
    expect(audit).not.toBeNull();
    expect(audit.checked).toBe(2);
    expect(audit.matched).toBe(2);
    expect(audit.mismatches).toHaveLength(0);
  });

  it('un importe mal parseado rompe la cadena y señala la línea', () => {
    // The buy amount is corrupted (-3,00 instead of -300,00) → its balance no longer follows
    const corrupt = csv(
      `03-01-2026,10:00,03-01-2026,,,Comisión de conectividad,,EUR,"-2,00",EUR,"698,00",`,
      `02-01-2026,10:00,02-01-2026,ASML,NL0010273215,"Compra 1 ASML@300,00 EUR (NL0010273215)",,EUR,"-3,00",EUR,"700,00",o1`,
      `01-01-2026,09:00,01-01-2026,,,Ingreso,,EUR,"1000,00",EUR,"1000,00",`,
    );
    const audit = auditDegiroLedger(corrupt);
    expect(audit.matched).toBe(1);
    expect(audit.mismatches).toHaveLength(1);
    expect(audit.mismatches[0].line).toBe(3); // the corrupted buy row (header = line 1)
    expect(audit.mismatches[0].currency).toBe('EUR');
  });

  it('cadenas por divisa independientes (EUR y USD entrelazados)', () => {
    const multi = csv(
      `04-01-2026,10:00,04-01-2026,META,US30303M1027,"Compra 1 Meta@100,00 USD (US30303M1027)",,USD,"-100,00",USD,"400,00",o2`,
      `03-01-2026,10:00,03-01-2026,,,Comisión de conectividad,,EUR,"-2,00",EUR,"698,00",`,
      `02-01-2026,10:00,02-01-2026,,,Ingreso Cambio de Divisa,,USD,"500,00",USD,"500,00",o2`,
      `01-01-2026,09:00,01-01-2026,,,Ingreso,,EUR,"700,00",EUR,"700,00",`,
    );
    const audit = auditDegiroLedger(multi);
    expect(audit.checked).toBe(2); // one EUR pair + one USD pair
    expect(audit.matched).toBe(2);
  });

  it('un archivo ordenado de antiguo a reciente también reconcilia (detección de dirección)', () => {
    const reversed = csv(
      `01-01-2026,09:00,01-01-2026,,,Ingreso,,EUR,"1000,00",EUR,"1000,00",`,
      `02-01-2026,10:00,02-01-2026,ASML,NL0010273215,"Compra 1 ASML@300,00 EUR (NL0010273215)",,EUR,"-300,00",EUR,"700,00",o1`,
      `03-01-2026,10:00,03-01-2026,,,Comisión de conectividad,,EUR,"-2,00",EUR,"698,00",`,
    );
    const audit = auditDegiroLedger(reversed);
    expect(audit.matched).toBe(2);
    expect(audit.mismatches).toHaveLength(0);
  });

  it('CSV sin columna de saldo utilizable devuelve null (no audita a ciegas)', () => {
    const noBalance = csv(
      `02-01-2026,10:00,02-01-2026,,,Ingreso,,EUR,"1000,00",,,`,
    );
    expect(auditDegiroLedger(noBalance)).toBeNull();
    expect(auditDegiroLedger('')).toBeNull();
  });
});

describe('listUnrecognizedDegiroRows — filas OTHER visibles', () => {
  it('lista descripciones sin keyword y omite las reconocidas', () => {
    const input = csv(
      `03-01-2026,10:00,03-01-2026,,,Conversión de fondo del mercado monetario,,EUR,"0,50",EUR,"698,50",`,
      `02-01-2026,10:00,02-01-2026,ASML,NL0010273215,"Compra 1 ASML@300,00 EUR (NL0010273215)",,EUR,"-300,00",EUR,"698,00",o1`,
    );
    const rows = listUnrecognizedDegiroRows(input);
    expect(rows).toHaveLength(1);
    expect(rows[0].descripcion).toContain('mercado monetario');
    expect(rows[0].line).toBe(2);
  });

  it('CSV totalmente reconocido devuelve lista vacía', () => {
    expect(listUnrecognizedDegiroRows(LEDGER_OK)).toHaveLength(0);
  });
});

describe('classifyDegiroDescription — exportada y consistente', () => {
  it('clasifica igual que el parser (muestras por tipo)', () => {
    expect(classifyDegiroDescription('Retirada Cambio de Divisa')).toBe('CURRENCY_EXCHANGE');
    expect(classifyDegiroDescription('Compra 3 Meta@100 USD')).toBe('BUY');
    expect(classifyDegiroDescription('Verkauf 4 ASML@1.139,8 EUR')).toBe('SELL');
    expect(classifyDegiroDescription('Dividendbelasting')).toBe('TAX');
    expect(classifyDegiroDescription('Dividendo')).toBe('DIVIDEND');
    expect(classifyDegiroDescription('Comisión de conectividad')).toBe('FEE');
    expect(classifyDegiroDescription('Degiro Cash Sweep Transfer')).toBe('CASH');
    expect(classifyDegiroDescription('flatex Deposit')).toBe('TRANSFER');
    expect(classifyDegiroDescription('Algo totalmente desconocido')).toBe('OTHER');
  });
});
