// Base adapter for OpenAI-compatible Chat Completions endpoints.
// OpenAI, and (in Phase 2) xAI, DeepSeek, Mistral, and Alibaba all speak this
// shape — they differ only in base URL and API key. Specialise elsewhere only
// where the API genuinely differs (Anthropic's system param, Google's contents).

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderId,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

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

      const start = Date.now();
      const { ok, status, json, text } = await postJson(
        `${cfg.baseUrl}/chat/completions`,
        {
          model: params.apiModelString,
          messages,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
        },
        { Authorization: `Bearer ${cfg.apiKey}` },
      );
      const latencyMs = Date.now() - start;

      if (!ok) {
        const detail =
          json?.error?.message ?? text?.slice(0, 300) ?? 'Unknown error';
        throw new ProviderError(`${cfg.id} ${status}: ${detail}`, {
          status,
          provider: cfg.id,
        });
      }

      const outText: string = json?.choices?.[0]?.message?.content ?? '';
      const inputTokens: number = json?.usage?.prompt_tokens ?? 0;
      const outputTokens: number = json?.usage?.completion_tokens ?? 0;

      return {
        text: outText.trim(),
        inputTokens,
        outputTokens,
        latencyMs,
      };
    },
  };
}
