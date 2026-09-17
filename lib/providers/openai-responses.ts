// OpenAI adapter — Responses API (`/v1/responses`), kept deliberately separate
// from the Chat Completions base (base-openai.ts). OpenAI's web search is only
// available here, not on Chat Completions, so OpenAI gets its own adapter and
// the OpenAI-compatible providers (xAI, DeepSeek, Groq, Mistral, Alibaba, Meta)
// stay on the shared base without inheriting any Responses-shaped code.
//
// Shape notes (verified live against gpt-5.6-sol, Sept 2026):
//   - `instructions` carries the system prompt; `input` is the message list
//     ({ role, content } with plain-string content is accepted for multi-turn).
//   - `max_output_tokens` (not max_tokens); some reasoning models reject
//     `temperature`, so we self-heal by dropping it.
//   - Output is an array of items: `message` items hold the text in
//     content[].output_text, and `web_search_call` items carry the issued
//     queries under action.queries[]. Source URLs come back as `url_citation`
//     annotations on the message text, not mapped per query — so, like Google,
//     we attach the full source list to the joined query string.

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderStopReason,
  TurnSearch,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

const API_URL = 'https://api.openai.com/v1/responses';

// The Responses API reports completion via `status` plus `incomplete_details`.
export function mapResponsesStop(status: string, incompleteReason?: string): ProviderStopReason {
  if (incompleteReason === 'max_output_tokens') return 'max_tokens';
  if (incompleteReason === 'content_filter') return 'refusal';
  switch (status) {
    case 'completed':
      return 'complete';
    case 'incomplete':
      return incompleteReason ? 'other' : 'complete';
    default:
      return status ? 'other' : 'complete';
  }
}

// The Responses web-search tool inlines source citations into the spoken text
// as markdown links, e.g. "…the IEA reported ([iea-pvps.org](https://…))". A
// voice actor would read that URL aloud, and it must not reach the spoken
// export, so we strip these artifacts here — the real sources are preserved
// separately in `searches`. Anthropic and Google emit clean speech and need no
// equivalent. Order matters: remove wrapped citations before bare links.
export function stripInlineCitations(text: string): string {
  return text
    // "([label](https://…))" — the wrapped citation the tool emits
    .replace(/\s*\(\[[^\]]*\]\(https?:\/\/[^\s)]+\)\)/g, '')
    // "[label](https://…)" — a bare markdown link; keep the label text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    // "(https://…)" — a bare parenthetical URL
    .replace(/\s*\(https?:\/\/[^\s)]+\)/g, '')
    // any remaining bare URL token
    .replace(/\s*https?:\/\/[^\s)]+/g, '')
    // tidy the seams left behind
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
}

// Concatenate the text of every output_text part across all message items.
export function extractText(output: any[]): string {
  if (!Array.isArray(output)) return '';
  let out = '';
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        out += part.text;
      }
    }
  }
  return stripInlineCitations(out);
}

// Cap sources per turn. `action.sources` returns the tool's full result set
// (often 40+), which would swamp the transcript panel; a dozen is plenty to
// verify grounding and matches the Anthropic path's magnitude.
const MAX_SOURCES_PER_TURN = 15;

// Queries live on web_search_call items (action.queries). Sources come from
// action.sources — the tool's actual results, requested via the `include`
// parameter. Unlike url_citation annotations, these are present whether or not
// the model cites in speech, so grounding is captured even though our prompt
// forbids reading URLs aloud. We fall back to annotations if `include` was not
// honoured. Sources aren't mapped per query, so (like Google) we attach them to
// the joined query string.
export function extractResponsesSearches(output: any[]): TurnSearch[] | undefined {
  if (!Array.isArray(output)) return undefined;
  const queries: string[] = [];
  const sources: { url: string; title?: string }[] = [];
  const seen = new Set<string>();
  const addSource = (url: unknown, title?: unknown) => {
    if (typeof url !== 'string' || !url || seen.has(url)) return;
    if (sources.length >= MAX_SOURCES_PER_TURN) return;
    seen.add(url);
    sources.push({ url, title: typeof title === 'string' ? title : undefined });
  };

  for (const item of output) {
    if (item?.type === 'web_search_call') {
      const action = item?.action ?? {};
      const qs = action.queries;
      if (Array.isArray(qs)) {
        for (const q of qs) if (q) queries.push(String(q));
      } else if (action.query) {
        queries.push(String(action.query));
      }
      // Primary source: the search action's own result list.
      if (Array.isArray(action.sources)) {
        for (const s of action.sources) addSource(s?.url, s?.title);
      }
    }
    // Backfill from url_citation annotations if the search call carried none.
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        const anns = Array.isArray(part?.annotations) ? part.annotations : [];
        for (const a of anns) {
          if (a?.type === 'url_citation') addSource(a?.url, a?.title);
        }
      }
    }
  }
  if (queries.length === 0 && sources.length === 0) return undefined;
  return [{ query: queries.join(' | ') || '(web search)', sources }];
}

export function createOpenAIResponsesAdapter(apiKey: string): ProviderAdapter {
  return {
    id: 'openai',
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const input = params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const useWebSearch = Boolean(params.webSearchMaxUses && params.webSearchMaxUses > 0);

      // Self-heal: some reasoning models reject `temperature`. Retry without it.
      let useTemperature = true;
      const makeBody = () => ({
        model: params.apiModelString,
        instructions: params.systemPrompt || undefined,
        input,
        max_output_tokens: params.maxTokens,
        ...(useTemperature ? { temperature: params.temperature } : {}),
        ...(useWebSearch
          ? {
              tools: [{ type: 'web_search' }],
              // Return the tool's result URLs on the search call itself, so we
              // capture sources even when the model doesn't cite them in speech.
              include: ['web_search_call.action.sources'],
            }
          : {}),
      });

      const start = Date.now();
      let res = await postJson(API_URL, makeBody(), headers);
      for (let i = 0; i < 2 && !res.ok && res.status === 400; i++) {
        const msg = res.json?.error?.message ?? res.text ?? '';
        if (useTemperature && /temperature/i.test(msg)) {
          useTemperature = false;
        } else {
          break; // not a recoverable parameter error
        }
        res = await postJson(API_URL, makeBody(), headers);
      }
      const { ok, status, json, text } = res;
      const latencyMs = Date.now() - start;

      if (!ok) {
        const detail =
          json?.error?.message ?? text?.slice(0, 300) ?? 'Unknown error';
        throw new ProviderError(`openai ${status}: ${detail}`, {
          status,
          provider: 'openai',
          rawBody: text,
        });
      }

      const output = json?.output ?? [];
      const outText = extractText(output);
      const incompleteReason: string | undefined = json?.incomplete_details?.reason;
      const rawStopReason: string = incompleteReason ?? json?.status ?? '';

      return {
        text: outText.trim(),
        stopReason: mapResponsesStop(json?.status ?? '', incompleteReason),
        rawStopReason,
        inputTokens: json?.usage?.input_tokens ?? 0,
        outputTokens: json?.usage?.output_tokens ?? 0,
        latencyMs,
        rawModel: json?.model,
        searches: useWebSearch ? extractResponsesSearches(output) : undefined,
      };
    },
  };
}
