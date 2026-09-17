import { describe, it, expect } from 'vitest';
import { parseRetryAfterMs, withRetry } from '@/lib/providers';
import { ProviderError } from '@/lib/providers/errors';

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

describe('withRetry timeout handling', () => {
  it('retries a client-side timeout (408) at most once', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError('Request timed out', { status: 408, provider: 'x' });
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2); // initial attempt + one retry, not four
  });

  it('never retries a fatal failure', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError('bad key', { status: 401, provider: 'x' });
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
