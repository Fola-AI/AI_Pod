import { NextResponse } from 'next/server';
import type { ProviderId } from '@/lib/types';
import { PROVIDER_ENV_KEY } from '@/config/models';
import { hasProviderKey, isProviderImplemented } from '@/lib/providers';

export const runtime = 'nodejs';

export async function GET() {
  const providers = Object.keys(PROVIDER_ENV_KEY) as ProviderId[];
  const available: Record<string, boolean> = {};
  const implemented: Record<string, boolean> = {};
  for (const p of providers) {
    implemented[p] = isProviderImplemented(p);
    available[p] = isProviderImplemented(p) && hasProviderKey(p);
  }
  return NextResponse.json({ available, implemented });
}
