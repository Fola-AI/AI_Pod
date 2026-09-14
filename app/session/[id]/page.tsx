import { notFound } from 'next/navigation';
import { getSession } from '@/lib/db/queries';
import { SessionView } from '@/components/session-view';

export const dynamic = 'force-dynamic';

export default async function SessionPage({
  params,
}: PageProps<'/session/[id]'>) {
  const { id } = await params;

  let session;
  try {
    session = await getSession(id);
  } catch (err) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">Could not load session</p>
        <p className="text-muted-foreground mt-1">{(err as Error).message}</p>
      </div>
    );
  }

  if (!session) notFound();

  return <SessionView initial={session} />;
}
