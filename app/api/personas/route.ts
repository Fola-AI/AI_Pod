import { NextResponse } from 'next/server';
import { listPersonas, createPersona } from '@/lib/db/personas';

export const runtime = 'nodejs';

// List personas for the builder. Seeds the built-in seven on first call (B-6).
export async function GET() {
  try {
    const personas = await listPersonas();
    return NextResponse.json({ personas });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    const persona = await createPersona({
      name: body.name,
      shortDescription: body.shortDescription,
      systemPromptFragment: body.systemPromptFragment,
      speakingStyle: body.speakingStyle,
    });
    return NextResponse.json({ persona }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
