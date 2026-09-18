import { NextResponse } from 'next/server';
import { listCharacters, createCharacter } from '@/lib/db/characters';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const characters = await listCharacters();
    return NextResponse.json({ characters });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.displayName || typeof body.displayName !== 'string') {
      return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
    }
    const character = await createCharacter({
      displayName: body.displayName,
      defaultPersonaId: body.defaultPersonaId ?? '',
      voiceId: body.voiceId,
      runningNotes: body.runningNotes,
      catchphrases: Array.isArray(body.catchphrases) ? body.catchphrases : [],
    });
    return NextResponse.json({ character }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
