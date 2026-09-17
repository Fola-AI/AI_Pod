// Base adapter for OpenAI-compatible Chat Completions endpoints.
// OpenAI, and (in Phase 2) xAI, DeepSeek, Mistral, and Alibaba all speak this
// shape — they differ only in base URL and API key. Specialise elsewhere only
// where the API genuinely differs (Anthropic's system param, Google's contents).

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderId,
  ProviderStopReason,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

// NOTE: web search is NOT handled here. OpenAI's web search lives only on the
// Responses API (see openai-responses.ts); the OpenAI-compatible providers that
// share this base (xAI, DeepSeek, Groq, Mistral, Alibaba, Meta) have no Chat
// Completions web search, so this adapter deliberately stays search-free.

function mapOpenAIStop(reason: string): ProviderStopReason {
  switch (reason) {
    case 'stop':
      return 'complete';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return reason ? 'other' : 'complete';
  }
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
      const messages: { role: string; content: string }[] = [];

      if (supportsSystemRole && params.systemPrompt) {
        messages.push({ role: 'system', content: params.systemPrompt });
        for (const m of params.messages) messages.push(m);
      } else {
        // Fold the system prompt into the first user message.
        let systemFolded = false;
        for (let i = 0; i < params.messages.length; i++) {
          const m = params.messages[i];
          if (!systemFolded && m.role === 'user' && params.systemPrompt) {
            messages.push({
              role: 'user',
              content: `${params.systemPrompt}\n\n${m.content}`,
            });
            systemFolded = true;
          } else {
            messages.push(m);
          }
        }
        if (!systemFolded && params.systemPrompt) {
          messages.unshift({ role: 'user', content: params.systemPrompt });
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
        messages,
        [tokenParam]: params.maxTokens,
        ...(useTemperature ? { temperature: params.temperature } : {}),
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

      const outText: string = json?.choices?.[0]?.message?.content ?? '';
      const inputTokens: number = json?.usage?.prompt_tokens ?? 0;
      const outputTokens: number = json?.usage?.completion_tokens ?? 0;
      const rawStopReason: string = json?.choices?.[0]?.finish_reason ?? '';

      return {
        text: outText.trim(),
        stopReason: mapOpenAIStop(rawStopReason),
        rawStopReason,
        inputTokens,
        outputTokens,
        latencyMs,
        rawModel: json?.model,
      };
    },
  };
}
