import { NextResponse } from 'next/server';
import { listPersonas } from '@/lib/db/personas';

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
