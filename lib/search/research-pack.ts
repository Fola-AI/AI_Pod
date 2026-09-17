// Research-pack fallback (B-5.5). For any model that can neither search natively
// nor call the shared tool — and as an optional session feature — we run a few
// searches before turn 1 and collate a brief injected into every agent prompt.
// Strictly worse than agent-requested search (nobody can chase a specific claim
// mid-argument), but it means no model is ever completely ungrounded.

import { runSearch } from './index';

// A few angles a researcher would try, derived from the topic/title.
export function deriveResearchQueries(topic: string, title?: string): string[] {
  const seed = ((title && title.length < 80 ? title : topic) || '').replace(/\?+\s*$/, '').trim();
  if (!seed) return [];
  const short = seed.split(/\s+/).slice(0, 8).join(' ');
  const candidates = [short, `${short} latest data 2026`, `${short} statistics`, `${short} recent study`];
  return candidates.filter((q, i, a) => q && a.indexOf(q) === i).slice(0, 4);
}

export interface ResearchPack {
  brief: string; // Injected into agent prompts; source names + dates, no URLs
  queries: string[];
}

/**
 * Build the research brief by running derived queries. URLs are deliberately
 * omitted from the brief text so agents can't read them aloud; the brief carries
 * source names, dates, and snippets for natural in-speech attribution.
 */
export async function buildResearchPack(
  topic: string,
  opts: { title?: string; resultsPerSearch?: number; maxQueries?: number } = {},
): Promise<ResearchPack> {
  const queries = deriveResearchQueries(topic, opts.title).slice(0, opts.maxQueries ?? 4);
  const resultsPerSearch = opts.resultsPerSearch ?? 3;
  const blocks: string[] = [];
  for (const q of queries) {
    const out = await runSearch(q, { maxResults: resultsPerSearch });
    if (!out.results.length) continue;
    const lines = out.results.map((r) => {
      const src = r.title || new URL(r.url).hostname.replace(/^www\./, '');
      const date = r.publishedDate ? ` (${r.publishedDate})` : '';
      return `- ${src}${date}: ${r.snippet}`;
    });
    blocks.push(`On "${q}":\n${lines.join('\n')}`);
  }
  return { brief: blocks.join('\n\n'), queries };
}
