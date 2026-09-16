'use client';

// Top bar shown on every screen (P1-1). A contextual Back control (always →
// Dashboard, the logical parent, per the agreed scope) sits top-left on every
// screen except the Dashboard, and Escape triggers it everywhere except the
// Live Session. The active nav link is highlighted.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/session/new', label: 'New session' },
  { href: '/registry', label: 'Models' },
];

// Live Session is /session/<id> but not /session/new.
function isLiveSession(pathname: string): boolean {
  return /^\/session\/(?!new$)[^/]+$/.test(pathname);
}

export function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  const onGate = pathname === '/gate';
  const onDashboard = pathname === '/';
  const liveSession = isLiveSession(pathname);

  useEffect(() => {
    if (onGate || onDashboard || liveSession) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') router.push('/');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGate, onDashboard, liveSession, router]);

  if (onGate) {
    return (
      <header className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 h-14 flex items-center">
          <span className="font-semibold tracking-tight">AI&nbsp;Pod</span>
        </div>
      </header>
    );
  }

  return (
    <header className="border-b">
      <div className="mx-auto w-full max-w-6xl px-4 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {!onDashboard && (
            <Link
              href="/"
              className="text-sm text-muted-foreground hover:text-foreground shrink-0"
            >
              ← Dashboard
            </Link>
          )}
          <Link href="/" className="font-semibold tracking-tight truncate">
            AI&nbsp;Pod
          </Link>
        </div>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
          {NAV.map((item) => {
            const active =
              item.href === '/'
                ? onDashboard
                : pathname === item.href ||
                  pathname.startsWith(item.href + '/');
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active ? 'text-foreground font-medium' : 'hover:text-foreground'
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
