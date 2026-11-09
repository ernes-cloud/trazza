import { describe, it, expect } from 'vitest';
import { lineKinds, estimateRecordShape, rankParserCandidates } from './parserCandidates.js';

/* Fichas sintéticas con la forma de una pantalla de órdenes de fondos. */
const ORDENES = Array.from({ length: 6 }, (_, i) =>
  [`Suscripción Fondos de Inversión Fondo ${i}`, `${10 + i},00 €`, 'Puntual', 'Finalizada', `${i + 1},5 participaciones`]
).flat().join('\n');

const MOVIMIENTOS = Array.from({ length: 8 }, (_, i) =>
  [`Suscripcion Iic FONDO ${i}`, `${20 + i},00 €`]
).flat().join('\n');

const PROSA = ['hola que tal', 'esto es texto', 'sin estructura', 'de ningun tipo', 'y sigue asi', 'un rato mas'].join('\n');

describe('lineKinds — la huella de cada línea', () => {
  it('distingue fecha, importe, cantidad-con-unidad y texto', () => {
    expect(lineKinds('05/03/2026')).toBe('D');
    expect(lineKinds('50,00 €')).toBe('N');
    expect(lineKinds('30,00 US$')).toBe('N');       // la divisa es corta
    expect(lineKinds('2,5 participaciones')).toBe('U'); // la unidad, larga
    expect(lineKinds('Finalizada')).toBe('T');
  });

  it('separar N de U es lo que hace reconocible una ficha', () => {
    // Sin esa distinción "2,5 participaciones" y "Finalizada" serían la misma clase
    expect(lineKinds('2,5 participaciones')).not.toBe(lineKinds('Finalizada'));
  });
});

describe('estimateRecordShape — cuántas líneas ocupa un registro', () => {
  it('reconoce la ficha de cinco líneas', () => {
    const r = estimateRecordShape(ORDENES);
    expect(r.period).toBe(5);
    expect(r.score).toBe(1);
  });

  it('reconoce el libro de dos líneas', () => {
    expect(estimateRecordShape(MOVIMIENTOS).period).toBe(2);
  });

  it('NO confunde uniformidad con estructura: la prosa no tiene periodo', () => {
    // Éste era el fallo: con todas las líneas de la misma clase, cualquier
    // periodo "encajaba" y la prosa sacaba un 1,0
    const r = estimateRecordShape(PROSA);
    expect(r.period).toBeNull();
    expect(r.score).toBe(0);
  });

  it('las cabeceras de fecha no desbaratan el periodo', () => {
    const conFechas = ['05/03/2026', MOVIMIENTOS, '12/01/2026', MOVIMIENTOS].join('\n');
    expect(estimateRecordShape(conFechas).period).toBe(2);
  });

  it('un texto demasiado corto no da veredicto', () => {
    expect(estimateRecordShape('una\ndos').period).toBeNull();
  });
});

describe('rankParserCandidates — qué merece el siguiente parser', () => {
  const logs = [
    ...Array(6).fill({ broker: 'ai', format: 'texto', ok: true, buy_sell: 0, csv_sample: ORDENES }),
    ...Array(4).fill({ broker: 'ai', format: 'pdf', ok: false, csv_sample: PROSA }),
    ...Array(9).fill({ broker: 'degiro', format: 'csv', ok: false }),
    { broker: 'ai', format: 'raro', ok: false },
  ];
  const r = rankParserCandidates(logs);

  it('deja fuera lo que YA tiene parser', () => {
    expect(r.some((c) => c.broker === 'degiro')).toBe(false);
  });

  it('deja fuera lo que sólo ha pasado una vez: eso es una anécdota', () => {
    expect(r.some((c) => c.format === 'raro')).toBe(false);
  });

  it('pone primero el formato regular y frecuente', () => {
    expect(r[0].format).toBe('texto');
    expect(r[0].lineasPorRegistro).toBe(5);
    expect(r[0].veredicto).toMatch(/parser barato/);
  });

  it('un import "correcto" con cero compras cuenta como dolor', () => {
    // ok:true pero buy_sell:0 — un fallo disfrazado de éxito
    expect(r[0].vacios).toBe(6);
    expect(r[0].dolor).toBe(1);
  });

  it('desaconseja el parser para lo irregular en vez de proponerlo igual', () => {
    const pdf = r.find((c) => c.format === 'pdf');
    expect(pdf.veredicto).toMatch(/irregular/);
    expect(pdf.prioridad).toBeLessThan(r[0].prioridad);
  });

  it('dice cuándo no puede juzgar por falta de muestras', () => {
    const sinMuestra = rankParserCandidates(Array(3).fill({ broker: 'ai', format: 'x', ok: false }));
    expect(sinMuestra[0].veredicto).toMatch(/sin muestras/);
  });

  it('no rompe con una lista vacía', () => {
    expect(rankParserCandidates([])).toEqual([]);
    expect(rankParserCandidates(null)).toEqual([]);
  });
});
