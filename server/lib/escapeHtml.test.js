import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">Tom's & co</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;');
  });

  it('leaves emoji, accents and currency symbols untouched', () => {
    expect(escapeHtml('💰 META — dividendo pagado el 28 sept ($0.5250/acción) · ±5%'))
      .toBe('💰 META — dividendo pagado el 28 sept ($0.5250/acción) · ±5%');
  });

  it('returns an empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
