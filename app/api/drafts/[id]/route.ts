import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteDraft, getDraft, updateDraft } from '@/lib/db/queries';

export const runtime = 'nodejs';

const bodySchema = z.object({ state: z.record(z.string(), z.unknown()) });

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const draft = await getDraft(id);
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  return NextResponse.json({ draft });
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid draft' }, { status: 400 });
  }
  const draft = await updateDraft(id, parsed.data.state);
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  return NextResponse.json({ draft });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deleteDraft(id);
  return NextResponse.json({ ok: true });
}
