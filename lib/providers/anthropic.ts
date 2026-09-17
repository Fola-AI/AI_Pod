// Anthropic Messages API adapter. Differs from OpenAI in that `system` is a
// top-level parameter, not a message, and usage is input_tokens/output_tokens.

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderStopReason,
  TurnSearch,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

// Pair each web_search query (server_tool_use) with its results
// (web_search_tool_result) by tool_use_id. Errors come back as an object, not a
// list — skip those (P1-2 note: server-tool errors are HTTP 200).
function extractAnthropicSearches(content: any[]): TurnSearch[] {
  if (!Array.isArray(content)) return [];
  const queries = new Map<string, string>();
  for (const b of content) {
    if (b?.type === 'server_tool_use' && b?.name === 'web_search') {
      queries.set(b.id, b.input?.query ?? '');
    }
  }
  const searches: TurnSearch[] = [];
  for (const b of content) {
    if (b?.type === 'web_search_tool_result') {
      const results = Array.isArray(b.content) ? b.content : [];
      const sources = results
        .filter((r: any) => r?.type === 'web_search_result' && r?.url)
        .map((r: any) => ({ url: r.url as string, title: r.title as string | undefined }));
      searches.push({ query: queries.get(b.tool_use_id) ?? '', sources });
    }
  }
  return searches;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function mapAnthropicStop(reason: string): ProviderStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return reason ? 'other' : 'complete';
  }
}

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  return {
    id: 'anthropic',
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const headers = {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      };
      const baseBody: Record<string, unknown> = {
        model: params.apiModelString,
        system: params.systemPrompt || undefined,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: params.maxTokens,
      };
      if (params.webSearchMaxUses && params.webSearchMaxUses > 0) {
        baseBody.tools = [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: params.webSearchMaxUses,
          },
        ];
      }

      const start = Date.now();
      let res = await postJson(
        API_URL,
        { ...baseBody, temperature: params.temperature },
        headers,
      );
      // Some newer models deprecate `temperature`; retry without it.
      if (
        !res.ok &&
        res.status === 400 &&
        /temperature/i.test(res.json?.error?.message ?? res.text ?? '')
      ) {
        res = await postJson(API_URL, baseBody, headers);
      }
      const { ok, status, json, text } = res;
      const latencyMs = Date.now() - start;

      if (!ok) {
        const detail =
          json?.error?.message ?? text?.slice(0, 300) ?? 'Unknown error';
        throw new ProviderError(`anthropic ${status}: ${detail}`, {
          status,
          provider: 'anthropic',
          rawBody: text,
        });
      }

      // content is an array of blocks; concatenate the text blocks.
      const outText: string = Array.isArray(json?.content)
        ? json.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
        : '';
      const rawStopReason: string = json?.stop_reason ?? '';

      const searches = params.webSearchMaxUses
        ? extractAnthropicSearches(json?.content)
        : undefined;

      return {
        text: outText.trim(),
        stopReason: mapAnthropicStop(rawStopReason),
        rawStopReason,
        inputTokens: json?.usage?.input_tokens ?? 0,
        outputTokens: json?.usage?.output_tokens ?? 0,
        latencyMs,
        rawModel: json?.model,
        searches: searches && searches.length ? searches : undefined,
      };
    },
  };
}
