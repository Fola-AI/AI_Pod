// Google Gemini adapter. Differs in the request shape (contents/parts, roles are
// 'user'/'model'), the systemInstruction field, and usageMetadata token counts.

import type {
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  ProviderStopReason,
} from '@/lib/types';
import { ProviderError } from './errors';
import { postJson } from './http';

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
      const contents = params.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

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

      return {
        text: outText.trim(),
        stopReason: mapGoogleStop(rawStopReason),
        rawStopReason,
        inputTokens: json?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs,
        rawModel: json?.modelVersion,
      };
    },
  };
}
