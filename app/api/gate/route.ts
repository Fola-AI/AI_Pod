import { NextResponse } from 'next/server';
import { z } from 'zod';
import { GATE_COOKIE, gateEnabled, sha256Hex } from '@/lib/gate';

export const runtime = 'nodejs';

const bodySchema = z.object({ password: z.string() });

export async function POST(request: Request) {
  if (!gateEnabled()) {
    // No gate configured; nothing to authenticate against.
    return NextResponse.json({ ok: true, gateDisabled: true });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Password required' }, { status: 400 });
  }

  const expected = process.env.APP_ACCESS_PASSWORD ?? '';
  if (parsed.data.password !== expected) {
    return NextResponse.json(
      { error: 'Incorrect password' },
      { status: 401 },
    );
  }

  const token = await sha256Hex(expected);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
