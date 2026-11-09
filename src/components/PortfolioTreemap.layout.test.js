import { describe, it, expect } from 'vitest';
import { layoutTileText, withMinTileSize } from './PortfolioTreemap';

// Medidas sacadas del Wallet Map real de una cartera de MyInvestor (2026-10-15).
const lineCount = (l) => l.lines.length;
const blockHeight = (l) =>
  lineCount(l) * l.nameSize * l.lineHeight + (l.showPct ? l.pctSize * l.lineHeight + l.gap : 0);

describe('layoutTileText', () => {
  it('parte un nombre largo en varias líneas en vez de cortarlo cuando hay altura', () => {
    // "FIDELITY MSCI PACFC EXJAPN I…" en una baldosa de 250×380
    const l = layoutTileText('FIDELITY MSCI PACFC EXJAPN IDX', 250, 380);
    expect(lineCount(l)).toBeGreaterThan(1);
    expect(l.lines.join(' ')).toBe('FIDELITY MSCI PACFC EXJAPN IDX');
    expect(l.showPct).toBe(true);
  });

  it('reparte las palabras en líneas parejas, sin una palabra suelta al final', () => {
    const l = layoutTileText('FIDELITY MSCI JAPAN INDEX P AC', 160, 180);
    expect(l.lines.join(' ')).toBe('FIDELITY MSCI JAPAN INDEX P AC');
    const lengths = l.lines.map((s) => s.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(6);
  });

  it('una baldosa estrecha y alta enseña el nombre entero en varias líneas', () => {
    // "ISHARES ES…" en una columna de 87×190
    const l = layoutTileText('ISHARES ESG SCREENED GLB CORP', 87, 190);
    expect(l.lines.join(' ')).toBe('ISHARES ESG SCREENED GLB CORP');
    expect(l.showPct).toBe(true);
  });

  it('una baldosa grande usa una letra más grande que el antiguo tope de 15px', () => {
    const l = layoutTileText('ISHARES EMERGING MARKETS INDEX', 625, 540);
    expect(l.nameSize).toBeGreaterThan(15);
    expect(l.pctSize).toBeGreaterThan(15);
  });

  it('en una baldosa baja el porcentaje no desaparece', () => {
    // BGIF: 250×55, antes solo salía el nombre cortado
    const l = layoutTileText('BGIF EM MKT GOVER BOND INDEX D', 250, 55);
    expect(l.showPct).toBe(true);
    expect(l.pctSize).toBeGreaterThanOrEqual(10);
  });

  it('si solo cabe una cosa, cabe el porcentaje y no el nombre', () => {
    const l = layoutTileText('VANGUARD US GOVERNMENT BD INDE', 60, 24);
    expect(l.showPct).toBe(true);
    expect(lineCount(l)).toBe(0);
  });

  it('una baldosa diminuta no pinta nada', () => {
    const l = layoutTileText('VANGUARD 20', 20, 14);
    expect(l.showPct).toBe(false);
    expect(lineCount(l)).toBe(0);
  });

  it('el bloque de texto nunca se sale de la baldosa', () => {
    const casos = [
      ['FIDELITY MSCI EUROPE INDEX P A', 250, 68],
      ['VANGUARD US GOVERNMENT BD INDE', 250, 72],
      ['ISHARES US INDEX FUND IE S EUR', 87, 345],
      ['VANGUARD 20', 250, 340],
      ['ISHARES EMERGING MARKETS INDEX', 625, 540],
    ];
    for (const [label, w, h] of casos) {
      const l = layoutTileText(label, w, h);
      expect(blockHeight(l)).toBeLessThanOrEqual(h);
      for (const line of l.lines) {
        expect(line.length * l.nameSize * l.charWidth).toBeLessThanOrEqual(w);
      }
    }
  });

  it('una palabra que no cabe se corta con puntos suspensivos', () => {
    const l = layoutTileText('SUPERCALIFRAGILISTICO', 60, 80);
    expect(l.lines.at(-1).endsWith('…')).toBe(true);
  });
});

describe('withMinTileSize — ninguna baldosa tan fina que no quepa su nombre', () => {
  // Caso real (2026-10-17): BTC-USD −0,07 % junto a META −3,72 % era una franja
  // de pocos píxeles sin texto.
  const items = [
    { ticker: 'META', size: 3.72 }, { ticker: 'CSU.TO', size: 2.98 }, { ticker: 'GOOGL', size: 2.47 },
    { ticker: 'MSFT', size: 1.93 }, { ticker: 'AMZN', size: 1.87 }, { ticker: 'BTC-USD', size: 0.07 },
  ];

  it('la más pequeña sube a una cuarta parte de la mayor', () => {
    const out = withMinTileSize(items);
    expect(out.find((d) => d.ticker === 'BTC-USD').size).toBeCloseTo(3.72 / 4, 6);
  });

  it('las que ya eran grandes no cambian y el orden de tamaños se mantiene', () => {
    const out = withMinTileSize(items);
    expect(out.find((d) => d.ticker === 'META').size).toBe(3.72);
    expect(out.find((d) => d.ticker === 'AMZN').size).toBe(1.87);
    const sizes = out.map((d) => d.size);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('no muta la entrada y una lista vacía sigue vacía', () => {
    withMinTileSize(items);
    expect(items[5].size).toBe(0.07);
    expect(withMinTileSize([])).toEqual([]);
  });
});

describe('layoutTileText — modo en una línea', () => {
  it('si solo cabe una línea, nombre y porcentaje van juntos (el nombre no desaparece)', () => {
    const l = layoutTileText('BTC-USD', 220, 26);
    expect(l.inline).toBe(true);
    expect(l.showPct).toBe(true);
    expect(l.lines).toEqual(['BTC-USD']);
  });

  it('en una baldosa con altura para dos líneas no se usa', () => {
    expect(layoutTileText('BTC-USD', 220, 120).inline).toBeFalsy();
  });
});
