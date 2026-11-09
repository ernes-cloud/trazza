import { describe, it, expect } from 'vitest';
import { redactHeaderLine, REDACTED } from './headerLineRedact.js';

describe('redactHeaderLine', () => {
  it('tapa el titular de la fila de metadatos de MyInvestor (caso real, nombre inventado)', () => {
    expect(redactHeaderLine(';;;TITULAR:;MARIA PEREZ LOPEZ')).toBe(`;;;TITULAR:;${REDACTED}`);
  });

  it('deja intacta una cabecera de columnas normal (DeGiro)', () => {
    const h = 'Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden';
    expect(redactHeaderLine(h)).toBe(h);
  });

  it('tapa también "ETIQUETA: valor" dentro de una misma celda', () => {
    expect(redactHeaderLine('Cliente: Juan Gomez;Cuenta')).toBe(`Cliente: ${REDACTED};Cuenta`);
  });

  it('no confunde una URL con una etiqueta', () => {
    expect(redactHeaderLine('https://example.com/export;Fecha')).toBe('https://example.com/export;Fecha');
  });

  it('aplica además las redacciones de las muestras (email, IBAN)', () => {
    expect(redactHeaderLine('Titular;ana@example.com;ES9121000418450200051332'))
      .toBe('Titular;[email];[iban]');
  });

  it('tolera vacíos y no excede 200 caracteres', () => {
    expect(redactHeaderLine(null)).toBe('');
    expect(redactHeaderLine('A;'.repeat(300)).length).toBeLessThanOrEqual(200);
  });
});
