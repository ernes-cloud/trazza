import { describe, it, expect } from 'vitest';
import { aiHttpErrorMessage } from './aiHttpErrorMessage';

describe('aiHttpErrorMessage payload-too-large mapping', () => {
  const t = (key) => key;

  it('maps "Payload too large" to translated key', () => {
    expect(aiHttpErrorMessage({ error: 'Payload too large', t })).toBe('cartera.ai_payload_too_large');
  });

  it('falls back to ai_unavailable for unknown errors', () => {
    expect(aiHttpErrorMessage({ error: 'UNKNOWN_AI_ERROR', t })).toBe('cartera.ai_unavailable');
  });
});
