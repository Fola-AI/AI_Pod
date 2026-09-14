// Provider registry. Resolves a ProviderId to a live adapter using env keys.
//
// Adding a new provider touches exactly two files (PRD §6.2): a new adapter
// module, and one entry in ADAPTER_FACTORIES below (plus its registry rows).

import type { ProviderAdapter, ProviderId } from '@/lib/types';
import { PROVIDER_ENV_KEY } from '@/config/models';
import { MissingKeyError, ProviderError } from './errors';
import { createAnthropicAdapter } from './anthropic';
import { createGoogleAdapter } from './google';
import { createOpenAICompatibleAdapter } from './base-openai';

type AdapterFactory = (apiKey: string) => ProviderAdapter;

// OpenAI-compatible providers: base URL is the only real difference.
const OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
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
  openai: openAICompatFactory('openai'),
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

/**
 * Per-call retry with exponential backoff, 3 attempts (PRD §9.4).
 * Rate-limit (429) responses back off harder. Missing-key errors are not
 * retried — they will never succeed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof MissingKeyError) throw err;
      if (i === attempts - 1) break;
      const isRate = err instanceof ProviderError && err.isRateLimit;
      const base = isRate ? 4000 : 1000;
      const backoff = base * Math.pow(2, i) + Math.random() * 500;
      await sleep(backoff);
    }
  }
  throw lastErr;
}
