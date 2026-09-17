import { describe, it, expect } from 'vitest';
import { parseRetryAfterMs } from '@/lib/providers';

describe('parseRetryAfterMs', () => {
  it('parses a stated retry delay and adds a small margin', () => {
    const ms = parseRetryAfterMs('groq 429: Rate limit reached. Please try again in 18.4879s.');
    expect(ms).toBeGreaterThanOrEqual(18_488);
    expect(ms).toBeLessThanOrEqual(19_500);
  });
  it('caps very long delays', () => {
    expect(parseRetryAfterMs('try again in 600s')).toBe(30_000);
  });
  it('returns undefined when no delay is stated', () => {
    expect(parseRetryAfterMs('429 too many requests')).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
  });
});
