import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import { formatPercent, formatNumber, appLocale, formatMoney, formatMoneyCompact } from './formatters';

describe('formatPercent', () => {
  it('usa coma decimal, como los importes', () => {
    expect(formatPercent(46.3, 1)).toBe('46,3%');
    expect(formatPercent(-0.74)).toBe('-0,74%');
  });

  it('el "+" solo si se pide y el número es positivo', () => {
    expect(formatPercent(1.234, 2, { sign: true })).toBe('+1,23%');
    expect(formatPercent(1.234)).toBe('1,23%');
    expect(formatPercent(0, 2, { sign: true })).toBe('0,00%');
  });

  it('sin dato, raya', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('agrupa miles al estilo español', () => {
    expect(formatNumber(12345.6, 2, 2)).toBe('12.345,60');
  });
});

describe('formato según el idioma de la app', () => {
  it('appLocale: inglés → en-US; español o sin idioma → es-ES', () => {
    expect(appLocale('en')).toBe('en-US');
    expect(appLocale('en-GB')).toBe('en-US');
    expect(appLocale('es')).toBe('es-ES');
    expect(appLocale(undefined)).toBe('es-ES');
  });

  it('con la app en inglés, punto decimal y coma de miles', async () => {
    await i18next.init({ lng: 'en', resources: {} });
    try {
      expect(formatNumber(12345.6, 2, 2)).toBe('12,345.60');
      expect(formatPercent(110.45, 2, { sign: true })).toBe('+110.45%');
    } finally {
      await i18next.changeLanguage('es');
    }
    expect(formatNumber(12345.6, 2, 2)).toBe('12.345,60');
  });
});

// Intl separa número y símbolo con un espacio duro (U+00A0): se compara como espacio.
const sp = (x) => x.replace(/ /g, ' ');

describe('formatMoney', () => {
  it('español: símbolo detrás, signo delante y separador de miles siempre', () => {
    expect(sp(formatMoney(-13.83, 'EUR'))).toBe('-13,83 €');
    expect(sp(formatMoney(1200.56, 'EUR'))).toBe('1.200,56 €');
    expect(sp(formatMoney(5550, 'USD'))).toBe('5.550,00 US$');
  });

  it('con sign, el "+" en los positivos', () => {
    expect(sp(formatMoney(21448, 'EUR', { sign: true, decimals: 0 }))).toBe('+21.448 €');
    expect(sp(formatMoney(0, 'EUR', { sign: true }))).toBe('0,00 €');
  });

  it('inglés: símbolo delante', async () => {
    await i18next.changeLanguage('en');
    try {
      expect(sp(formatMoney(-13.83, 'EUR'))).toBe('-€13.83');
    } finally {
      await i18next.changeLanguage('es');
    }
  });

  it('una divisa que Intl no conoce no rompe: número + código', () => {
    expect(sp(formatMoney(10, 'XX1'))).toBe('10,00 XX1');
  });

  it('sin dato, raya', () => {
    expect(sp(formatMoney(null, 'EUR'))).toBe('—');
  });
});

describe('formatMoneyCompact — ejes de gráficos', () => {
  it('1.050 y 1.400 ya no salen los dos como "1k"', () => {
    expect(sp(formatMoneyCompact(1050, 'EUR'))).not.toBe(sp(formatMoneyCompact(1400, 'EUR')));
  });
  it('los importes pequeños van enteros', () => {
    expect(sp(formatMoneyCompact(350, 'EUR'))).toBe('350 €');
  });
});
