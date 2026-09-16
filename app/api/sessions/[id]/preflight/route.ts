import { NextResponse } from 'next/server';
import { getSession } from '@/lib/db/queries';
import { getModel } from '@/config/models';
import {
  getAdapter,
  hasProviderKey,
  isProviderImplemented,
} from '@/lib/providers';
import { ProviderError } from '@/lib/providers/errors';

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
      if (!isProviderImplemented(model.provider)) {
        return {
          modelId,
          displayName,
          ok: false,
          message: `No adapter for provider "${model.provider}".`,
        };
      }
      if (!hasProviderKey(model.provider)) {
        return {
          modelId,
          displayName,
          ok: false,
          message: `Missing API key for ${model.provider}.`,
        };
      }
      try {
        const adapter = getAdapter(model.provider);
        await adapter.generate({
          apiModelString: model.apiModelString,
          systemPrompt: 'Reply with the single word: ok',
          messages: [{ role: 'user', content: 'ok' }],
          temperature: 0,
          maxTokens: 10,
        });
        return { modelId, displayName, ok: true };
      } catch (err) {
        const message =
          err instanceof ProviderError
            ? err.message
            : (err as Error).message;
        if (err instanceof ProviderError && err.rawBody) {
          console.error(`[preflight] ${modelId} failed: ${err.rawBody}`);
        }
        return { modelId, displayName, ok: false, message };
      }
    }),
  );

  const allOk = checks.every((c) => c.ok);
  return NextResponse.json({ ok: allOk, checks });
}
