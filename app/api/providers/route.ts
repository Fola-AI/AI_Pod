import { NextResponse } from 'next/server';
import type { ProviderId } from '@/lib/types';
import { MODELS, PROVIDER_ENV_KEY } from '@/config/models';
import {
  hasOpenRouterKey,
  hasProviderKey,
  isModelAvailable,
  isProviderImplemented,
} from '@/lib/providers';
import { allModelTests } from '@/lib/model-health';

export const runtime = 'nodejs';

export async function GET() {
  const providers = Object.keys(PROVIDER_ENV_KEY) as ProviderId[];
  const available: Record<string, boolean> = {};
  const implemented: Record<string, boolean> = {};
  const hasKey: Record<string, boolean> = {};
  for (const p of providers) {
    // A vendor's availability is now model-driven: its models may route direct
    // or via OpenRouter, so we ask whether any enabled model of the vendor is
    // usable rather than assuming the vendor has its own direct adapter/key.
    const models = MODELS.filter((m) => m.provider === p && m.enabled);
    const routesViaOpenRouter = models.some((m) => m.route === 'openrouter');
    implemented[p] = isProviderImplemented(p) || routesViaOpenRouter;
    hasKey[p] = routesViaOpenRouter ? hasOpenRouterKey() : hasProviderKey(p);
    available[p] = models.some((m) => isModelAvailable(m));
  }
  // Key values are never sent — only presence. `modelTests` is the last
  // per-model test result (route-aware availability reflects it too).
  return NextResponse.json({ available, implemented, hasKey, modelTests: allModelTests() });
}
