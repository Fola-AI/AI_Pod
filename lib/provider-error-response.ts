// Builds a consistent API error payload from a caught provider failure, and
// logs the raw provider body server-side for every fatal/empty (P0-2 §3).

import { ProviderError } from '@/lib/providers/errors';
import { getModel } from '@/config/models';

export interface ProviderErrorContext {
  agentId: string; // agent.id or 'moderator'
  agentName: string;
  modelId: string;
}

export interface ProviderErrorPayload {
  status: number;
  body: {
    error: string; // provider's verbatim message
    code: 'missing_key' | 'fatal' | 'rate_limit' | 'transient' | 'unknown';
    failureClass: 'fatal' | 'transient' | 'unknown';
    provider?: string;
    agentId: string;
    agentName: string;
    modelId: string;
    model: string;
    recoverable: boolean;
  };
}

export function providerErrorPayload(
  err: unknown,
  ctx: ProviderErrorContext,
): ProviderErrorPayload {
  const modelDisplay = getModel(ctx.modelId)?.displayName ?? ctx.modelId;

  if (err instanceof ProviderError) {
    const fatal = err.failureClass === 'fatal';
    // Log the full raw body for fatal (and empty, which is fatal) failures.
    if (fatal) {
      console.error(
        `[provider ${err.provider}] FATAL for agent "${ctx.agentName}" on ${ctx.modelId}: ${err.message}`,
        err.rawBody ? `\n  raw: ${err.rawBody}` : '',
      );
    }
    return {
      status: fatal ? 400 : 502,
      body: {
        error: err.message,
        code:
          err.name === 'MissingKeyError'
            ? 'missing_key'
            : fatal
              ? 'fatal'
              : err.isRateLimit
                ? 'rate_limit'
                : 'transient',
        failureClass: err.failureClass,
        provider: err.provider,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        modelId: ctx.modelId,
        model: modelDisplay,
        recoverable: !fatal,
      },
    };
  }

  console.error(
    `[turn] Unexpected error for agent "${ctx.agentName}" on ${ctx.modelId}:`,
    err,
  );
  return {
    status: 500,
    body: {
      error: (err as Error).message ?? 'Unknown error',
      code: 'unknown',
      failureClass: 'unknown',
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      modelId: ctx.modelId,
      model: modelDisplay,
      recoverable: true,
    },
  };
}
