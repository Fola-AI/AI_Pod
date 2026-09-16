// Normalised provider errors and failure classification (P0-2).
//
// Every provider failure is classified so the orchestration layer knows whether
// to halt (fatal) or retry (transient). "empty" (a successful but blank
// completion) is handled at the turn layer, not here.

export type FailureClass = 'fatal' | 'transient';

// Signals in a provider's error message that mean "do not retry — operator must
// act": billing/credits/quota/suspension, regardless of HTTP status (OpenAI and
// Groq both return these as 429).
const FATAL_MESSAGE_PATTERNS =
  /insufficient|quota|credit|billing|payment|suspend|deactivat|exhaust|not found|does not exist|do not have access|unauthorized|invalid api key|invalid x-api-key|permission/i;

export function classifyFailure(
  status: number | undefined,
  message: string,
): FailureClass {
  // Message-based fatal signals win even on a 429 (billing dressed as rate limit).
  if (message && FATAL_MESSAGE_PATTERNS.test(message)) return 'fatal';
  if (status === undefined) return 'transient'; // network/timeout
  if (status === 401 || status === 403) return 'fatal'; // bad/absent key
  if (status === 402) return 'fatal'; // payment required
  if (status === 404) return 'fatal'; // model not found
  if (status === 400) return 'fatal'; // malformed request
  if (status === 429) return 'transient'; // genuine rate limit
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
