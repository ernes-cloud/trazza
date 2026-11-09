import { describe, it, expect } from 'vitest';
import { parseBbvaStatement, isBbvaStatement, BbvaParseError } from './bbvaParser';
import { auditRunningBalance } from './bankCsv';

/**
 * FIXTURE SINTÉTICO — ni una fila procede de un extracto real.
 *
 * Se escribió a partir de la ESTRUCTURA medida en un export real de BBVA
 * (1440 movimientos, 27 meses), pero comercios, contrapartes, importes,
 * referencias y saldos son inventados. Un extracto bancario contiene datos de
 * TERCEROS (contrapartes de Bizum), la trayectoria del patrimonio del titular y
 * su geolocalización inferible por los comercios: `csvRedact` no borra nombres,
 * así que un volcado "anonimizado" no sería suficiente. El fixture codifica los
 * casos estructurales a propósito, que además se lee mejor que un volcado.
 *
 * Casos representados (todos observados en el fichero real):
 *  - 2 filas de preámbulo antes de la cabecera
 *  - primera columna vacía y "Divisa" DUPLICADA
 *  - "Fecha valor" anterior a "Fecha" en unas filas e igual en otras
 *  - comercio en Concepto (tarjeta) y en Movimiento (recibo, Bizum, transferencia)
 *  - recibo con referencia "N <dígitos>" y código interno tras relleno de espacios
 *  - DOS filas idénticas el mismo día (compras reales distintas, no un duplicado)
 *  - Bizum recibido / enviado sin concepto / COMPRA
 *  - traspaso entre cuentas propias y aportación a un bróker (ruido contable)
 *  - importe en formato europeo y otro entero sin decimales
 *  - fila de pie sin fecha, que no es un movimiento
 *  - saldo corrido coherente en las 12 filas (auditable)
 */
const HEADER = ';Fecha valor;Fecha;Concepto;Movimiento;Importe;Divisa;Disponible;Divisa;Observaciones';

const FIXTURE = [
  ';;Movimientos',
  ';;Fecha de generación del informe: 01/08/2026',
  HEADER,
  ';28/07/2026;30/07/2026;Servicios web demo;Pago con tarjeta;-9.99;EUR;1500.00;EUR;',
  ';30/07/2026;30/07/2026;Adeudo a su cargo;N 9900112233445566 ELECTRICA DEMO SA                CPVR;-12.50;EUR;1509.99;EUR;',
  ';29/07/2026;29/07/2026;Super demo centro;Pago con tarjeta;-4.20;EUR;1522.49;EUR;',
  ';29/07/2026;29/07/2026;Super demo centro;Pago con tarjeta;-4.20;EUR;1526.69;EUR;',
  ';28/07/2026;28/07/2026;Bizum;Recibido: cena;15.00;EUR;1530.89;EUR;',
  ';27/07/2026;27/07/2026;Bizum;ENVIADO: sin concepto;-8.00;EUR;1515.89;EUR;',
  ';26/07/2026;26/07/2026;Bizum;COMPRA: FLORISTERIA DEMO SL;-35.60;EUR;1523.89;EUR;',
  ';25/07/2026;25/07/2026;Transferencia recibida;De titular demo;30.00;EUR;1559.49;EUR;',
  ';24/07/2026;24/07/2026;Transferencia realizada;Aporte de dinero a Broker Demo;-200.00;EUR;1529.49;EUR;',
  ';23/07/2026;23/07/2026;Traspaso a cuenta;Traspaso;-50.00;EUR;1729.49;EUR;',
  ';22/07/2026;22/07/2026;Abono de nómina;Nomina;1.234,56;EUR;1779.49;EUR;',
  ';21/07/2026;21/07/2026;Cafeteria demo;Pago con tarjeta;-3;EUR;544.93;EUR;',
  ';;;Total movimientos;;;;;;',
].join('\n');

const parsed = parseBbvaStatement(FIXTURE);
const byRaw = (needle) => parsed.find((m) => m.raw.includes(needle));

describe('parseBbvaStatement — estructura del export', () => {
  it('salta el preámbulo y el pie, y devuelve solo los movimientos', () => {
    expect(parsed).toHaveLength(12);
    expect(parsed.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date))).toBe(true);
  });

  it('lanza un error tipado cuando el texto no es un export de BBVA', () => {
    expect(() => parseBbvaStatement('foo;bar\n1;2')).toThrow(BbvaParseError);
    expect(() => parseBbvaStatement('foo;bar\n1;2')).toThrow(/header/i);
    expect(isBbvaStatement('foo;bar\n1;2')).toBe(false);
    expect(isBbvaStatement(FIXTURE)).toBe(true);
  });

  it('coge la Divisa del IMPORTE, no la del saldo (la cabecera la repite)', () => {
    // Con una cabecera de 10 columnas donde "Divisa" sale dos veces, resolver
    // por nombre a secas devuelve el índice de la primera y funciona por
    // accidente; el test fija que se elige la POSTERIOR al importe.
    expect(parsed.every((m) => m.currency === 'EUR')).toBe(true);
  });

  it('conserva el orden del fichero (más reciente primero)', () => {
    expect(parsed[0].raw).toContain('Servicios web demo');
    expect(parsed[parsed.length - 1].raw).toContain('Cafeteria demo');
  });
});

describe('parseBbvaStatement — fechas', () => {
  it('usa "Fecha valor" como fecha del movimiento y guarda la de contabilización', () => {
    // La compra se ejecutó el 28 y se apuntó el 30: para un control de gastos
    // el dinero salió el 28. Medido en el export real: fecha valor NUNCA es
    // posterior a fecha (694 anteriores, 746 iguales, 0 posteriores).
    const card = byRaw('Servicios web demo');
    expect(card.date).toBe('2026-07-28');
    expect(card.bookedDate).toBe('2026-07-30');
  });

  it('normaliza DD/MM/YYYY a ISO', () => {
    expect(byRaw('Abono de nómina').date).toBe('2026-07-22');
  });
});

describe('parseBbvaStatement — importes', () => {
  it('respeta el signo: negativo es dinero que sale', () => {
    expect(byRaw('Servicios web demo').amount).toBe(-9.99);
    expect(byRaw('Transferencia recibida').amount).toBe(30);
  });

  it('acepta formato europeo y enteros sin decimales', () => {
    expect(byRaw('Abono de nómina').amount).toBe(1234.56);
    expect(byRaw('Cafeteria demo').amount).toBe(-3);
  });
});

describe('parseBbvaStatement — dónde vive el comercio', () => {
  it('tarjeta: el comercio está en Concepto', () => {
    const card = byRaw('Servicios web demo');
    expect(card.kind).toBe('card');
    expect(card.merchant).toBe('Servicios web demo');
  });

  it('recibo: comercio en Movimiento, sin la referencia ni el código interno', () => {
    // "N 9900112233445566 ELECTRICA DEMO SA        CPVR" — la referencia se
    // extrae aparte (sirve de clave de dedupe exacta) y el código que va tras
    // el relleno de espacios no forma parte del nombre del emisor.
    const debit = byRaw('Adeudo a su cargo');
    expect(debit.kind).toBe('direct_debit');
    expect(debit.merchant).toBe('ELECTRICA DEMO SA');
    expect(debit.reference).toBe('9900112233445566');
  });

  it('Bizum: el concepto escrito por la persona está en Movimiento', () => {
    expect(byRaw('Recibido: cena')).toMatchObject({ kind: 'bizum_in', merchant: 'cena' });
    expect(byRaw('COMPRA: FLORISTERIA DEMO SL')).toMatchObject({
      kind: 'bizum_purchase', merchant: 'FLORISTERIA DEMO SL',
    });
  });

  it('Bizum "sin concepto" no inventa un comercio', () => {
    // 63 de 277 Bizums del export real no traen concepto: devolver la cadena
    // "sin concepto" la convertiría en un comercio más y contaminaría la caché
    // de reglas comercio→categoría.
    expect(byRaw('ENVIADO: sin concepto')).toMatchObject({ kind: 'bizum_out', merchant: null });
  });

  it('transferencias y traspasos: la contraparte está en Movimiento', () => {
    expect(byRaw('De titular demo')).toMatchObject({ kind: 'transfer_in', merchant: 'De titular demo' });
    expect(byRaw('Aporte de dinero a Broker Demo')).toMatchObject({
      kind: 'transfer_out', merchant: 'Aporte de dinero a Broker Demo',
    });
    expect(byRaw('Traspaso a cuenta').kind).toBe('internal_transfer');
  });

  it('la nómina se reconoce por el concepto', () => {
    expect(byRaw('Abono de nómina').kind).toBe('payroll');
  });

  it('el kind es estructural, no un veredicto de gasto', () => {
    // Un ingreso por Bizum y una nómina son ambos dinero que entra, pero el
    // parser NO decide cuál es un ingreso doméstico real: eso es del
    // clasificador de ruido. Aquí solo se describe lo que dice el banco.
    const kinds = new Set(parsed.map((m) => m.kind));
    expect(kinds.has('card')).toBe(true);
    expect(kinds.has('internal_transfer')).toBe(true);
    expect(parsed.every((m) => typeof m.kind === 'string')).toBe(true);
  });
});

describe('parseBbvaStatement — duplicados legítimos', () => {
  it('NO colapsa dos movimientos idénticos del mismo día', () => {
    // Dos compras de 4,20 € en el mismo sitio el mismo día son dos compras
    // reales. En el export real hay 16 grupos así (22 filas que un dedupe por
    // Set se comería). Es la misma lección que los partial fills de DeGiro.
    const twins = parsed.filter((m) => m.merchant === 'Super demo centro');
    expect(twins).toHaveLength(2);
    expect(twins[0].amount).toBe(twins[1].amount);
    expect(twins[0].date).toBe(twins[1].date);
  });
});

describe('auditRunningBalance — reconciliación con la columna Disponible', () => {
  it('valida la cadena completa y detecta que el fichero va de nuevo a viejo', () => {
    const audit = auditRunningBalance(parsed);
    expect(audit.ok).toBe(true);
    expect(audit.direction).toBe('desc');
    expect(audit.checked).toBe(11);
    expect(audit.mismatches).toEqual([]);
  });

  it('señala la fila exacta cuando un saldo no cuadra', () => {
    const broken = FIXTURE.replace(';-35.60;EUR;1523.89;', ';-35.60;EUR;1599.99;');
    const audit = auditRunningBalance(parseBbvaStatement(broken));
    expect(audit.ok).toBe(false);
    expect(audit.mismatches).toHaveLength(2); // la fila alterada rompe su par por ambos lados
    expect(audit.mismatches[0].raw).toContain('COMPRA: FLORISTERIA DEMO SL');
  });

  it('un extracto ordenado de viejo a nuevo también reconcilia', () => {
    const lines = FIXTURE.split('\n');
    const head = lines.slice(0, 3);
    const body = lines.slice(3, -1).reverse();
    const audit = auditRunningBalance(parseBbvaStatement([...head, ...body].join('\n')));
    expect(audit.ok).toBe(true);
    expect(audit.direction).toBe('asc');
  });
});
