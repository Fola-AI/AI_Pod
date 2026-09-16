import { NextResponse } from 'next/server';
import { getSession, setSessionClaims } from '@/lib/db/queries';
import { extractClaims } from '@/lib/claims';
import { MissingKeyError, ProviderError } from '@/lib/providers/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.turns.length === 0) {
    return NextResponse.json({ claims: [] });
  }
  try {
    const claims = await extractClaims(session);
    await setSessionClaims(id, claims); // persisted → included in JSON export
    return NextResponse.json({ claims });
  } catch (err) {
    if (err instanceof MissingKeyError || err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
