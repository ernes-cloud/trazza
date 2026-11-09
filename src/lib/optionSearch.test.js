import { describe, it, expect } from 'vitest';
import { normalizeSearch, filterOptions } from './optionSearch';

const OPTS = [
  { value: 'housing', label: 'Vivienda' },
  { value: 'groceries', label: 'Alimentación' },
  { value: 'restaurants', label: 'Restaurantes' },
  { value: 'transport', label: 'Transporte' },
  { value: 'freelance', label: 'Trabajo autónomo' },
  { value: 'other', label: 'Otros' },
];

describe('normalizeSearch', () => {
  it('quita acentos y pasa a minúsculas', () => {
    expect(normalizeSearch('Alimentación')).toBe('alimentacion');
    expect(normalizeSearch('  Trabajo AUTÓNOMO ')).toBe('trabajo autonomo');
  });

  it('tolera null/undefined/números', () => {
    expect(normalizeSearch(null)).toBe('');
    expect(normalizeSearch(undefined)).toBe('');
    expect(normalizeSearch(42)).toBe('42');
  });
});

describe('filterOptions', () => {
  it('devuelve la lista intacta con query vacía', () => {
    expect(filterOptions(OPTS, '')).toBe(OPTS);
    expect(filterOptions(OPTS, '   ')).toBe(OPTS);
  });

  it('encuentra sin acentos ni mayúsculas', () => {
    // Arrange / Act
    const found = filterOptions(OPTS, 'alimentacion');
    // Assert
    expect(found.map((o) => o.value)).toEqual(['groceries']);
  });

  it('busca también por el medio de la palabra', () => {
    expect(filterOptions(OPTS, 'tonomo').map((o) => o.value)).toEqual(['freelance']);
  });

  it('prioriza las coincidencias por prefijo', () => {
    // "tra" está al principio en Transporte/Trabajo y en medio en "Otros"? no:
    // el caso real es Restaurantes (no casa) vs los dos que empiezan por "tra".
    const found = filterOptions(OPTS, 'tra');
    expect(found.map((o) => o.value)).toEqual(['transport', 'freelance']);
  });

  it('pone delante el prefijo aunque venga después en la lista', () => {
    const list = [
      { value: 'a', label: 'Gasto de casa' },
      { value: 'b', label: 'Casa rural' },
    ];
    expect(filterOptions(list, 'casa').map((o) => o.value)).toEqual(['b', 'a']);
  });

  it('devuelve vacío cuando nada coincide', () => {
    expect(filterOptions(OPTS, 'zzz')).toEqual([]);
  });

  it('cae al value cuando la opción no trae label', () => {
    expect(filterOptions([{ value: 'Cripto' }], 'cri').map((o) => o.value)).toEqual(['Cripto']);
  });

  it('no revienta con lista vacía o por defecto', () => {
    expect(filterOptions([], 'x')).toEqual([]);
    expect(filterOptions(undefined, 'x')).toEqual([]);
  });
});
