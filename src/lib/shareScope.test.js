import { describe, it, expect } from 'vitest';
import { shareScopeMatches } from './shareScope';

const ALL = ['a', 'b', 'c'];

describe('shareScopeMatches — ámbito general', () => {
  it('casa cuando la selección cubre todos los brokers', () => {
    expect(shareScopeMatches('general', ['a', 'b', 'c'], ALL)).toBe(true);
  });

  it('casa con selección vacía (el insert la trata como "todos")', () => {
    expect(shareScopeMatches('general', [], ALL)).toBe(true);
  });

  it('NO casa con un subconjunto', () => {
    expect(shareScopeMatches('general', ['a', 'b'], ALL)).toBe(false);
    expect(shareScopeMatches('general', ['a'], ALL)).toBe(false);
  });

  it('NO casa cuando la longitud coincide pero el conjunto no', () => {
    // El bug que evita comparar por longitud: tres ids, pero falta 'c'.
    expect(shareScopeMatches('general', ['a', 'b', 'b'], ALL)).toBe(false);
  });

  it('trata un metricsScope nulo o vacío como general', () => {
    expect(shareScopeMatches(null, ALL, ALL)).toBe(true);
    expect(shareScopeMatches('', ['a'], ALL)).toBe(false);
  });
});

describe('shareScopeMatches — ámbito de un broker', () => {
  it('casa solo con ese broker seleccionado en solitario', () => {
    expect(shareScopeMatches('b', ['b'], ALL)).toBe(true);
  });

  it('NO casa si se selecciona otro broker', () => {
    expect(shareScopeMatches('b', ['a'], ALL)).toBe(false);
  });

  it('NO casa si se añade un broker más', () => {
    expect(shareScopeMatches('b', ['b', 'c'], ALL)).toBe(false);
  });

  it('NO casa con "todos" seleccionado: es el caso que ponía la curva de un broker sobre toda la cartera', () => {
    expect(shareScopeMatches('b', ALL, ALL)).toBe(false);
    expect(shareScopeMatches('b', [], ALL)).toBe(false);
  });
});

describe('shareScopeMatches — sin brokers', () => {
  it('no casa nunca: sin brokers no hay ámbito que comparar', () => {
    expect(shareScopeMatches('general', [], [])).toBe(false);
    expect(shareScopeMatches('a', ['a'], [])).toBe(false);
  });
});
