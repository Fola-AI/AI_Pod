import { NextResponse } from 'next/server';
import { createSession, listSessions } from '@/lib/db/queries';
import {
  createSessionSchema,
  toSessionConfig,
  validateReferences,
} from '@/lib/validation';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const sessions = await listSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const refErrors = validateReferences(parsed.data);
  if (refErrors.length > 0) {
    return NextResponse.json(
      { error: refErrors.join(' ') },
      { status: 400 },
    );
  }

  try {
    const config = toSessionConfig(parsed.data);
    const session = await createSession(config);
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
