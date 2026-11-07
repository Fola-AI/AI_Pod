import { NextResponse } from 'next/server';
import { getSession, resetSession } from '@/lib/db/queries';

export const runtime = 'nodejs';

// Rerun: delete every turn and reset the session to a fresh draft, keeping the
// config so Run regenerates from scratch. Destructive — the client confirms.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const existing = await getSession(id);
  if (!existing) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const session = await resetSession(id);
  return NextResponse.json({ session });
}
