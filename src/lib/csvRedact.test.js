import { describe, it, expect } from 'vitest';
import { redactCsvSample } from './csvRedact';

describe('redactCsvSample — preserva estructura, elimina PII', () => {
  it('conserva ISINs (12 chars) pero redacta IBANs (15+)', () => {
    const input = [
      'Fecha,ISIN,Descripción,Variación',
      '26-03-2026,US30303M1027,"Compra 3 Meta@556,49 USD",ES9121000418450200051332',
    ].join('\n');

    const out = redactCsvSample(input);

    expect(out).toContain('US30303M1027');           // ISIN intact
    expect(out).toContain('[iban]');                  // IBAN redacted
    expect(out).not.toContain('ES9121000418450200051332');
  });

  it('redacta emails y cuentas IBKR', () => {
    const input = [
      'Date,Account,Description',
      '2026-01-01,U1234567,Dividend for john.doe@example.com',
    ].join('\n');

    const out = redactCsvSample(input);

    expect(out).toContain('[account]');
    expect(out).toContain('[email]');
    expect(out).not.toContain('U1234567');
    expect(out).not.toContain('john.doe@example.com');
  });

  it('redacta secuencias de 9+ dígitos pero conserva importes y fechas', () => {
    const input = [
      'Fecha,Ref,Importe',
      '26-03-2026,123456789012,"1.669,47"',
    ].join('\n');

    const out = redactCsvSample(input);

    expect(out).toContain('[num]');
    expect(out).not.toContain('123456789012');
    expect(out).toContain('26-03-2026');
    expect(out).toContain('1.669,47');
  });

  it('trunca a cabecera + N líneas indicando cuántas se omiten', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `26-03-2026,row${i},"1,00"`);
    const input = ['Fecha,Producto,Importe', ...rows].join('\n');

    const out = redactCsvSample(input, 40);
    const outLines = out.split('\n');

    expect(outLines[0]).toBe('Fecha,Producto,Importe');
    expect(outLines).toHaveLength(42); // header + 40 rows + omission note
    expect(out).toContain('more rows omitted');
  });

  it('entradas vacías o no-string devuelven cadena vacía', () => {
    expect(redactCsvSample('')).toBe('');
    expect(redactCsvSample(null)).toBe('');
    expect(redactCsvSample(undefined)).toBe('');
  });
});
