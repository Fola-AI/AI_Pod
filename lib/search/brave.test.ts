import { describe, it, expect } from 'vitest';
import {
  cleanSnippet,
  normaliseBraveResults,
  MAX_SNIPPET_CHARS,
  MAX_TOTAL_SNIPPET_CHARS,
} from '@/lib/search/brave';
import { runSearch, preflightSearch } from '@/lib/search';
import type { SearchProvider } from '@/lib/search/types';

describe('cleanSnippet', () => {
  it('strips tags, decodes entities, collapses whitespace', () => {
    expect(cleanSnippet('<strong>Solar</strong>  grew   by &amp; 40&#39;s')).toBe(
      "Solar grew by & 40's",
    );
  });
  it('handles empty', () => {
    expect(cleanSnippet('')).toBe('');
  });
});

describe('normaliseBraveResults', () => {
  const raw = {
    web: {
      results: Array.from({ length: 8 }, (_, i) => ({
        title: `T${i}`,
        url: `https://ex.com/${i}`,
        description: 'x'.repeat(500),
        page_age: '2026-01-01T00:00:00',
      })),
    },
  };

  it('caps at maxResults (and hard cap 5)', () => {
    expect(normaliseBraveResults(raw, 3)).toHaveLength(3);
    expect(normaliseBraveResults(raw, 99)).toHaveLength(5);
  });

  it('trims each snippet to MAX_SNIPPET_CHARS and total to the payload cap', () => {
    const out = normaliseBraveResults(raw, 5);
    expect(out[0].snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    const total = out.reduce((n, r) => n + r.snippet.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_SNIPPET_CHARS);
  });

  it('carries url, title, publishedDate, fetchedAt; skips result with no url', () => {
    const out = normaliseBraveResults(
      { web: { results: [{ title: 'A', description: 'd', page_age: '2026-05-01' }, { title: 'B', url: 'https://b.com', description: 'd' }] } },
      5,
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://b.com');
    expect(out[0].fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty for malformed payloads', () => {
    expect(normaliseBraveResults(null, 5)).toEqual([]);
    expect(normaliseBraveResults({ web: {} }, 5)).toEqual([]);
  });
});

const stub = (impl: SearchProvider['search']): SearchProvider => ({ id: 'brave', search: impl });

describe('runSearch (never throws)', () => {
  it('returns results on success', async () => {
    const p = stub(async () => [{ title: 'A', url: 'https://a.com', snippet: 's', fetchedAt: 'now' }]);
    const out = await runSearch('q', { maxResults: 5, provider: p });
    expect(out.results).toHaveLength(1);
    expect(out.note).toBeUndefined();
    expect(out.provider).toBe('brave');
  });
  it('notes an empty result set', async () => {
    const out = await runSearch('q', { maxResults: 5, provider: stub(async () => []) });
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/no results/i);
  });
  it('swallows a provider throw into a note', async () => {
    const out = await runSearch('q', {
      maxResults: 5,
      provider: stub(async () => {
        throw new Error('boom');
      }),
    });
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/search failed: boom/i);
  });
});

describe('preflightSearch', () => {
  it('passes when a test query succeeds', async () => {
    const out = await preflightSearch({ provider: stub(async () => []) });
    expect(out.ok).toBe(true);
  });
  it('blocks on a fatal (403) key rejection', async () => {
    const { ProviderError } = await import('@/lib/providers/errors');
    const out = await preflightSearch({
      provider: stub(async () => {
        throw new ProviderError('brave 403: forbidden', { status: 403, provider: 'brave' });
      }),
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/rejected the key/i);
  });
  it('does not block on a transient (429)', async () => {
    const { ProviderError } = await import('@/lib/providers/errors');
    const out = await preflightSearch({
      provider: stub(async () => {
        throw new ProviderError('brave 429: slow down', { status: 429, provider: 'brave' });
      }),
    });
    expect(out.ok).toBe(true);
  });
});
