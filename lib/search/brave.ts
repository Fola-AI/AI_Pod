// Brave Search API provider (B-5.5). Independent index, flat pricing, 2k free
// queries/month. Results are trimmed hard before they ever reach a model:
// raw payloads bloat context and pull agents out of persona.

import type { SearchResult } from '@/lib/types';
import type { SearchProvider } from './types';
import { ProviderError } from '@/lib/providers/errors';

// Endpoint is overridable (BRAVE_SEARCH_ENDPOINT) for testing outages and for
// pointing at a compatible proxy; defaults to Brave's public API. Read at call
// time so it can change without a rebuild.
function endpoint(): string {
  return (
    process.env.BRAVE_SEARCH_ENDPOINT?.trim() ||
    'https://api.search.brave.com/res/v1/web/search'
  );
}
const TIMEOUT_MS = 15_000;

// Trim limits (brief §Result handling).
export const MAX_RESULTS = 5;
export const MAX_SNIPPET_CHARS = 300;
export const MAX_TOTAL_SNIPPET_CHARS = 1_500;

// Brave puts <strong> highlight tags and HTML entities in descriptions. Strip
// tags, decode the handful of entities that actually occur, collapse space.
export function cleanSnippet(raw: string): string {
  if (!raw) return '';
  const noTags = raw.replace(/<[^>]*>/g, '');
  const decoded = noTags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&nbsp;/g, ' ');
  return decoded.replace(/\s+/g, ' ').trim();
}

// Normalise a raw Brave `web.results` array into trimmed SearchResults, holding
// the total injected snippet payload under MAX_TOTAL_SNIPPET_CHARS.
export function normaliseBraveResults(raw: any, maxResults: number): SearchResult[] {
  const list: any[] = Array.isArray(raw?.web?.results) ? raw.web.results : [];
  const fetchedAt = new Date().toISOString();
  const out: SearchResult[] = [];
  let totalSnippet = 0;
  const cap = Math.min(maxResults, MAX_RESULTS);
  for (const r of list) {
    if (out.length >= cap) break;
    const url = typeof r?.url === 'string' ? r.url : '';
    if (!url) continue;
    const title = cleanSnippet(String(r?.title ?? '')).slice(0, 200);
    let snippet = cleanSnippet(String(r?.description ?? '')).slice(0, MAX_SNIPPET_CHARS);
    if (totalSnippet + snippet.length > MAX_TOTAL_SNIPPET_CHARS) {
      snippet = snippet.slice(0, Math.max(0, MAX_TOTAL_SNIPPET_CHARS - totalSnippet));
    }
    totalSnippet += snippet.length;
    // page_age is an ISO timestamp when present; `age` is a human string.
    const publishedDate =
      typeof r?.page_age === 'string'
        ? r.page_age
        : typeof r?.age === 'string'
          ? r.age
          : undefined;
    out.push({ title, url, snippet, publishedDate, fetchedAt });
  }
  return out;
}

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    id: 'brave',
    async search(query: string, opts: { maxResults: number }): Promise<SearchResult[]> {
      const count = Math.min(opts.maxResults, MAX_RESULTS);
      const url = `${endpoint()}?q=${encodeURIComponent(query)}&count=${count}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const detail = json?.error?.detail ?? json?.message ?? text?.slice(0, 200) ?? 'error';
        throw new ProviderError(`brave ${res.status}: ${detail}`, {
          status: res.status,
          provider: 'brave',
          rawBody: text,
        });
      }
      return normaliseBraveResults(json, opts.maxResults);
    },
  };
}
