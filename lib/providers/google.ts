// Google Gemini adapter. Differs in the request shape (contents/parts, roles are
// 'user'/'model'), the systemInstruction field, and usageMetadata token counts.

import type {
  ChatMessage,
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderStopReason,
  ToolCall,
  TurnSearch,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';
import { WEB_SEARCH_TOOL } from '@/lib/search';

// Google returns grounding as webSearchQueries (list) + groundingChunks (list of
// {web:{uri,title}}). Sources aren't mapped per query, so we attach them all.
function extractGoogleSearches(candidate: any): TurnSearch[] | undefined {
  const meta = candidate?.groundingMetadata;
  if (!meta) return undefined;
  const fetchedAt = new Date().toISOString();
  const queries: string[] = Array.isArray(meta.webSearchQueries)
    ? meta.webSearchQueries
    : [];
  const results = (Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [])
    .map((c: any) => c?.web)
    .filter((w: any) => w?.uri)
    .map((w: any) => ({
      title: (w.title as string) ?? '',
      url: w.uri as string,
      snippet: '',
      fetchedAt,
    }));
  if (queries.length === 0 && results.length === 0) return undefined;
  return [
    {
      mode: 'native',
      query: queries.join(' | ') || '(web search)',
      results,
      provider: 'google',
      latencyMs: 0,
    },
  ];
}

// Map our ChatMessage union to Gemini `contents`. Consecutive tool results are
// coalesced into one user turn of functionResponse parts (alternating roles).
function buildGoogleContents(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  let pending: any[] = [];
  const flush = () => {
    if (pending.length) {
      out.push({ role: 'user', parts: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      pending.push({
        functionResponse: {
          name: WEB_SEARCH_TOOL.name,
          response: { result: m.content },
        },
      });
      continue;
    }
    flush();
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'model',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            functionCall: { name: WEB_SEARCH_TOOL.name, args: { query: tc.query } },
          })),
        ],
      });
    } else {
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
  }
  flush();
  return out;
}

// Parse functionCall parts into ToolCalls (shared mode). Gemini gives no call
// id, so we synthesise one; functionResponse pairs by name/position.
function parseGoogleToolCalls(parts: any[]): ToolCall[] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const out: ToolCall[] = [];
  parts.forEach((p: any, i: number) => {
    if (p?.functionCall?.name === WEB_SEARCH_TOOL.name) {
      out.push({ id: `fc_${i}`, query: String(p.functionCall.args?.query ?? '') });
    }
  });
  return out.length ? out : undefined;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function mapGoogleStop(reason: string): ProviderStopReason {
  switch (reason) {
    case 'STOP':
      return 'complete';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'refusal';
    default:
      return reason ? 'other' : 'complete';
  }
}

export function createGoogleAdapter(apiKey: string): ProviderAdapter {
  return {
    id: 'google',
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const contents = buildGoogleContents(params.messages);

      const start = Date.now();
      const url = `${BASE}/${params.apiModelString}:generateContent?key=${encodeURIComponent(
        apiKey,
      )}`;
      const { ok, status, json, text } = await postJson(
        url,
        {
          systemInstruction: params.systemPrompt
            ? { parts: [{ text: params.systemPrompt }] }
            : undefined,
          contents,
          generationConfig: {
            temperature: params.temperature,
            maxOutputTokens: params.maxTokens,
          },
          // Shared function tool (B-5.5) and native grounding are mutually
          // exclusive — a session runs in exactly one mode.
          ...(params.searchTool
            ? {
                tools: [
                  {
                    functionDeclarations: [
                      {
                        name: WEB_SEARCH_TOOL.name,
                        description: WEB_SEARCH_TOOL.description,
                        parameters: WEB_SEARCH_TOOL.parameters,
                      },
                    ],
                  },
                ],
                toolConfig: {
                  functionCallingConfig: {
                    mode:
                      params.toolChoice === 'none'
                        ? 'NONE'
                        : params.toolChoice === 'required'
                          ? 'ANY'
                          : 'AUTO',
                  },
                },
              }
            : params.webSearchMaxUses
              ? { tools: [{ google_search: {} }] }
              : {}),
        },
        {},
      );
      const latencyMs = Date.now() - start;

      if (!ok) {
        const detail =
          json?.error?.message ?? text?.slice(0, 300) ?? 'Unknown error';
        throw new ProviderError(`google ${status}: ${detail}`, {
          status,
          provider: 'google',
          rawBody: text,
        });
      }

      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      const outText: string = Array.isArray(parts)
        ? parts.map((p: any) => p.text ?? '').join('')
        : '';
      const rawStopReason: string = json?.candidates?.[0]?.finishReason ?? '';
      const toolCalls = params.searchTool ? parseGoogleToolCalls(parts) : undefined;

      return {
        text: outText.trim(),
        stopReason: toolCalls?.length ? 'tool_calls' : mapGoogleStop(rawStopReason),
        rawStopReason,
        inputTokens: json?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs,
        rawModel: json?.modelVersion,
        searches: params.webSearchMaxUses
          ? extractGoogleSearches(json?.candidates?.[0])
          : undefined,
        toolCalls,
      };
    },
  };
}
