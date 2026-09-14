// Normalised provider error. `isRateLimit` lets the retry layer back off harder.

export class ProviderError extends Error {
  readonly status?: number;
  readonly isRateLimit: boolean;
  readonly provider: string;

  constructor(
    message: string,
    opts: { status?: number; provider: string },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.provider = opts.provider;
    this.isRateLimit = opts.status === 429;
  }
}

export class MissingKeyError extends ProviderError {
  constructor(provider: string, envKey: string) {
    super(`Missing API key for ${provider} (set ${envKey})`, { provider });
    this.name = 'MissingKeyError';
  }
}
