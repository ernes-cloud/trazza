import { describe, it, expect } from 'vitest';
import { classifyRun } from './classify.mjs';

// Ronda 9, BAJA 3: un vitest muerto por una señal (Ctrl-C, kill del entorno) se contaba como
// «killed» y el runner seguía con el mutante siguiente.
describe('classifyRun (runner de mutantes)', () => {
  it('tests en verde con el mutante: SURVIVED', () => {
    expect(classifyRun({ code: 0, signal: null, testsFailed: false })).toBe('SURVIVED');
  });

  it('un assert en rojo: killed', () => {
    expect(classifyRun({ code: 1, signal: null, testsFailed: true })).toBe('killed');
  });

  it('vitest muerto por una señal: INTERRUMPIDO, aunque el código no sea 0', () => {
    expect(classifyRun({ code: null, signal: 'SIGTERM', testsFailed: false })).toBe('INTERRUMPIDO');
    expect(classifyRun({ code: null, signal: 'SIGINT', testsFailed: true })).toBe('INTERRUMPIDO');
  });

  it('status null sin señal (spawnSync no pudo lanzar o esperar al hijo): INTERRUMPIDO', () => {
    expect(classifyRun({ code: null, signal: null, testsFailed: false })).toBe('INTERRUMPIDO');
  });

  it('salida ≠ 0 sin ningún test en rojo (error de arranque, sintaxis…): ERROR, no killed', () => {
    expect(classifyRun({ code: 1, signal: null, testsFailed: false })).toBe('ERROR');
  });
});
