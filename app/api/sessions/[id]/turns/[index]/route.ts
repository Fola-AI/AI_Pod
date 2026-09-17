import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getSession,
  updateTurnText,
  updateTurnTaggedText,
  deleteTurnAndRenumber,
  markTurnsStaleAfter,
  recomputeAggregates,
} from '@/lib/db/queries';

export const runtime = 'nodejs';

const patchSchema = z.union([
  z.object({ text: z.string().min(1) }),
  z.object({ taggedText: z.string() }),
]);

// Inline edit of a turn's spoken text, or a hand-edit of its voice-pass tags.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const idx = Number(index);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'text or taggedText required' }, { status: 400 });
  }
  try {
    if ('taggedText' in parsed.data) {
      await updateTurnTaggedText(id, idx, parsed.data.taggedText);
      return NextResponse.json({ ok: true });
    }
    await updateTurnText(id, idx, parsed.data.text);
    await markTurnsStaleAfter(id, idx);
    const totals = await recomputeAggregates(id);
    return NextResponse.json({ ok: true, ...totals });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

// Delete a turn and renumber the rest.
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const idx = Number(index);
  try {
    await deleteTurnAndRenumber(id, idx);
    const totals = await recomputeAggregates(id);
    const session = await getSession(id);
    return NextResponse.json({ ok: true, ...totals, turns: session?.turns ?? [] });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
