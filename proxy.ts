// Access gate (Next.js 16 `proxy`, formerly `middleware`). Runs on the nodejs
// runtime. Redirects unauthenticated page requests to /gate and 401s API calls.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { GATE_COOKIE, gateEnabled, expectedToken } from '@/lib/gate';

export async function proxy(request: NextRequest) {
  if (!gateEnabled()) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // Always allow the gate page and its API.
  if (pathname === '/gate' || pathname === '/api/gate') {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(GATE_COOKIE)?.value;
  const expected = await expectedToken();

  if (cookie && cookie === expected) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/gate';
  url.searchParams.set('from', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
