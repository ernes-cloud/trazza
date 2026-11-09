import { describe, it, expect } from 'vitest';
import { narrativeParams, isTruncated, isReasoningModel, REASONING_BUDGET } from './groqNarrative.js';

describe('narrativeParams', () => {
  it('a un modelo que razona le suma presupuesto y baja el esfuerzo', () => {
    expect(narrativeParams('openai/gpt-oss-120b', 750)).toEqual({
      max_tokens: 750 + REASONING_BUDGET, reasoning_effort: 'low',
    });
  });

  it('a un modelo que no razona no le manda reasoning_effort (Groq lo rechaza)', () => {
    expect(narrativeParams('llama-3.3-70b-versatile', 750)).toEqual({ max_tokens: 750 });
  });

  it('reconoce los gpt-oss sin importar el prefijo', () => {
    expect(isReasoningModel('openai/gpt-oss-20b')).toBe(true);
    expect(isReasoningModel(undefined)).toBe(false);
  });
});

describe('isTruncated', () => {
  it('finish_reason "length" es una respuesta cortada', () => {
    expect(isTruncated({ choices: [{ finish_reason: 'length' }] })).toBe(true);
  });
  it('"stop" o una respuesta rara no lo son', () => {
    expect(isTruncated({ choices: [{ finish_reason: 'stop' }] })).toBe(false);
    expect(isTruncated(null)).toBe(false);
  });
});
