'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ProviderId } from '@/lib/types';

export function TestConnectionButton({
  provider,
  disabled,
}: {
  provider: ProviderId;
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'testing' | 'pass' | 'fail'>(
    'idle',
  );
  const [message, setMessage] = useState<string | null>(null);

  async function test() {
    setState('testing');
    setMessage(null);
    try {
      const res = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (data.ok) {
        setState('pass');
        setMessage(`OK (${data.model})`);
      } else {
        setState('fail');
        setMessage(data.message || 'Failed');
      }
    } catch (err) {
      setState('fail');
      setMessage((err as Error).message);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={test}
        disabled={disabled || state === 'testing'}
      >
        {state === 'testing' ? 'Testing…' : 'Test connection'}
      </Button>
      {message && (
        <span
          className={
            'text-xs ' +
            (state === 'pass'
              ? 'text-emerald-600 dark:text-emerald-500'
              : 'text-destructive')
          }
        >
          {message}
        </span>
      )}
    </div>
  );
}
