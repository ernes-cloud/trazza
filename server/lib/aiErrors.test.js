import { describe, it, expect } from 'vitest';
import {
  aiErrorBody, AI_OVERLOADED, AI_UNAVAILABLE, AI_REGION_BLOCKED,
} from './aiErrors.js';

describe('aiErrorBody', () => {
  it('expone code y error simétricos para el cliente i18n', () => {
    expect(aiErrorBody(AI_OVERLOADED)).toEqual({
      error: 'AI_OVERLOADED',
      code: 'AI_OVERLOADED',
    });
    expect(aiErrorBody(AI_REGION_BLOCKED).code).toBe('AI_REGION_BLOCKED');
    expect(aiErrorBody(AI_UNAVAILABLE).code).toBe('AI_UNAVAILABLE');
  });
});
