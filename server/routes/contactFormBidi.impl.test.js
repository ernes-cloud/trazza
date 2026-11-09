import { describe, it, expect } from 'vitest';
import { sanitizeContact } from './contactForm.js';

describe('contactForm bidi/C1 sanitization (m-8)', () => {
  it('strips bidi and C1 controls from the contact name', () => {
    const out = sanitizeContact({
      name: 'A\u202EB\u2066C\u2069\u200E\u200F\u061C\u0085D',
      email: 'ana@example.com',
      message: 'hola',
    });

    expect(out.ok).toBe(true);
    expect(out.name).toBe('A B C D');
    expect(out.name).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u0080-\u009f]/);
  });
});
