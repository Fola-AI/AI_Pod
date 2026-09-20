import { NextResponse } from 'next/server';
import { getSession } from '@/lib/db/queries';
import { getModel } from '@/config/models';
import { getAdapter, hasModelKey } from '@/lib/providers';
import { ProviderError } from '@/lib/providers/errors';
import { preflightMaxTokens } from '@/lib/turn-budget';
import { recordModelTest } from '@/lib/model-health';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface ModelCheck {
  modelId: string;
  displayName: string;
  ok: boolean;
  message?: string;
}

// Pre-flight (P0-3 §2): for every distinct model in the session, confirm the
// key is present and make one cheap call. Blocks a session before turn 1 if any
// model can't be reached, surfacing the provider's own error message.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const modelIds = Array.from(
    new Set([
      ...session.config.agents.map((a) => a.modelId),
      session.config.moderator.modelId,
    ]),
  );

  const checks: ModelCheck[] = await Promise.all(
    modelIds.map(async (modelId): Promise<ModelCheck> => {
      const model = getModel(modelId);
      const displayName = model?.displayName ?? modelId;
      if (!model) {
        return { modelId, displayName, ok: false, message: 'Unknown model id.' };
      }
      // Key-only gate here so preflight always re-tests (never blocked by a
      // stale cached failure); the real call below refreshes the health cache.
      if (!hasModelKey(model)) {
        const message =
          model.route === 'openrouter'
            ? 'Missing OpenRouter API key (set OPENROUTER_API_KEY).'
            : `Missing API key or adapter for ${model.provider}.`;
        recordModelTest(model.id, false, message);
        return { modelId, displayName, ok: false, message };
      }
      try {
        const adapter = getAdapter(model.provider, model.route);
        await adapter.generate({
          apiModelString: model.apiModelString,
          systemPrompt: 'Reply with the single word: ok',
          messages: [{ role: 'user', content: 'ok' }],
          temperature: 0,
          // Same floor a real turn uses — a tiny budget is rejected by reasoning
          // models ("max_output_tokens below minimum") that run fine in session.
          maxTokens: preflightMaxTokens(model.id),
        });
        recordModelTest(model.id, true);
        return { modelId, displayName, ok: true };
      } catch (err) {
        const message =
          err instanceof ProviderError
            ? err.message
            : (err as Error).message;
        if (err instanceof ProviderError && err.rawBody) {
          console.error(`[preflight] ${modelId} failed: ${err.rawBody}`);
        }
        recordModelTest(model.id, false, message);
        return { modelId, displayName, ok: false, message };
      }
    }),
  );

  const allOk = checks.every((c) => c.ok);
  return NextResponse.json({ ok: allOk, checks });
}
