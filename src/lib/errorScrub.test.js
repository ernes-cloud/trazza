import { describe, it, expect } from 'vitest';
import { scrubUrl, scrubText, fingerprint } from './errorScrub';

describe('scrubUrl — lo que NUNCA debe salir del navegador', () => {
  it('sustituye el token de una cartera compartida por el patrón de ruta', () => {
    const url = 'https://example.com/share/a65479eb-b317-4cc7-af22-749936df2de1';
    expect(scrubUrl(url)).toBe('/share/:token');
    expect(scrubUrl(url)).not.toContain('a65479eb');
  });

  it('descarta la query string entera', () => {
    expect(scrubUrl('/app/rebalance?contribution=1500&broker=abc')).toBe('/app/rebalance');
  });

  it('descarta el hash', () => {
    expect(scrubUrl('/app/brokers#posicion-3')).toBe('/app/brokers');
  });

  it('tapa un UUID en una ruta no contemplada', () => {
    expect(scrubUrl('/app/algo/3f2504e0-4f89-41d3-9a0c-0305e82c3301/detalle'))
      .toBe('/app/algo/:id/detalle');
  });

  it('deja intactas las rutas normales', () => {
    expect(scrubUrl('https://example.com/app/brokers')).toBe('/app/brokers');
    expect(scrubUrl('/')).toBe('/');
  });

  it('normaliza el slug del blog (no es secreto, pero agrupa mejor)', () => {
    expect(scrubUrl('/blog/como-calcular-el-twr')).toBe('/blog/:slug');
  });

  it('tolera basura sin lanzar', () => {
    expect(scrubUrl('')).toBe('');
    expect(scrubUrl(null)).toBe('');
    expect(scrubUrl(undefined)).toBe('');
    expect(scrubUrl(12345)).toBe('');
  });
});

describe('scrubText — el token tampoco puede colarse por el mensaje', () => {
  it('tapa un UUID dentro del mensaje de error', () => {
    const msg = 'Failed to fetch /share-data/a65479eb-b317-4cc7-af22-749936df2de1';
    expect(scrubText(msg)).toBe('Failed to fetch /share-data/:id');
  });

  it('tapa un token largo tipo JWT', () => {
    const out = scrubText('Authorization failed: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIs');
    expect(out).toContain(':token');
  });

  it('respeta el tope de longitud', () => {
    // Texto con espacios A PROPÓSITO: una tirada alfanumérica larga la
    // sustituiría antes la regla de tokens y no se estaría midiendo el corte.
    const largo = 'error en la linea '.repeat(500);
    expect(scrubText(largo, 100)).toHaveLength(100);
  });

  it('una tirada alfanumérica muy larga se trata como token (base64, id minificado…)', () => {
    // Es deliberado: en un mensaje de error una cadena así no es una palabra,
    // es un identificador o un blob, y no aporta nada al diagnóstico.
    expect(scrubText('x'.repeat(5000))).toBe(':token');
  });

  it('no rompe con entradas vacías', () => {
    expect(scrubText(null)).toBe('');
    expect(scrubText('')).toBe('');
  });
});

describe('fingerprint — agrupar el MISMO fallo, separar los distintos', () => {
  const base = {
    kind: 'render',
    message: 'Cannot read properties of undefined (reading "ticker")',
    stack: 'Error: x\n    at PositionsTable (PositionsTable.jsx:42:10)\n    at Dashboard (Dashboard.jsx:10:1)',
  };

  it('dos ocurrencias idénticas comparten huella', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('IGNORA los marcos inferiores del stack: el mismo bug alcanzado por otra ruta agrupa igual', () => {
    const otraRuta = { ...base, stack: 'Error: x\n    at PositionsTable (PositionsTable.jsx:42:10)\n    at CarteraPage (CarteraPage.jsx:99:2)' };
    expect(fingerprint(otraRuta)).toBe(fingerprint(base));
  });

  it('dos errores que solo difieren en un UUID son EL MISMO error', () => {
    const a = { ...base, message: 'fetch /share-data/a65479eb-b317-4cc7-af22-749936df2de1 failed' };
    const b = { ...base, message: 'fetch /share-data/0dd71d88-6d11-431c-8a31-3e3bc7abd237 failed' };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('un mensaje distinto da huella distinta', () => {
    expect(fingerprint({ ...base, message: 'otra cosa' })).not.toBe(fingerprint(base));
  });

  it('un componente distinto da huella distinta', () => {
    const otro = { ...base, stack: 'Error: x\n    at OtroWidget (OtroWidget.jsx:7:1)' };
    expect(fingerprint(otro)).not.toBe(fingerprint(base));
  });

  it('la huella nunca contiene el token', () => {
    const conToken = { ...base, message: 'boom a65479eb-b317-4cc7-af22-749936df2de1' };
    expect(fingerprint(conToken)).not.toContain('a65479eb');
  });

  it('no lanza sin stack', () => {
    expect(() => fingerprint({ kind: 'window', message: 'x' })).not.toThrow();
  });
});
