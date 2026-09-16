import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { ProviderId } from '@/lib/types';
import { MODELS, PROVIDER_ENV_KEY } from '@/config/models';
import {
  getAdapter,
  hasProviderKey,
  isProviderImplemented,
} from '@/lib/providers';
import { ProviderError } from '@/lib/providers/errors';

export const runtime = 'nodejs';
export const maxDuration = 30;

const bodySchema = z.object({
  provider: z.enum(
    Object.keys(PROVIDER_ENV_KEY) as [ProviderId, ...ProviderId[]],
  ),
});

// Test connection for a single provider (P1-4 §1): one cheap call with a
// representative model. Returns pass/fail plus the provider's message on failure.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }
  const provider = parsed.data.provider;

  if (!isProviderImplemented(provider)) {
    return NextResponse.json({ ok: false, message: 'No adapter implemented.' });
  }
  if (!hasProviderKey(provider)) {
    return NextResponse.json({ ok: false, message: 'No API key configured.' });
  }
  const model = MODELS.find((m) => m.provider === provider && m.enabled);
  if (!model) {
    return NextResponse.json({ ok: false, message: 'No model in registry.' });
  }

  try {
    await getAdapter(provider).generate({
      apiModelString: model.apiModelString,
      systemPrompt: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ok' }],
      temperature: 0,
      maxTokens: 10,
    });
    return NextResponse.json({ ok: true, model: model.displayName });
  } catch (err) {
    const message =
      err instanceof ProviderError ? err.message : (err as Error).message;
    if (err instanceof ProviderError && err.rawBody) {
      console.error(`[provider test] ${provider} failed: ${err.rawBody}`);
    }
    return NextResponse.json({ ok: false, model: model.displayName, message });
  }
}
