// Provider registry. Resolves a ProviderId to a live adapter using env keys.
//
// Adding a new provider touches exactly two files (PRD §6.2): a new adapter
// module, and one entry in ADAPTER_FACTORIES below (plus its registry rows).

import type { ProviderAdapter, ProviderId } from '@/lib/types';
import { PROVIDER_ENV_KEY } from '@/config/models';
import { MissingKeyError, ProviderError } from './errors';
import { TIMEOUT_STATUS } from './http';
import { createAnthropicAdapter } from './anthropic';
import { createGoogleAdapter } from './google';
import { createOpenAICompatibleAdapter } from './base-openai';
import { createOpenAIResponsesAdapter } from './openai-responses';

type AdapterFactory = (apiKey: string) => ProviderAdapter;

// OpenAI-compatible providers that share the Chat Completions base. OpenAI is
// NOT here — it uses its own Responses-API adapter (openai-responses.ts) so it
// can do web search; these providers only differ from each other by base URL.
const OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<ProviderId, string>> = {
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1',
  alibaba: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  groq: 'https://api.groq.com/openai/v1',
  // Meta's Llama API exposes an OpenAI-compatible endpoint.
  meta: 'https://api.llama.com/compat/v1',
};

function openAICompatFactory(id: ProviderId): AdapterFactory {
  const baseUrl = OPENAI_COMPATIBLE_BASE_URLS[id]!;
  return (key) => createOpenAICompatibleAdapter({ id, baseUrl, apiKey: key });
}

// Every provider now has a working adapter. Anthropic and Google are bespoke;
// the rest share the OpenAI-compatible base.
const ADAPTER_FACTORIES: Partial<Record<ProviderId, AdapterFactory>> = {
  anthropic: (key) => createAnthropicAdapter(key),
  google: (key) => createGoogleAdapter(key),
  openai: (key) => createOpenAIResponsesAdapter(key),
  xai: openAICompatFactory('xai'),
  deepseek: openAICompatFactory('deepseek'),
  mistral: openAICompatFactory('mistral'),
  alibaba: openAICompatFactory('alibaba'),
  groq: openAICompatFactory('groq'),
  meta: openAICompatFactory('meta'),
};

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

/** A provider is usable iff it has an implemented adapter AND a configured key. */
export function isProviderAvailable(provider: ProviderId): boolean {
  return isProviderImplemented(provider) && hasProviderKey(provider);
}

/**
 * Resolve a live adapter for a provider. Throws MissingKeyError if the key is
 * absent, or ProviderError if the provider has no adapter yet.
 */
export function getAdapter(provider: ProviderId): ProviderAdapter {
  const factory = ADAPTER_FACTORIES[provider];
  if (!factory) {
    throw new ProviderError(
      `No adapter implemented for provider "${provider}" yet.`,
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
