'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { deleteDraft } from '@/lib/client';

export function DeleteDraftButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm(`Delete the draft “${title}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteDraft(id);
      toast.success('Draft deleted');
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
