import { NextResponse } from 'next/server';
import { updateCharacter, deleteCharacter } from '@/lib/db/characters';

export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = await request.json();
    const character = await updateCharacter(id, {
      displayName: body.displayName,
      defaultPersonaId: body.defaultPersonaId,
      voiceId: body.voiceId,
      runningNotes: body.runningNotes,
      catchphrases: Array.isArray(body.catchphrases) ? body.catchphrases : undefined,
    });
    if (!character) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ character });
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
    await deleteCharacter(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
