import { describe, it, expect } from 'vitest';
import {
  stripInlineCitations,
  extractText,
  extractResponsesSearches,
  mapResponsesStop,
} from '@/lib/providers/openai-responses';

describe('stripInlineCitations', () => {
  it('removes the wrapped markdown citation the search tool emits', () => {
    const input =
      'About 664 GW was installed, per SolarPower Europe ([solarpowereurope.org](https://www.solarpowereurope.org/x?utm_source=openai)).';
    const out = stripInlineCitations(input);
    expect(out).toBe('About 664 GW was installed, per SolarPower Europe.');
    expect(out).not.toMatch(/http/);
  });

  it('keeps the label of a bare markdown link but drops the URL', () => {
    expect(stripInlineCitations('see [the report](https://example.com/r) here')).toBe(
      'see the report here',
    );
  });

  it('removes bare parenthetical and naked URLs, tidying spaces', () => {
    expect(stripInlineCitations('Reuters said so (https://reuters.com/a) last week.')).toBe(
      'Reuters said so last week.',
    );
    expect(stripInlineCitations('Source: https://iea.org/x')).toBe('Source:');
  });

  it('leaves clean speech untouched', () => {
    const s = 'Reuters reported last month that solar hit a record.';
    expect(stripInlineCitations(s)).toBe(s);
  });
});

describe('extractText', () => {
  it('concatenates output_text parts across message items and strips citations', () => {
    const output = [
      { type: 'reasoning' },
      { type: 'web_search_call', action: { queries: ['x'] } },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'Hello ' },
          { type: 'output_text', text: 'world ([a](https://b.com/c)).' },
        ],
      },
    ];
    expect(extractText(output)).toBe('Hello world.');
  });

  it('returns empty string for non-array or empty output', () => {
    expect(extractText(undefined as any)).toBe('');
    expect(extractText([])).toBe('');
  });
});

describe('extractResponsesSearches', () => {
  it('collects queries from web_search_call and deduped url_citation sources', () => {
    const output = [
      { type: 'web_search_call', action: { type: 'search', queries: ['q1', 'q2'] } },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 't',
            annotations: [
              { type: 'url_citation', url: 'https://a.com', title: 'A' },
              { type: 'url_citation', url: 'https://a.com', title: 'A dup' },
              { type: 'url_citation', url: 'https://b.com' },
            ],
          },
        ],
      },
    ];
    const searches = extractResponsesSearches(output)!;
    expect(searches).toHaveLength(1);
    expect(searches[0].mode).toBe('native');
    expect(searches[0].provider).toBe('openai');
    expect(searches[0].query).toBe('q1 | q2');
    expect(searches[0].results.map((r) => ({ url: r.url, title: r.title }))).toEqual([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: '' },
    ]);
  });

  it('reads sources from action.sources (present without in-text citation)', () => {
    const output = [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          queries: ['q1'],
          sources: [
            { type: 'url', url: 'https://a.com' },
            { type: 'url', url: 'https://b.com', title: 'B' },
            { type: 'url', url: 'https://a.com' }, // dup
          ],
        },
      },
      { type: 'message', content: [{ type: 'output_text', text: 'no citations here' }] },
    ];
    const searches = extractResponsesSearches(output)!;
    expect(searches[0].query).toBe('q1');
    expect(searches[0].results.map((r) => ({ url: r.url, title: r.title }))).toEqual([
      { url: 'https://a.com', title: '' },
      { url: 'https://b.com', title: 'B' },
    ]);
  });

  it('dedupes across action.sources and annotation backfill, and caps at 15', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: 'url', url: `https://s${i}.com` }));
    const output = [
      { type: 'web_search_call', action: { type: 'search', queries: ['q'], sources: many } },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 't', annotations: [{ type: 'url_citation', url: 'https://s0.com' }] },
        ],
      },
    ];
    const searches = extractResponsesSearches(output)!;
    expect(searches[0].results).toHaveLength(15);
    // s0 came from action.sources; the annotation dup must not re-add it.
    expect(searches[0].results.filter((s) => s.url === 'https://s0.com')).toHaveLength(1);
  });

  it('falls back to a singular action.query shape', () => {
    const output = [{ type: 'web_search_call', action: { query: 'solo' } }];
    expect(extractResponsesSearches(output)![0].query).toBe('solo');
  });

  it('returns undefined when there are no queries and no sources', () => {
    expect(extractResponsesSearches([{ type: 'message', content: [] }])).toBeUndefined();
    expect(extractResponsesSearches([])).toBeUndefined();
  });

  it('labels sources with no captured query generically', () => {
    const output = [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 't', annotations: [{ type: 'url_citation', url: 'https://a.com' }] },
        ],
      },
    ];
    expect(extractResponsesSearches(output)![0].query).toBe('(web search)');
  });
});

describe('mapResponsesStop', () => {
  it('maps completion, truncation, and filter states', () => {
    expect(mapResponsesStop('completed')).toBe('complete');
    expect(mapResponsesStop('incomplete', 'max_output_tokens')).toBe('max_tokens');
    expect(mapResponsesStop('incomplete', 'content_filter')).toBe('refusal');
    expect(mapResponsesStop('incomplete')).toBe('complete');
    expect(mapResponsesStop('')).toBe('complete');
  });
});
