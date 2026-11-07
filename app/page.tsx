import Link from 'next/link';
import { listDrafts, listSessions } from '@/lib/db/queries';
import { FORMATS } from '@/lib/formats';
import { formatUsd } from '@/lib/cost';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DeleteSessionButton } from '@/components/delete-session-button';
import { DeleteDraftButton } from '@/components/delete-draft-button';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  running: 'default',
  complete: 'secondary',
  aborted: 'destructive',
};

export default async function Dashboard() {
  let sessions: Awaited<ReturnType<typeof listSessions>> = [];
  let dbError: string | null = null;
  try {
    sessions = await listSessions();
  } catch (err) {
    dbError = (err as Error).message;
  }
  // Drafts are loaded separately so a drafts problem never hides the Sessions list.
  let drafts: Awaited<ReturnType<typeof listDrafts>> = [];
  try {
    drafts = await listDrafts();
  } catch {
    drafts = [];
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Automated multi-agent discussions, exported as clean scripts.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" render={<Link href="/library" />}>
            Characters &amp; personas
          </Button>
          <Button render={<Link href="/session/new" />}>New session</Button>
        </div>
      </div>

      {dbError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Database not reachable</p>
          <p className="text-muted-foreground mt-1">
            Set <code className="font-mono">DATABASE_URL</code> in{' '}
            <code className="font-mono">.env.local</code> and run{' '}
            <code className="font-mono">npm run db:push</code>. ({dbError})
          </p>
        </div>
      )}

      {drafts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Drafts</h2>
          <div className="divide-y rounded-lg border border-dashed">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <Link
                    href={`/session/new?draft=${d.id}`}
                    className="font-medium hover:underline block truncate"
                  >
                    {d.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">draft</Badge>
                    <span>{FORMATS[d.format as keyof typeof FORMATS]?.label ?? d.format}</span>
                    <span>·</span>
                    <span>
                      {d.agentCount} {d.agentCount === 1 ? 'agent' : 'agents'}
                    </span>
                    {d.rounds !== undefined && (
                      <>
                        <span>·</span>
                        <span>{d.rounds} rounds</span>
                      </>
                    )}
                    <span>·</span>
                    <span>edited {d.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    render={<Link href={`/session/new?draft=${d.id}`} />}
                    variant="ghost"
                    size="sm"
                  >
                    Open
                  </Button>
                  <DeleteDraftButton id={d.id} title={d.title} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!dbError && sessions.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-muted-foreground">No sessions yet.</p>
          <Button render={<Link href="/session/new" />} className="mt-4">
            Create your first session
          </Button>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="divide-y rounded-lg border">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <Link
                  href={`/session/${s.id}`}
                  className="font-medium hover:underline block truncate"
                >
                  {s.title}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={STATUS_VARIANT[s.status] ?? 'outline'}>
                    {s.status}
                  </Badge>
                  <span>{FORMATS[s.format as keyof typeof FORMATS]?.label ?? s.format}</span>
                  <span>·</span>
                  <span>{s.participants.join(', ')}</span>
                  <span>·</span>
                  <span>{s.totalWords.toLocaleString()} words</span>
                  <span>·</span>
                  <span>{formatUsd(s.totalCostUsd)}</span>
                  <span>·</span>
                  <span>{s.createdAt.slice(0, 10)}</span>
                </div>
                {s.lastError && s.status !== 'complete' && (
                  <p className="mt-1 text-xs text-destructive truncate">
                    ⚠ failed{s.lastError.model ? ` on ${s.lastError.model}` : ''}: {s.lastError.message}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  render={<Link href={`/session/${s.id}`} />}
                  variant={s.status === 'running' ? 'default' : 'ghost'}
                  size="sm"
                >
                  {s.status === 'running' ? 'Resume' : 'Open'}
                </Button>
                <DeleteSessionButton id={s.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
