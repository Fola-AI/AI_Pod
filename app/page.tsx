import Link from 'next/link';
import { listSessions } from '@/lib/db/queries';
import { FORMATS } from '@/lib/formats';
import { formatUsd } from '@/lib/cost';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DeleteSessionButton } from '@/components/delete-session-button';

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Automated multi-agent discussions, exported as clean scripts.
          </p>
        </div>
        <Button render={<Link href="/session/new" />}>New session</Button>
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
