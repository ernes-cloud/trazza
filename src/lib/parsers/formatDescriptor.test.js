import { describe, it, expect } from 'vitest';
import {
  applyFormatDescriptor, validateDescriptor, scoreDescriptor,
  leerNumero, detectDecimalSeparator,
} from './formatDescriptor';

/* Fixture sintético con la forma de una pantalla de órdenes de fondos:
   cabecera de fecha y fichas de 5 líneas. */
const ficha = (nombre, importe, part) =>
  [`Suscripción Fondos de Inversión ${nombre}`, importe, 'Puntual', 'Finalizada', `${part} participaciones`];

const PANTALLA = [
  'Valor de mercado', '1.000,00 €',           // ruido: ni abre ficha ni estorba
  '05/03/2026',
  ...ficha('Acme Global Equity', '50,00 €', '2,5'),
  ...ficha('Beta Euro Bond', '30,00 €', '0,675'),
  '12/01/2026',
  ...ficha('Acme Global Equity', '20,00 €', '1,25'),
].join('\n');

const D = {
  layout: 'stacked',
  startPattern: '^Suscripci[oó]n Fondos de Inversi[oó]n',
  recordLines: 5,
  dateHeading: true,
  fields: [
    { offset: 0, role: 'description' },
    { offset: 1, role: 'amount' },
    { offset: 4, role: 'quantity', marker: 'participaciones' },
  ],
};

describe('applyFormatDescriptor — el modelo describe, el código aplica', () => {
  const { rows, incompletos, errores } = applyFormatDescriptor(PANTALLA, D);

  it('extrae una fila por ficha, sin saltos ni duplicados', () => {
    expect(errores).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(incompletos).toBe(0);
  });

  it('empareja cada importe con SU cantidad, que es donde falla el modelo', () => {
    expect(rows.map((r) => [r.amount, r.quantity])).toEqual([[50, 2.5], [30, 0.675], [20, 1.25]]);
  });

  it('arrastra la fecha de la cabecera', () => {
    expect(rows.map((r) => r.date)).toEqual(['2026-03-05', '2026-03-05', '2026-01-12']);
  });

  it('ignora el texto que no abre ficha en vez de contarlo como fallo', () => {
    // "Valor de mercado 1.000,00 €" no es un registro incompleto: no es un registro
    expect(incompletos).toBe(0);
  });

  it('guarda la línea de origen como rastro', () => {
    expect(rows[0].sourceLine).toContain('Acme Global Equity');
  });
});

describe('applyFormatDescriptor — registros a medias', () => {
  it('descarta la ficha sin importe en vez de emitirla incompleta', () => {
    const roto = ['05/03/2026', 'Suscripción Fondos de Inversión Acme', 'Puntual', 'Finalizada'].join('\n');
    const { rows, incompletos } = applyFormatDescriptor(roto, D);
    expect(rows).toHaveLength(0);
    expect(incompletos).toBe(1);
  });

  it('el marcador impide leer "Finalizada" como si fuera la cantidad', () => {
    const sinUnidades = ['05/03/2026', 'Suscripción Fondos de Inversión Acme', '50,00 €', 'Puntual', 'Finalizada', 'Suscripción Fondos de Inversión Beta', '30,00 €'].join('\n');
    const { rows } = applyFormatDescriptor(sinUnidades, D);
    expect(rows[0].quantity).toBeNull();
    expect(rows[0].amount).toBe(50);
  });
});

describe('validateDescriptor — un descriptor inventado no puede pasar', () => {
  it('acepta uno correcto', () => {
    expect(validateDescriptor(D).ok).toBe(true);
  });

  it('rechaza el que no trae descripción o importe', () => {
    const v = validateDescriptor({ ...D, fields: [{ offset: 0, role: 'description' }] });
    expect(v.ok).toBe(false);
    expect(v.errores.join(' ')).toMatch(/amount/);
  });

  it('rechaza un offset que se sale de la ficha', () => {
    const v = validateDescriptor({ ...D, fields: [...D.fields, { offset: 9, role: 'price' }] });
    expect(v.ok).toBe(false);
  });

  it('rechaza una regex inválida sin lanzar', () => {
    expect(validateDescriptor({ ...D, startPattern: '([' }).ok).toBe(false);
  });

  it('rechaza un layout que no sabe aplicar', () => {
    expect(validateDescriptor({ ...D, layout: 'tabular' }).ok).toBe(false);
  });
});

describe('scoreDescriptor — antes de fiarse, se mide', () => {
  it('aprueba el descriptor que entiende la pantalla', () => {
    const s = scoreDescriptor(PANTALLA, D);
    expect(s.usable).toBe(true);
    expect(s.ratio).toBe(1);
  });

  it('suspende el que casi no encuentra registros', () => {
    const s = scoreDescriptor(PANTALLA, { ...D, startPattern: '^Reembolso' });
    expect(s.usable).toBe(false);
    expect(s.motivo).toMatch(/registro/);
  });

  it('suspende el que deja la mitad a medias', () => {
    const mediasFichas = ['Suscripción Fondos de Inversión A', '10,00 €', 'Suscripción Fondos de Inversión B', 'Suscripción Fondos de Inversión C'].join('\n');
    const s = scoreDescriptor(mediasFichas, { ...D, dateHeading: false });
    expect(s.usable).toBe(false);
  });
});

describe('separador decimal — se deduce del documento, no del número', () => {
  it('lo prueba un número con los dos separadores', () => {
    expect(detectDecimalSeparator('1.467,01 €')).toBe(',');
    expect(detectDecimalSeparator('1,467.01 €')).toBe('.');
  });

  it('en su defecto, una cola de una o dos cifras', () => {
    expect(detectDecimalSeparator('30,00 €')).toBe(',');
    expect(detectDecimalSeparator('30.00 USD')).toBe('.');
  });

  it('sin pruebas no inventa una convención', () => {
    expect(detectDecimalSeparator('1.234 y 5.678')).toBeNull();
  });

  it('con la convención del documento, "0,589" son unidades y no quinientas ochenta y nueve', () => {
    // Éste era el fallo: la cola de tres cifras engañaba a la heurística suelta
    expect(leerNumero('0,589 participaciones', ',')).toBe(0.589);
    expect(leerNumero('1,795 participaciones', ',')).toBe(1.795);
    expect(leerNumero('1.467,01 €', ',')).toBe(1467.01);
  });

  it('sin convención cae a la heurística de la cola', () => {
    expect(leerNumero('1.234')).toBe(1234);
    expect(leerNumero('12,50')).toBe(12.5);
  });

  it('devuelve null cuando no hay número', () => {
    expect(leerNumero('Finalizada')).toBeNull();
    expect(leerNumero('')).toBeNull();
  });
});
