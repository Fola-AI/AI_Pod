import { NextResponse } from 'next/server';
import { updatePersona, deletePersona } from '@/lib/db/personas';

export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = await request.json();
    const persona = await updatePersona(id, {
      name: body.name,
      shortDescription: body.shortDescription,
      systemPromptFragment: body.systemPromptFragment,
      speakingStyle: body.speakingStyle,
    });
    if (!persona) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ persona });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    await deletePersona(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
