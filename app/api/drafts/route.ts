import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createDraft, listDrafts } from '@/lib/db/queries';

export const runtime = 'nodejs';

// Drafts accept any builder state — they may be incomplete. Only the title is
// defaulted (to "Untitled draft"); full validation happens at Create session.
const bodySchema = z.object({ state: z.record(z.string(), z.unknown()) });

export async function GET() {
  return NextResponse.json({ drafts: await listDrafts() });
}

export async function POST(request: Request) {
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
  const draft = await createDraft(parsed.data.state);
  return NextResponse.json({ draft }, { status: 201 });
}
