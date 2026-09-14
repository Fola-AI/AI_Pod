'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { deleteSession } from '@/lib/client';

export function DeleteSessionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    setBusy(true);
    try {
      await deleteSession(id);
      toast.success('Session deleted');
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onDelete}
      disabled={busy}
      className="text-muted-foreground hover:text-destructive"
    >
      Delete
    </Button>
  );
}
