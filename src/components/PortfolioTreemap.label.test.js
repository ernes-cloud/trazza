import { describe, it, expect } from 'vitest';
import { isOpaqueTicker, tileLabel, getTileColor, getTileFill, formatChange } from './PortfolioTreemap';

describe('isOpaqueTicker', () => {
  it('flags bare ISINs (funds imported without a real ticker)', () => {
    expect(isOpaqueTicker('IE00B4L5Y983')).toBe(true); // iShares Core MSCI World
    expect(isOpaqueTicker('LU0996177134')).toBe(true);
    expect(isOpaqueTicker('ES0173093024')).toBe(true);
  });

  it('flags suffixed ISINs like the EODHD .EUFUND symbols', () => {
    expect(isOpaqueTicker('IE00B4L5Y983.EUFUND')).toBe(true);
  });

  it('flags Morningstar-style 0P… Yahoo fund symbols', () => {
    expect(isOpaqueTicker('0P0001AZ12.F')).toBe(true);
  });

  it('flags unresolved fund names (tickers with whitespace) and empty tickers', () => {
    expect(isOpaqueTicker('BGIF Euro Short Duration')).toBe(true);
    expect(isOpaqueTicker('')).toBe(true);
    expect(isOpaqueTicker(undefined)).toBe(true);
  });

  it('keeps real exchange tickers', () => {
    expect(isOpaqueTicker('AAPL')).toBe(false);
    expect(isOpaqueTicker('IWDA.AS')).toBe(false);
    expect(isOpaqueTicker('SMH.L')).toBe(false);
    expect(isOpaqueTicker('BTC-USD')).toBe(false);
    expect(isOpaqueTicker('AMZ.XGAT')).toBe(false);
  });
});

describe('tileLabel', () => {
  it('prefers the asset name when the ticker is an ISIN', () => {
    expect(tileLabel('IE00B4L5Y983', 'iShares Core MSCI World')).toBe('iShares Core MSCI World');
  });

  it('prefers the name for funds even with a normal-looking exchange ticker (.MU listings)', () => {
    expect(tileLabel('FEPA.MU', 'Fidelity MSCI Japan Index Fund', true))
      .toBe('Fidelity MSCI Japan Index Fund');
    expect(tileLabel('FEP0.MU', 'Fidelity MSCI Asia Pacific ex Japan Index Fund', true))
      .toBe('Fidelity MSCI Asia Pacific ex Japan Index Fund');
    // funds with no name still fall back to the ticker
    expect(tileLabel('FEPA.MU', undefined, true)).toBe('FEPA.MU');
  });

  it('does not touch stocks (isFund false)', () => {
    expect(tileLabel('AAPL', 'Apple Inc.', false)).toBe('AAPL');
  });

  it('keeps the ticker for regular listings', () => {
    expect(tileLabel('AAPL', 'Apple Inc.')).toBe('AAPL');
  });

  it('falls back to the ticker when there is no name', () => {
    expect(tileLabel('IE00B4L5Y983', undefined)).toBe('IE00B4L5Y983');
  });

  it('never returns undefined', () => {
    expect(tileLabel(undefined, undefined)).toBe('');
  });
});

describe('variación diaria — el dato ausente no se disfraza de plano', () => {
  // Una cartera de fondos de inversión NO trae variación diaria (el NAV sale
  // una vez al día y con retraso). Antes se fabricaba un 0 y `change >= 0` lo
  // pintaba verde: el mapa entero en verde con todo a "+0,00%".
  it('gris cuando no hay dato', () => {
    expect(getTileColor(null)).toBe(getTileColor(undefined));
    expect(getTileColor(null)).not.toBe(getTileColor(1));
    expect(getTileColor(null)).not.toBe(getTileColor(-1));
  });

  it('gris también en el cero exacto: no moverse no es subir', () => {
    expect(getTileColor(0)).toBe(getTileColor(null));
  });

  it('verde sólo si sube, rojo sólo si baja', () => {
    expect(getTileColor(0.01)).toBe(getTileColor(5));
    expect(getTileColor(-0.01)).toBe(getTileColor(-5));
    expect(getTileColor(1)).not.toBe(getTileColor(-1));
  });

  it('escribe una raya cuando no hay dato, no un 0,00%', () => {
    expect(formatChange(null)).toBe('—');
    expect(formatChange(undefined)).toBe('—');
    expect(formatChange(NaN)).toBe('—');
  });

  it('el signo lo pone el número, no la plantilla', () => {
    // Coma decimal, como los importes y como ya decía el JSDoc ('+1,20%').
    expect(formatChange(1.234)).toBe('+1,23%');
    expect(formatChange(-1.234)).toBe('-1,23%');
    expect(formatChange(0)).toBe('0,00%'); // ni "+0,00%" ni raya: es un dato real
  });
});

describe('getTileFill — degradado según la intensidad de la variación', () => {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const isGreen = (hex) => parseInt(hex.slice(3, 5), 16) > parseInt(hex.slice(1, 3), 16);

  it('cuanto más sube, más intenso (más oscuro) el verde', () => {
    expect(luminance(getTileFill(2))).toBeLessThan(luminance(getTileFill(0.5)));
    expect(luminance(getTileFill(0.5))).toBeLessThan(luminance(getTileFill(0.05)));
    expect(isGreen(getTileFill(0.05))).toBe(true);
  });

  it('cuanto más baja, más intenso el rojo', () => {
    expect(luminance(getTileFill(-2.34))).toBeLessThan(luminance(getTileFill(-0.12)));
    expect(isGreen(getTileFill(-0.12))).toBe(false);
  });

  it('a partir de ±3% ya no se intensifica más', () => {
    expect(getTileFill(3)).toBe(getTileFill(8));
    expect(getTileFill(-3)).toBe(getTileFill(-15));
  });

  it('sin dato o sin movimiento, gris', () => {
    expect(getTileFill(0)).toBe(getTileColor(0));
    expect(getTileFill(null)).toBe(getTileColor(null));
  });
});
