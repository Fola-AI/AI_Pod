// Base adapter for OpenAI-compatible Chat Completions endpoints.
// OpenAI, and (in Phase 2) xAI, DeepSeek, Mistral, and Alibaba all speak this
// shape — they differ only in base URL and API key. Specialise elsewhere only
// where the API genuinely differs (Anthropic's system param, Google's contents).

import type {
  ChatMessage,
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderId,
  ProviderStopReason,
  ToolCall,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';
import { WEB_SEARCH_TOOL } from '@/lib/search';

// NOTE: native web search is NOT handled here. OpenAI's native web search lives
// on the Responses API (openai-responses.ts); the OpenAI-compatible providers
// that share this base (xAI, DeepSeek, Groq, Mistral, Alibaba, Meta) have no
// native Chat Completions web search. What this base DOES support is the shared
// web_search *function tool* (B-5.5) via standard function calling.

function mapOpenAIStop(reason: string): ProviderStopReason {
  switch (reason) {
    case 'stop':
      return 'complete';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'tool_calls':
      return 'tool_calls';
    default:
      return reason ? 'other' : 'complete';
  }
}

// Map our ChatMessage union to the Chat Completions wire shape.
function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content ?? '',
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: WEB_SEARCH_TOOL.name, arguments: JSON.stringify({ query: tc.query }) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

// Parse web_search tool calls out of a Chat Completions message.
function parseToolCalls(message: any): ToolCall[] | undefined {
  const tcs = message?.tool_calls;
  if (!Array.isArray(tcs)) return undefined;
  const out: ToolCall[] = [];
  for (const tc of tcs) {
    if (tc?.function?.name !== WEB_SEARCH_TOOL.name) continue;
    let query = '';
    try {
      query = JSON.parse(tc.function.arguments || '{}')?.query ?? '';
    } catch {
      /* malformed args — skip query */
    }
    out.push({ id: tc.id ?? crypto.randomUUID(), query: String(query) });
  }
  return out.length ? out : undefined;
}

export interface OpenAICompatibleConfig {
  id: ProviderId;
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  /** Some providers reject a `system` role; fold it into the first user turn. */
  supportsSystemRole?: boolean;
}

export function createOpenAICompatibleAdapter(
  cfg: OpenAICompatibleConfig,
): ProviderAdapter {
  const supportsSystemRole = cfg.supportsSystemRole ?? true;

  return {
    id: cfg.id,
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const wire: Record<string, unknown>[] = params.messages.map(toWire);
      if (supportsSystemRole && params.systemPrompt) {
        wire.unshift({ role: 'system', content: params.systemPrompt });
      } else if (params.systemPrompt) {
        // No system role: fold the system prompt into the first user message.
        const firstUser = wire.find((w) => w.role === 'user');
        if (firstUser) {
          firstUser.content = `${params.systemPrompt}\n\n${firstUser.content}`;
        } else {
          wire.unshift({ role: 'user', content: params.systemPrompt });
        }
      }

      const url = `${cfg.baseUrl}/chat/completions`;
      const headers = { Authorization: `Bearer ${cfg.apiKey}` };

      // Self-heal per-model parameter quirks: some models reject a non-default
      // `temperature`, and newer OpenAI models require `max_completion_tokens`
      // instead of `max_tokens`. Retry with the offending parameter adjusted.
      let useTemperature = true;
      let tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
      const makeBody = () => ({
        model: params.apiModelString,
        messages: wire,
        [tokenParam]: params.maxTokens,
        ...(useTemperature ? { temperature: params.temperature } : {}),
        // Shared web_search function tool (B-5.5).
        ...(params.searchTool
          ? {
              tools: [
                {
                  type: 'function',
                  function: {
                    name: WEB_SEARCH_TOOL.name,
                    description: WEB_SEARCH_TOOL.description,
                    parameters: WEB_SEARCH_TOOL.parameters,
                  },
                },
              ],
              tool_choice: params.toolChoice ?? 'auto',
            }
          : {}),
      });
      const start = Date.now();
      let res = await postJson(url, makeBody(), headers);
      for (let i = 0; i < 3 && !res.ok && res.status === 400; i++) {
        const msg = res.json?.error?.message ?? res.text ?? '';
        if (useTemperature && /temperature/i.test(msg)) {
          useTemperature = false;
        } else if (
          tokenParam === 'max_tokens' &&
          /max_tokens|max_completion_tokens/i.test(msg)
        ) {
          tokenParam = 'max_completion_tokens';
        } else {
          break; // not a recoverable parameter error
        }
        res = await postJson(url, makeBody(), headers);
      }
      const { ok, status, json, text } = res;
      const latencyMs = Date.now() - start;

      if (!ok) {
        const detail =
          json?.error?.message ?? text?.slice(0, 300) ?? 'Unknown error';
        throw new ProviderError(`${cfg.id} ${status}: ${detail}`, {
          status,
          provider: cfg.id,
          rawBody: text,
        });
      }

      const message = json?.choices?.[0]?.message;
      const outText: string = message?.content ?? '';
      const inputTokens: number = json?.usage?.prompt_tokens ?? 0;
      const outputTokens: number = json?.usage?.completion_tokens ?? 0;
      const rawStopReason: string = json?.choices?.[0]?.finish_reason ?? '';
      const toolCalls = params.searchTool ? parseToolCalls(message) : undefined;

      return {
        text: outText.trim(),
        stopReason: toolCalls?.length ? 'tool_calls' : mapOpenAIStop(rawStopReason),
        rawStopReason,
        inputTokens,
        outputTokens,
        latencyMs,
        rawModel: json?.model,
        toolCalls,
      };
    },
  };
}
