import { NextResponse } from 'next/server';
import { getSession, setSessionColdOpen } from '@/lib/db/queries';
import { findColdOpen } from '@/lib/cold-open';
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
    return NextResponse.json({ error: 'Nothing to open with' }, { status: 400 });
  }
  try {
    const coldOpen = await findColdOpen(session);
    if (!coldOpen) {
      return NextResponse.json({ coldOpen: null });
    }
    await setSessionColdOpen(id, coldOpen);
    return NextResponse.json({ coldOpen });
  } catch (err) {
    if (err instanceof MissingKeyError || err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
