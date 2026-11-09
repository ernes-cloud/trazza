import { describe, it, expect } from 'vitest';
import { parseLooseJson } from './looseJson.js';

describe('parseLooseJson', () => {
  it('parses clean JSON', () => {
    expect(parseLooseJson('{"transactions":[{"type":"BUY"}]}'))
      .toEqual({ transactions: [{ type: 'BUY' }] });
  });

  it('returns null for empty / non-string input', () => {
    expect(parseLooseJson('')).toBeNull();
    expect(parseLooseJson('   ')).toBeNull();
    expect(parseLooseJson(null)).toBeNull();
    expect(parseLooseJson(42)).toBeNull();
  });

  it('strips ```json fences``` that vision models add', () => {
    const raw = '```json\n{"transactions":[{"type":"SELL","ticker":"AAPL"}]}\n```';
    expect(parseLooseJson(raw)).toEqual({ transactions: [{ type: 'SELL', ticker: 'AAPL' }] });
  });

  it('strips a bare ``` fence with no language tag', () => {
    expect(parseLooseJson('```\n{"transactions":[]}\n```')).toEqual({ transactions: [] });
  });

  it('trims prose before and after the JSON object', () => {
    const raw = 'Sure! Here are the transactions I found:\n{"transactions":[{"type":"DIVIDEND"}]}\nHope that helps.';
    expect(parseLooseJson(raw)).toEqual({ transactions: [{ type: 'DIVIDEND' }] });
  });

  it('repairs an array truncated mid-object by max_tokens', () => {
    // Second object is cut off → keep the first complete one, close the array.
    const raw = '{"transactions":[{"type":"BUY","ticker":"MSFT"},{"type":"SE';
    const out = parseLooseJson(raw);
    expect(out.transactions).toEqual([{ type: 'BUY', ticker: 'MSFT' }]);
  });

  it('returns null when there is no recoverable JSON', () => {
    expect(parseLooseJson('I could not read the image, sorry.')).toBeNull();
  });
});
