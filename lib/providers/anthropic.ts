// Anthropic Messages API adapter. Differs from OpenAI in that `system` is a
// top-level parameter, not a message, and usage is input_tokens/output_tokens.

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  return {
    id: 'anthropic',
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const headers = {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      };
      const baseBody = {
        model: params.apiModelString,
        system: params.systemPrompt || undefined,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: params.maxTokens,
      };

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
        });
      }

      // content is an array of blocks; concatenate the text blocks.
      const outText: string = Array.isArray(json?.content)
        ? json.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
        : '';

      return {
        text: outText.trim(),
        inputTokens: json?.usage?.input_tokens ?? 0,
        outputTokens: json?.usage?.output_tokens ?? 0,
        latencyMs,
      };
    },
  };
}
