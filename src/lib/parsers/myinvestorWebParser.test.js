import { describe, it, expect } from 'vitest';
import {
  parseMyInvestorWeb, explotarLineas, nombreDelFondo,
  parseImporteEuropeo, divisaDe, tieneOrdenes,
} from './myinvestorWebParser';
import { detectBrokerCsv } from './brokerDetect';
import { parseMyInvestorCSV } from './myinvestorParser';
import { parseMyInvestorAny } from './myinvestorAny';

/* Fixture SINTÉTICO: reproduce la ESTRUCTURA de la pantalla (composición,
   órdenes de 5 líneas, movimientos de 2) con fondos e importes inventados. Un
   extracto real trae la trayectoria patrimonial de una persona y no se
   commitea, ni siquiera anonimizado. */
const orden = (nombre, importe, participaciones) =>
  [`Suscripción Fondos de Inversión ${nombre}`, importe, 'Puntual', 'Finalizada', `${participaciones} participaciones`];

const PANTALLA = [
  // ── Composición: la foto de hoy, NO son transacciones ──
  'Valor de mercado', '1.000,00 €', '-10,00 €', '·', '1,00 %',
  'Invertido', '1.010,00 €',
  'Composición', 'Órdenes', 'Movimientos',
  'Acme Global Equity Index Fund Clase S', '600,00 €', '-4,00 €', '·', '0,66 %',
  'Beta Euro Bond Index Fund Eur Hedged', '400,00 €', '-6,00 €', '·', '1,48 %',
  // ── Órdenes: con participaciones ──
  '05/03/2026',
  ...orden('Acme Global Equity Index Fund Clase S', '50,00 €', '2,5'),
  ...orden('Beta Euro Bond Index Fund EUR Hedged', '30,00 US$', '0,6'),
  '12/01/2026',
  ...orden('Acme Global Equity Index Fund Clase S', '20,00 €', '1,25'),
  // ── Movimientos: los MISMOS hechos, más lo que sólo vive aquí ──
  '07/03/2026',
  'Suscripcion Iic ACME GLOBAL EQUITY INDEX', '49,90 €',
  'Suscripcion Iic BETA EURO BOND INDEX EUR', '29,80 €',
  '02/03/2026',
  'Liquidac. Intereses PERIODO 02/02/2026 02/03/2026', '0,12 €',
  '01/03/2026',
  'Abono Por Traspaso Aportacion a mi cartera', '500,00 €',
].join('\n');

describe('parseMyInvestorWeb — la pantalla de una cartera gestionada', () => {
  const tx = parseMyInvestorWeb(PANTALLA);
  const compras = tx.filter((r) => r.type === 'BUY');

  it('ignora la Composición: son valores de mercado, no operaciones', () => {
    // 600,00 y 400,00 son los saldos de la foto; no pueden aparecer como compras
    expect(tx.some((r) => Math.abs(r.total) === 600 || Math.abs(r.total) === 400)).toBe(false);
  });

  it('lee las tres órdenes con sus participaciones y su precio', () => {
    expect(compras).toHaveLength(3);
    expect(compras[0]).toMatchObject({
      fecha: '05-03-2026', type: 'BUY', cantidad: 2.5, precio: 20, total: -50, moneda: 'EUR',
    });
    expect(compras[0].producto).toBe('Acme Global Equity Index Fund Clase S');
  });

  it('respeta la divisa que declara cada orden', () => {
    expect(compras[1]).toMatchObject({ moneda: 'USD', cantidad: 0.6, precio: 50 });
  });

  it('arrastra la fecha de la cabecera hacia abajo', () => {
    expect(compras[2].fecha).toBe('12-01-2026');
  });

  it('NO duplica: con Órdenes presentes, las suscripciones de Movimientos se descartan', () => {
    // 49,90 y 29,80 son los mismos hechos ya contados como 50,00 y 30,00
    expect(tx.some((r) => Math.abs(r.total) === 49.9 || Math.abs(r.total) === 29.8)).toBe(false);
  });

  it('sí recoge de Movimientos lo que no existe en Órdenes', () => {
    expect(tx.find((r) => r.type === 'FEE')).toMatchObject({ fecha: '02-03-2026', total: 0.12 });
    expect(tx.find((r) => r.type === 'TRANSFER')).toMatchObject({ fecha: '01-03-2026', total: 500 });
  });

  it('no se come la fecha aunque la descripción de los intereses lleve dos dentro', () => {
    // "PERIODO 02/02/2026 02/03/2026" no puede convertirse en cabecera
    expect(tx.find((r) => r.type === 'TRANSFER').fecha).toBe('01-03-2026');
  });
});

describe('parseMyInvestorWeb — sólo Movimientos (sin Órdenes)', () => {
  const SOLO_MOV = [
    '07/03/2026',
    'Suscripcion Iic ACME GLOBAL EQUITY INDEX', '49,90 €',
    'Suscripcion Iic BETA EURO BOND INDEX EUR', '29,80 €',
  ].join('\n');

  it('cae a representación monetaria y marca noQuote', () => {
    const tx = parseMyInvestorWeb(SOLO_MOV);
    expect(tx).toHaveLength(2);
    expect(tx[0]).toMatchObject({
      fecha: '07-03-2026', type: 'BUY', cantidad: 49.9, precio: 1, total: -49.9, noQuote: true,
    });
    expect(tx[0].producto).toBe('ACME GLOBAL EQUITY INDEX');
  });
});

describe('explotarLineas — renglones fusionados al pegar desde un chat', () => {
  it('saca la cabecera de fecha escondida al final de una frase', () => {
    expect(explotarLineas('4,27 %. Te dejo las ordenes: 05/03/2026')).toContain('05/03/2026');
  });

  it('separa las participaciones pegadas a la prosa siguiente', () => {
    const out = explotarLineas('2,5 participaciones. Y los movimientos: 07/03/2026');
    expect(out).toContain('2,5 participaciones');
    expect(out).toContain('07/03/2026');
  });

  it('NO trocea una descripción que lleva fechas dentro', () => {
    const l = 'Liquidac. Intereses PERIODO 02/02/2026 02/03/2026';
    expect(explotarLineas(l)).toEqual([l]);
  });
});

describe('utilidades', () => {
  it('parseImporteEuropeo entiende el formato de la pantalla', () => {
    expect(parseImporteEuropeo('1.234,56 €')).toBe(1234.56);
    expect(parseImporteEuropeo('30,00 US$')).toBe(30);
  });

  it('divisaDe reconoce lo que declara el importe', () => {
    expect(divisaDe('30,00 US$')).toBe('USD');
    expect(divisaDe('30,00 €')).toBe('EUR');
    expect(divisaDe('30,00')).toBe('EUR');
  });

  it('nombreDelFondo quita la etiqueta de la operación', () => {
    expect(nombreDelFondo('Suscripción Fondos de Inversión Acme Global Equity')).toBe('Acme Global Equity');
    expect(nombreDelFondo('Suscripcion Iic ACME GLOBAL EQUITY INDEX')).toBe('ACME GLOBAL EQUITY INDEX');
  });

  it('tieneOrdenes distingue las dos secciones', () => {
    expect(tieneOrdenes(PANTALLA)).toBe(true);
    expect(tieneOrdenes('Suscripcion Iic ACME\n49,90 €')).toBe(false);
  });
});

describe('detectBrokerCsv enruta la pantalla al parser nativo', () => {
  it('reconoce el pegado como MyInvestor y no lo manda a la IA', () => {
    expect(detectBrokerCsv(PANTALLA)).toMatchObject({ broker: 'myinvestor' });
  });

  it('no secuestra un texto cualquiera', () => {
    expect(detectBrokerCsv('hola, esto no es un extracto de nada')).toBeNull();
  });
});

// Regresión 2026-10-02: la detección (detectBrokerCsv) reconocía este texto
// como MyInvestor gracias al lector de la WEB, pero el importador probaba antes
// el del CSV/XLSX, que LANZA "Formato MyInvestor no reconocido" en vez de
// devolver vacío, y nunca llegaba a la web: el usuario veía un error genérico y
// el diálogo de la IA se cerraba. Una sola función prueba ambos en orden y la
// usan los dos lados.
describe('parseMyInvestorAny — detección e importador no pueden discrepar', () => {
  it('el lector CSV, por sí solo, rechaza el texto de la web (la causa)', () => {
    expect(() => parseMyInvestorCSV(PANTALLA)).toThrow(/no reconocido/i);
  });

  it('cae al lector de la web y devuelve sus operaciones', () => {
    const rows = parseMyInvestorAny(PANTALLA);
    expect(rows.filter((r) => r.type === 'BUY').length).toBeGreaterThan(0);
    expect(rows).toEqual(parseMyInvestorWeb(PANTALLA));
  });

  it('lo que la detección acepta como MyInvestor, el importador lo lee', () => {
    expect(detectBrokerCsv(PANTALLA)?.broker).toBe('myinvestor');
    expect(() => parseMyInvestorAny(PANTALLA)).not.toThrow();
  });

  it('si ningún lector entiende el texto, conserva el error ORIGINAL del CSV', () => {
    expect(() => parseMyInvestorAny('hola;esto;no;es;myinvestor\n1;2;3;4;5')).toThrow(/no reconocido/i);
  });
});
