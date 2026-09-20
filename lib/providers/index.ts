// Provider registry. Resolves a ProviderId to a live adapter using env keys.
//
// Adding a new provider touches exactly two files (PRD §6.2): a new adapter
// module, and one entry in ADAPTER_FACTORIES below (plus its registry rows).

import type { ModelEntry, ModelRoute, ProviderAdapter, ProviderId } from '@/lib/types';
import { OPENROUTER_ENV_KEY, PROVIDER_ENV_KEY } from '@/config/models';
import { getModelTest } from '@/lib/model-health';
import { MissingKeyError, ProviderError } from './errors';
import { TIMEOUT_STATUS } from './http';
import { createAnthropicAdapter } from './anthropic';
import { createGoogleAdapter } from './google';
import { createOpenAICompatibleAdapter } from './base-openai';
import { createOpenAIResponsesAdapter } from './openai-responses';

type AdapterFactory = (apiKey: string) => ProviderAdapter;

// DIRECT adapters only. Anthropic/Google are bespoke; OpenAI uses the Responses
// API (for native web search); Groq is a deliberate OpenAI-compatible exception
// kept direct for its latency (see README). Every other vendor — xAI, DeepSeek,
// Meta, Mistral, Alibaba — now routes through OpenRouter (route: 'openrouter')
// via the single gateway adapter below, so it has no direct factory here.
const ADAPTER_FACTORIES: Partial<Record<ProviderId, AdapterFactory>> = {
  anthropic: (key) => createAnthropicAdapter(key),
  google: (key) => createGoogleAdapter(key),
  openai: (key) => createOpenAIResponsesAdapter(key),
  // Groq stays direct — its whole value is latency; routing it via OpenRouter
  // could land on a slower host. Deliberate exception, noted in the README.
  groq: (key) =>
    createOpenAICompatibleAdapter({
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: key,
    }),
};

// OpenRouter gateway (OpenAI-compatible). One key routes every non-direct vendor.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// OpenRouter asks callers to identify themselves for dashboard attribution.
// HTTP-Referer comes from APP_URL (set to the production Vercel URL) so prod
// attribution is right; falls back to localhost for local dev.
function openRouterHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
    'X-Title': 'AI Pod',
  };
}

export function getOpenRouterKey(): string | undefined {
  const val = process.env[OPENROUTER_ENV_KEY];
  return val && val.trim() ? val.trim() : undefined;
}

export function hasOpenRouterKey(): boolean {
  return Boolean(getOpenRouterKey());
}

export function isProviderImplemented(provider: ProviderId): boolean {
  return provider in ADAPTER_FACTORIES;
}

export function getProviderKey(provider: ProviderId): string | undefined {
  const envKey = PROVIDER_ENV_KEY[provider];
  const val = process.env[envKey];
  return val && val.trim() ? val.trim() : undefined;
}

export function hasProviderKey(provider: ProviderId): boolean {
  return Boolean(getProviderKey(provider));
}

/** A provider is usable iff it has an implemented DIRECT adapter AND a key. */
export function isProviderAvailable(provider: ProviderId): boolean {
  return isProviderImplemented(provider) && hasProviderKey(provider);
}

/**
 * Whether a model has its KEY configured (route-aware). This is the "worth
 * attempting a call" check — used by the routes that DO the testing so they
 * always re-test, never gated by a stale cached failure.
 */
export function hasModelKey(model: ModelEntry): boolean {
  return model.route === 'openrouter'
    ? hasOpenRouterKey()
    : isProviderAvailable(model.provider);
}

/**
 * Whether a model is usable right now: key present AND the last recorded test
 * didn't fail. A key can be present but the model unusable (e.g. depleted
 * credits → 402), which only a real call reveals — so once a test has failed we
 * treat the model as unavailable until it's re-tested. No test yet → fall back
 * to key presence. Prefer this in selection/UI; use hasModelKey in the test
 * routes themselves.
 */
export function isModelAvailable(model: ModelEntry): boolean {
  if (!hasModelKey(model)) return false;
  const t = getModelTest(model.id);
  return t ? t.ok : true;
}

/**
 * Resolve a live adapter. For route 'openrouter' this returns the single gateway
 * adapter (labelled with the vendor id so errors stay vendor-specific), keyed on
 * OPENROUTER_API_KEY. For 'direct' it resolves the vendor's own adapter.
 * Throws MissingKeyError if the relevant key is absent, or ProviderError if no
 * direct adapter exists for the provider.
 */
export function getAdapter(
  provider: ProviderId,
  route: ModelRoute = 'direct',
): ProviderAdapter {
  if (route === 'openrouter') {
    const key = getOpenRouterKey();
    if (!key) {
      throw new MissingKeyError(provider, OPENROUTER_ENV_KEY);
    }
    return createOpenAICompatibleAdapter({
      id: provider,
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: key,
      extraHeaders: openRouterHeaders(),
    });
  }
  const factory = ADAPTER_FACTORIES[provider];
  if (!factory) {
    throw new ProviderError(
      `No direct adapter implemented for provider "${provider}" (is it meant to route via OpenRouter?).`,
      { provider },
    );
  }
  const key = getProviderKey(provider);
  if (!key) {
    throw new MissingKeyError(provider, PROVIDER_ENV_KEY[provider]);
  }
  return factory(key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Some providers state how long to wait in the 429 body, e.g. Groq's
// "Please try again in 18.4879s." Honour it (capped) so a tight per-minute
// token window is waited out rather than burned through the retry budget.
const MAX_RETRY_AFTER_MS = 30_000;
export function parseRetryAfterMs(message: string): number | undefined {
  const m = /try again in\s+([\d.]+)\s*s/i.exec(message ?? '');
  if (!m) return undefined;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(secs * 1000) + 500);
}

/**
 * Retry with exponential backoff (P0-2). Only `transient` failures are retried
 * (429 with longer backoff, 5xx, network). `fatal` failures (bad/absent key,
 * insufficient credits, quota, model-not-found, malformed request) throw
 * immediately — retrying them wastes time and money and hides the real problem.
 * A 429 that states an explicit retry delay is waited out (capped).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  let timeoutRetries = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Fatal provider failures are never retried.
      if (err instanceof ProviderError && err.failureClass === 'fatal') {
        throw err;
      }
      // A client-side timeout is retried at most once: a provider hung once is
      // likely to hang again, and retrying 4x turns one bad turn into minutes.
      const isTimeout = err instanceof ProviderError && err.status === TIMEOUT_STATUS;
      if (isTimeout && ++timeoutRetries > 1) throw err;
      if (i === attempts - 1) break;
      const isRate = err instanceof ProviderError && err.isRateLimit;
      const stated =
        err instanceof ProviderError ? parseRetryAfterMs(err.message) : undefined;
      const base = isRate ? 4000 : 1000;
      const backoff = stated ?? base * Math.pow(2, i) + Math.random() * 500;
      await sleep(backoff);
    }
  }
  throw lastErr;
}
