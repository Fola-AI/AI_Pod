import { NextResponse } from 'next/server';
import { closeSession, getSession } from '@/lib/db/queries';

export const runtime = 'nodejs';

// Stop & close: end the session immediately, as it stands. A turn still being
// generated when this lands is discarded by /api/turn (it re-checks the status
// before saving), so nothing is appended after the close.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const existing = await getSession(id);
  if (!existing) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const session = await closeSession(id);
  return NextResponse.json({ session });
}
