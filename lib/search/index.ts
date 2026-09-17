// Internal search service (B-5.5). One entry point for the shared web_search
// tool: resolve the provider from env, run a query with timing, and never let a
// search failure become a fatal turn failure.

import type { SearchResult } from '@/lib/types';
import type { SearchProvider } from './types';
import { createBraveProvider } from './brave';
import { ProviderError, classifyFailure } from '@/lib/providers/errors';

export const BRAVE_ENV_KEY = 'BRAVE_SEARCH_API_KEY';

// The single function tool exposed to agents. Exactly one tool, one description,
// no variants — tool-selection accuracy degrades as tool count rises.
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web for current information, statistics, studies, or events. Use this when you need a specific fact, figure, or source to support a claim you are about to make.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A short search query, 2-8 words. Use the terms that would appear in the source you want, not a full question.',
      },
    },
    required: ['query'],
  },
} as const;

export function getSearchKey(): string | undefined {
  const v = process.env[BRAVE_ENV_KEY];
  return v && v.trim() ? v.trim() : undefined;
}

export function hasSearchKey(): boolean {
  return Boolean(getSearchKey());
}

export function getSearchProvider(): SearchProvider | null {
  const key = getSearchKey();
  return key ? createBraveProvider(key) : null;
}

export interface RunSearchOutcome {
  results: SearchResult[];
  latencyMs: number;
  provider: string;
  /** Set when the search returned nothing usable; surfaced to the model + UI. */
  note?: string;
  /** True only on a real provider failure (not merely "no results"). */
  failed?: boolean;
}

/**
 * Run one search. Never throws: a provider failure yields an empty result set
 * with a note so the agent can speak ungrounded and the turn is flagged, rather
 * than halting the episode (brief §Limits and failure handling).
 */
export async function runSearch(
  query: string,
  opts: { maxResults: number; provider?: SearchProvider },
): Promise<RunSearchOutcome> {
  const provider = opts.provider ?? getSearchProvider();
  const start = Date.now();
  if (!provider) {
    return { results: [], latencyMs: 0, provider: 'brave', note: 'Search is not configured.', failed: true };
  }
  try {
    const results = await provider.search(query, { maxResults: opts.maxResults });
    const latencyMs = Date.now() - start;
    if (results.length === 0) {
      return { results, latencyMs, provider: provider.id, note: 'No results found.' };
    }
    return { results, latencyMs, provider: provider.id };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { results: [], latencyMs, provider: provider.id, note: `Search failed: ${message}`, failed: true };
  }
}

/**
 * Pre-flight check for shared mode. A missing key is a hard block; a live test
 * query catches a bad/blocked key (401/403 fatal) before the session starts.
 * Transient failures (429/5xx/network) do not block — they'll be handled per
 * turn if they persist.
 */
export async function preflightSearch(
  opts: { provider?: SearchProvider } = {},
): Promise<{ ok: boolean; message?: string }> {
  const provider = opts.provider ?? getSearchProvider();
  if (!provider) {
    return {
      ok: false,
      message: `Shared web search needs ${BRAVE_ENV_KEY}. Add it and retry, or set search mode to "none".`,
    };
  }
  try {
    await provider.search('test', { maxResults: 1 });
    return { ok: true };
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (classifyFailure(status, message) === 'fatal') {
      return { ok: false, message: `Search provider rejected the key: ${message}` };
    }
    return { ok: true }; // transient — don't block the session on a blip
  }
}
