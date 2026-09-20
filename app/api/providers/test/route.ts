import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { ProviderId } from '@/lib/types';
import { MODELS, PROVIDER_ENV_KEY } from '@/config/models';
import { getAdapter, hasModelKey } from '@/lib/providers';
import { ProviderError } from '@/lib/providers/errors';
import { recordModelTest } from '@/lib/model-health';
import { preflightMaxTokens } from '@/lib/turn-budget';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Accept EITHER a modelId (per-model test — the registry screen) or a provider
// (tests that vendor's first enabled model — back-compat).
const bodySchema = z.object({
  provider: z
    .enum(Object.keys(PROVIDER_ENV_KEY) as [ProviderId, ...ProviderId[]])
    .optional(),
  modelId: z.string().optional(),
});

// Test connection (P1-4 §1): one cheap call with the chosen model. Returns
// pass/fail plus the provider's message on failure.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || (!parsed.data.provider && !parsed.data.modelId)) {
    return NextResponse.json({ error: 'Provide a modelId or provider' }, { status: 400 });
  }
  const { provider, modelId } = parsed.data;

  const model = modelId
    ? MODELS.find((m) => m.id === modelId)
    : MODELS.find((m) => m.provider === provider && m.enabled);
  if (!model) {
    return NextResponse.json({ ok: false, message: 'No model in registry.' });
  }
  if (!hasModelKey(model)) {
    const message =
      model.route === 'openrouter'
        ? 'No OpenRouter key configured.'
        : 'No API key configured.';
    recordModelTest(model.id, false, message);
    return NextResponse.json({ ok: false, model: model.displayName, message });
  }

  try {
    await getAdapter(model.provider, model.route).generate({
      apiModelString: model.apiModelString,
      systemPrompt: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ok' }],
      temperature: 0,
      // Same floor a real turn uses (see turn-budget) — a 10-token call is
      // rejected by reasoning models that run fine in a session.
      maxTokens: preflightMaxTokens(model.id),
    });
    recordModelTest(model.id, true);
    return NextResponse.json({ ok: true, model: model.displayName });
  } catch (err) {
    const message =
      err instanceof ProviderError ? err.message : (err as Error).message;
    if (err instanceof ProviderError && err.rawBody) {
      console.error(`[provider test] ${model.id} failed: ${err.rawBody}`);
    }
    recordModelTest(model.id, false, message);
    return NextResponse.json({ ok: false, model: model.displayName, message });
  }
}
