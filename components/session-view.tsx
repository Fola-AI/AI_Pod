'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Session, Turn } from '@/lib/types';
import {
  postTurn,
  regenerateTurn,
  editTurn,
  deleteTurn,
} from '@/lib/client';
import { Textarea } from '@/components/ui/textarea';
import { formatUsd } from '@/lib/cost';
import { FORMATS } from '@/lib/formats';
import { getPersona } from '@/lib/personas';
import { getModel } from '@/config/models';
import { toJson, toMarkdown, toSpeakerManifest } from '@/lib/export';
import { MODERATOR_ID } from '@/lib/orchestrator';

function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SessionView({ initial }: { initial: Session }) {
  const [turns, setTurns] = useState<Turn[]>(initial.turns);
  const [status, setStatus] = useState(initial.status);
  const [totalWords, setTotalWords] = useState(initial.totalWords);
  const [totalCostUsd, setTotalCostUsd] = useState(initial.totalCostUsd);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { config } = initial;
  const complete = status === 'complete';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  const runLoop = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setStatus('running');

    try {
      // Loop until the server says the session is complete.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const stopNow = stopRef.current;
        stopRef.current = false;
        const res = await postTurn(initial.id, stopNow);

        if (res.turn) {
          setTurns((prev) => [...prev, res.turn as Turn]);
        }
        setTotalWords(res.totalWords);
        setTotalCostUsd(res.totalCostUsd);

        if (res.complete) {
          setStatus('complete');
          break;
        }
        if (!runningRef.current) break; // hard stop (unused for now)
      }
    } catch (err) {
      const e = err as Error & { code?: string; provider?: string };
      const msg =
        e.code === 'missing_key'
          ? `No API key for ${e.provider}. Add it to .env.local and restart the server, or substitute the model.`
          : e.message;
      setError(msg);
      toast.error(msg);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [initial.id]);

  function requestStop() {
    stopRef.current = true;
    toast.info('Wrapping up — moving to closing statements.');
  }

  const [busyIndex, setBusyIndex] = useState<number | null>(null);

  async function handleRegenerate(index: number) {
    setBusyIndex(index);
    try {
      const res = await regenerateTurn(initial.id, index);
      setTurns(res.turns);
      setTotalWords(res.totalWords);
      setTotalCostUsd(res.totalCostUsd);
      toast.success(`Regenerated turn ${index}. Later turns marked stale.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyIndex(null);
    }
  }

  async function handleEdit(index: number, text: string) {
    try {
      const res = await editTurn(initial.id, index, text);
      setTurns((prev) =>
        prev.map((t) =>
          t.index === index ? { ...t, text, wasEdited: true } : t,
        ),
      );
      setTotalWords(res.totalWords);
      setTotalCostUsd(res.totalCostUsd);
      toast.success(`Saved edit to turn ${index}.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleDelete(index: number) {
    if (!confirm(`Delete turn ${index}? Remaining turns will be renumbered.`))
      return;
    setBusyIndex(index);
    try {
      const res = await deleteTurn(initial.id, index);
      setTurns(res.turns);
      setTotalWords(res.totalWords);
      setTotalCostUsd(res.totalCostUsd);
      toast.success('Turn deleted.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyIndex(null);
    }
  }

  const canEdit = !running;

  const sessionObj: Session = {
    ...initial,
    turns,
    status,
    totalWords,
    totalCostUsd,
  };

  const formatLabel = FORMATS[config.format]?.label ?? config.format;
  const targetPct = Math.min(
    100,
    Math.round((totalWords / config.targetWordCount) * 100),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {config.title}
          </h1>
          <Badge variant={complete ? 'secondary' : running ? 'default' : 'outline'}>
            {status}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{config.topic}</p>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{formatLabel}</span>
          <span>·</span>
          {config.agents.map((a) => (
            <span key={a.id}>
              {a.displayName} ({getPersona(a.personaId)?.name},{' '}
              {getModel(a.modelId)?.displayName})
            </span>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-background/90 backdrop-blur border-b flex flex-wrap items-center gap-3">
        {!complete && (
          <Button onClick={runLoop} disabled={running}>
            {running ? 'Running…' : turns.length ? 'Continue' : 'Run'}
          </Button>
        )}
        {running && (
          <Button variant="outline" onClick={requestStop}>
            Stop &amp; close
          </Button>
        )}
        {error && !running && (
          <Button variant="outline" onClick={runLoop}>
            Retry
          </Button>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-muted-foreground">
          <span>{turns.length} turns</span>
          <span>
            {totalWords.toLocaleString()} / {config.targetWordCount.toLocaleString()} words ({targetPct}%)
          </span>
          <span>{formatUsd(totalCostUsd)}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={turns.length === 0}
                />
              }
            >
              Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  download(`${slug(config.title)}.md`, toMarkdown(sessionObj), 'text/markdown')
                }
              >
                Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  download(
                    `${slug(config.title)}.json`,
                    toJson(sessionObj),
                    'application/json',
                  )
                }
              >
                JSON
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  navigator.clipboard.writeText(toSpeakerManifest(sessionObj));
                  toast.success('Speaker manifest copied');
                }}
              >
                Copy speaker manifest
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Transcript */}
      <div className="space-y-5">
        {turns.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Press Run to start the discussion. Turns stream in live and are saved
            after each one — a refresh resumes where it left off.
          </p>
        )}
        {turns.map((t) => (
          <TurnBlock
            key={t.index}
            turn={t}
            editable={canEdit}
            busy={busyIndex === t.index}
            onRegenerate={() => handleRegenerate(t.index)}
            onDelete={() => handleDelete(t.index)}
            onEdit={(text) => handleEdit(t.index, text)}
          />
        ))}
        {running && <ThinkingRow />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  editable,
  busy,
  onRegenerate,
  onDelete,
  onEdit,
}: {
  turn: Turn;
  editable: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
  onEdit: (text: string) => void;
}) {
  const isModerator = turn.speakerId === MODERATOR_ID;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);

  return (
    <div
      className={
        'group relative pl-4 border-l-2 ' +
        (turn.isStale
          ? 'border-amber-500/60'
          : isModerator
            ? 'border-muted-foreground/40'
            : 'border-primary/60')
      }
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={
            'text-xs font-semibold uppercase tracking-wide ' +
            (isModerator ? 'text-muted-foreground' : 'text-foreground')
          }
        >
          {turn.speakerDisplayName}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {getModel(turn.modelId)?.displayName ?? turn.modelId}
        </span>
        {turn.wasEdited && (
          <span className="text-[10px] text-muted-foreground">(edited)</span>
        )}
        {turn.isStale && (
          <span className="text-[10px] text-amber-600 dark:text-amber-500">
            stale — context changed
          </span>
        )}
        {editable && !editing && (
          <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={onRegenerate}
            >
              {busy ? '…' : 'Regenerate'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDraft(turn.text);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={onDelete}
              className="text-muted-foreground hover:text-destructive"
            >
              Delete
            </Button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onEdit(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap leading-relaxed text-[15px]">
          {turn.text}
        </p>
      )}
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="inline-flex gap-1">
        <span className="animate-pulse">●</span>
        <span className="animate-pulse [animation-delay:150ms]">●</span>
        <span className="animate-pulse [animation-delay:300ms]">●</span>
      </span>
      generating next turn…
    </div>
  );
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'session'
  );
}
