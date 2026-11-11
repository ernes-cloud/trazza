import { describe, it, expect } from 'vitest';
import { isExpensesFeatureAllowed } from './expensesAccess';

describe('isExpensesFeatureAllowed (OSS opt-in universal)', () => {
  it('acepta cualquier email no vacío', () => {
    expect(isExpensesFeatureAllowed('user@example.com')).toBe(true);
    expect(isExpensesFeatureAllowed('another.person@example.org')).toBe(true);
  });

  it('sin email no hay feature', () => {
    expect(isExpensesFeatureAllowed(undefined)).toBe(false);
    expect(isExpensesFeatureAllowed(null)).toBe(false);
    expect(isExpensesFeatureAllowed('')).toBe(false);
    expect(isExpensesFeatureAllowed('   ')).toBe(false);
  });
});
