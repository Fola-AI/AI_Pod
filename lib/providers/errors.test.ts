import { describe, it, expect } from 'vitest';
import { classifyFailure, ProviderError } from './errors';

// The exact Groq 429 body that was misclassified as fatal (its ".../billing"
// upsell URL matched the old keyword pattern). A per-minute rate limit must be
// transient, regardless of a billing URL in the body.
const GROQ_RATE_LIMIT =
  'groq 429: Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01k54sgdddf9etrcq3xp9h67v9` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5223, Requested 4368. Please try again in 11.9325s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';

describe('classifyFailure', () => {
  it('treats the Groq TPM rate-limit body as transient despite its billing URL', () => {
    expect(classifyFailure(429, GROQ_RATE_LIMIT)).toBe('transient');
  });

  it('treats a bare 429 rate limit as transient', () => {
    expect(classifyFailure(429, 'Too Many Requests')).toBe('transient');
  });

  it('treats OpenAI insufficient_quota (429) as fatal', () => {
    expect(
      classifyFailure(
        429,
        'You exceeded your current quota, please check your plan and billing details.',
      ),
    ).toBe('fatal');
  });

  it('treats depleted prepayment credits (429) as fatal', () => {
    expect(
      classifyFailure(429, 'Your prepayment credits are depleted.'),
    ).toBe('fatal');
  });

  it('classifies auth/payment/model statuses as fatal', () => {
    expect(classifyFailure(401, 'Invalid API Key')).toBe('fatal');
    expect(classifyFailure(402, 'Payment Required')).toBe('fatal');
    expect(classifyFailure(403, 'Forbidden')).toBe('fatal');
    expect(classifyFailure(404, 'model: claude-nonexistent-999')).toBe('fatal');
    expect(classifyFailure(400, 'Bad Request')).toBe('fatal');
  });

  it('classifies 5xx and network errors as transient', () => {
    expect(classifyFailure(500, 'Internal Server Error')).toBe('transient');
    expect(classifyFailure(503, 'Service Unavailable')).toBe('transient');
    expect(classifyFailure(undefined, 'network timeout')).toBe('transient');
  });

  it('marks a status-less body naming credit exhaustion as fatal', () => {
    expect(classifyFailure(undefined, 'account suspended')).toBe('fatal');
  });
});

describe('ProviderError', () => {
  it('derives failureClass from status + message via classifyFailure', () => {
    const rate = new ProviderError('groq 429: ' + GROQ_RATE_LIMIT, {
      status: 429,
      provider: 'groq',
    });
    expect(rate.failureClass).toBe('transient');

    const quota = new ProviderError('exceeded your current quota', {
      status: 429,
      provider: 'openai',
    });
    expect(quota.failureClass).toBe('fatal');
  });

  it('honours an explicit failureClass override', () => {
    const e = new ProviderError('empty', {
      provider: 'anthropic',
      failureClass: 'fatal',
    });
    expect(e.failureClass).toBe('fatal');
  });
});
