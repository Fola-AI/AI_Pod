// Normalised provider errors and failure classification (P0-2).
//
// Every provider failure is classified so the orchestration layer knows whether
// to halt (fatal) or retry (transient). "empty" (a successful but blank
// completion) is handled at the turn layer, not here.

export type FailureClass = 'fatal' | 'transient';

// HTTP status is the primary signal for classification. Message text is used
// ONLY as a tiebreaker on 429 (and on a status-less network error), and only
// for an explicit statement of exhausted credits/quota or a suspended account.
// The bare word "billing" is deliberately excluded: providers put it in
// rate-limit upsell URLs (e.g. Groq's ".../settings/billing"), and a URL in a
// rate-limit body must not override a 429.
const CREDIT_OR_SUSPENSION =
  /insufficient|quota|\bcredits?\b|deplet|exhaust|billing hard limit|exceeded your current|suspend|deactivat/i;

export function classifyFailure(
  status: number | undefined,
  message: string,
): FailureClass {
  const msg = message ?? '';
  if (status === undefined) {
    // Network / timeout: transient, unless the body names credit exhaustion.
    return CREDIT_OR_SUSPENSION.test(msg) ? 'fatal' : 'transient';
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return 'fatal'; // bad/absent key, payment required, model not found
  }
  if (status === 400) return 'fatal'; // malformed request — won't succeed on retry
  if (status === 429) {
    // Rate limit is transient unless the body explicitly states no credits or
    // a suspended account (e.g. OpenAI returns insufficient_quota as 429).
    return CREDIT_OR_SUSPENSION.test(msg) ? 'fatal' : 'transient';
  }
  if (status >= 500) return 'transient'; // server error
  return 'transient';
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly isRateLimit: boolean;
  readonly provider: string;
  readonly failureClass: FailureClass;
  readonly rawBody?: string; // Full provider response body, for server-side logging

  constructor(
    message: string,
    opts: {
      status?: number;
      provider: string;
      rawBody?: string;
      failureClass?: FailureClass;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.provider = opts.provider;
    this.rawBody = opts.rawBody;
    this.isRateLimit = opts.status === 429;
    this.failureClass =
      opts.failureClass ?? classifyFailure(opts.status, message);
  }
}

export class MissingKeyError extends ProviderError {
  constructor(provider: string, envKey: string) {
    super(`Missing API key for ${provider} (set ${envKey})`, {
      provider,
      failureClass: 'fatal',
    });
    this.name = 'MissingKeyError';
  }
}

// A successful call that produced blank content after all retries (P0-2: empty
// → retry twice → treat as fatal).
export class EmptyContentError extends ProviderError {
  constructor(provider: string, modelDisplay: string) {
    super(
      `${modelDisplay} returned empty content after 3 attempts (${provider}).`,
      { provider, failureClass: 'fatal' },
    );
    this.name = 'EmptyContentError';
  }
}
