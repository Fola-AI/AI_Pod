'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ColdOpen, Session, SessionConfig, Turn } from '@/lib/types';
import {
  postTurn,
  regenerateTurn,
  editTurn,
  deleteTurn,
  extractClaims,
  preflight,
  substituteAgentModel,
  removeAgent,
  resetSession,
  runVoicePass,
  editTaggedText,
  runColdOpen,
  type Claim,
  type ClaimConflict,
  type BlockingWarning,
  type ApiError,
  type PreflightCheck,
  type VoicePassResponse,
} from '@/lib/client';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUsd } from '@/lib/cost';
import { FORMATS } from '@/lib/formats';
import { getPersona } from '@/lib/personas';
import {
  getModel,
  MODELS,
  PROVIDER_LABEL,
  TIER_LABEL,
  TIER_ORDER,
  routeLabel,
} from '@/config/models';
import {
  toJson,
  toMarkdown,
  toSpeakerManifest,
  toElevenLabsScript,
} from '@/lib/export';
import { MODERATOR_ID } from '@/lib/orchestrator';

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

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

  const [config, setConfig] = useState<SessionConfig>(initial.config);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [preflightFails, setPreflightFails] = useState<PreflightCheck[] | null>(
    null,
  );
  const [preflighting, setPreflighting] = useState(false);
  const [subModelId, setSubModelId] = useState<string>('');
  const [pendingExport, setPendingExport] = useState<'markdown' | 'pdf' | null>(
    null,
  );
  // The last run failure, persisted — shown even after the live dialog is closed
  // or the page is reloaded, until a turn succeeds or the session is rerun.
  const [lastError, setLastError] = useState(initial.lastError ?? null);
  const [rerunning, setRerunning] = useState(false);
  // Switch a participant's model at any time — including mid-run, when a model
  // errors or stops responding. Applies from the next turn the server plans.
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchAgentId, setSwitchAgentId] = useState('');
  const [switchModelId, setSwitchModelId] = useState('');
  const [switching, setSwitching] = useState(false);

  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const complete = status === 'complete';

  // Flag any participant whose model blanked (empty return, retried) on more than
  // half its turns — a roster problem, not a retry problem (bug 2).
  const flakyModels = useMemo(() => {
    const by = new Map<
      string,
      { name: string; model: string; total: number; empty: number }
    >();
    for (const t of turns) {
      if (t.speakerId === 'moderator') continue;
      const e =
        by.get(t.speakerId) ??
        { name: t.speakerDisplayName, model: t.modelId, total: 0, empty: 0 };
      e.total++;
      if ((t.emptyRetries ?? 0) > 0) e.empty++;
      by.set(t.speakerId, e);
    }
    return [...by.values()].filter((e) => e.total >= 2 && e.empty / e.total > 0.5);
  }, [turns]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  // Elapsed wall-clock over the transcript (first turn → last turn, ticking to
  // now while running). Visible, never enforced (B-7).
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const firstTurnAt = turns[0]?.createdAt;
  const lastTurnAt = turns[turns.length - 1]?.createdAt;
  const elapsedMs = firstTurnAt
    ? (running ? nowTick : new Date(lastTurnAt ?? firstTurnAt).getTime()) -
      new Date(firstTurnAt).getTime()
    : 0;

  const runLoop = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setFatal(null);
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
          setLastError(null); // a turn succeeded — the failure is resolved
        }
        setTotalWords(res.totalWords);
        setTotalCostUsd(res.totalCostUsd);

        if (res.complete) {
          setStatus('complete');
          break;
        }
        if (!runningRef.current) break;
      }
    } catch (err) {
      const e = err as ApiError;
      // Fatal → halt and surface the provider's verbatim message with recovery
      // options. Transient (already retried server-side) also halts with Retry.
      setFatal(e);
      // Mirror it into the persisted-failure banner (the server also recorded it)
      // so the cause stays visible after the dialog is closed.
      setLastError({
        message: e.message,
        code: e.code ?? 'unknown',
        failureClass: e.failureClass ?? 'unknown',
        provider: e.provider,
        agentName: e.agentName,
        model: e.model,
        turnIndex: turns.length,
        at: new Date().toISOString(),
      });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [initial.id, turns.length]);

  // Pre-flight before turn 1 (P0-3 §2): validate every model, then run.
  const startRun = useCallback(async () => {
    setFatal(null);
    setError(null);
    if (turns.length === 0) {
      setPreflighting(true);
      try {
        const r = await preflight(initial.id);
        if (!r.ok) {
          setPreflightFails(r.checks.filter((c) => !c.ok));
          return;
        }
      } catch (err) {
        toast.error((err as Error).message);
        return;
      } finally {
        setPreflighting(false);
      }
    }
    runLoop();
  }, [initial.id, turns.length, runLoop]);

  function requestStop() {
    stopRef.current = true;
    toast.info('Wrapping up — moving to closing statements.');
  }

  // Rerun: wipe the transcript and start over from the same config. Destructive.
  // Open the switch dialog, preselecting whoever just failed (if anyone).
  function openSwitch() {
    const failedId =
      fatal?.agentId ??
      config.agents.find((a) => a.displayName === lastError?.agentName)?.id ??
      (lastError?.agentName === config.moderator.displayName ? MODERATOR_ID : undefined);
    setSwitchAgentId(failedId ?? config.agents[0]?.id ?? MODERATOR_ID);
    setSwitchModelId('');
    setSwitchOpen(true);
  }

  async function confirmSwitch() {
    if (!switchAgentId || !switchModelId) return;
    setSwitching(true);
    try {
      const updated = await substituteAgentModel(initial.id, switchAgentId, switchModelId);
      setConfig(updated.config);
      setSwitchOpen(false);
      const who =
        switchAgentId === MODERATOR_ID
          ? config.moderator.displayName || 'Moderator'
          : config.agents.find((a) => a.id === switchAgentId)?.displayName;
      const to = getModel(switchModelId)?.displayName ?? switchModelId;
      toast.success(
        running
          ? `${who} switched to ${to} — applies from their next turn.`
          : `${who} switched to ${to}. Press Continue to resume.`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  async function handleRerun() {
    if (running) return;
    if (
      !confirm(
        'Start over? This permanently deletes the current transcript and all its turns. The configuration is kept so you can Run again from scratch.',
      )
    )
      return;
    setRerunning(true);
    try {
      await resetSession(initial.id);
      setTurns([]);
      setStatus('draft');
      setTotalWords(0);
      setTotalCostUsd(0);
      setColdOpen(null);
      setClaims(null);
      setConflicts([]);
      setBlockingWarnings([]);
      setError(null);
      setFatal(null);
      setLastError(null);
      toast.success('Session reset — press Run to start over.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRerunning(false);
    }
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

  const [claims, setClaims] = useState<Claim[] | null>(
    initial.claims ?? null,
  );
  const [conflicts, setConflicts] = useState<ClaimConflict[]>(
    initial.claimConflicts ?? [],
  );
  const [blockingWarnings, setBlockingWarnings] = useState<BlockingWarning[]>(
    initial.blockingWarnings ?? [],
  );
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [coldOpen, setColdOpen] = useState<ColdOpen | null>(initial.coldOpen ?? null);
  const [coldOpenLoading, setColdOpenLoading] = useState(false);

  async function handleColdOpen() {
    setColdOpenLoading(true);
    try {
      const co = await runColdOpen(initial.id);
      setColdOpen(co);
      if (!co) toast.info('No cold-open candidate found.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setColdOpenLoading(false);
    }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`claims-checked-${initial.id}`);
      if (raw) setChecked(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, [initial.id]);

  function toggleClaim(i: number) {
    setChecked((prev) => {
      const next = { ...prev, [i]: !prev[i] };
      try {
        localStorage.setItem(
          `claims-checked-${initial.id}`,
          JSON.stringify(next),
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function handleExtractClaims() {
    setClaimsLoading(true);
    try {
      const { claims: c, conflicts: cf, blockingWarnings: bw } = await extractClaims(
        initial.id,
      );
      setClaims(c);
      setConflicts(cf);
      setBlockingWarnings(bw);
      if (bw.length > 0) {
        toast.error(
          `${bw.length} publish-blocking ${bw.length === 1 ? 'issue' : 'issues'} — see the top of the checklist.`,
        );
      } else if (cf.length > 0) {
        toast.warning(
          `${cf.length} ${cf.length === 1 ? 'issue' : 'issues'} flagged — check before publishing.`,
        );
      } else if (c.length === 0) {
        toast.info('No checkable claims found.');
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setClaimsLoading(false);
    }
  }

  // --- Voice pass (Batch 4) ---
  const [voicePass, setVoicePass] = useState<VoicePassResponse | null>(null);
  const [voicePassLoading, setVoicePassLoading] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const hasTags = turns.some((t) => t.taggedText);

  async function handleVoicePass() {
    setVoicePassLoading(true);
    try {
      const res = await runVoicePass(initial.id);
      setTurns(res.turns);
      setVoicePass(res);
      setShowTags(true);
      toast.success(
        `Voice pass done — ${res.verified}/${res.verified + res.failed} turns verified.`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setVoicePassLoading(false);
    }
  }

  async function handleEditTags(index: number, taggedText: string) {
    try {
      await editTaggedText(initial.id, index, taggedText);
      setTurns((prev) =>
        prev.map((t) => (t.index === index ? { ...t, taggedText } : t)),
      );
      toast.success(`Saved tags for turn ${index}.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // --- Fatal-error recovery (P0-2 §4) ---
  async function substituteAndContinue() {
    if (!fatal?.agentId || !subModelId) return;
    try {
      const updated = await substituteAgentModel(
        initial.id,
        fatal.agentId,
        subModelId,
      );
      setConfig(updated.config);
      setFatal(null);
      setSubModelId('');
      toast.success('Model substituted — continuing.');
      runLoop();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function removeAndContinue() {
    if (!fatal?.agentId) return;
    try {
      const updated = await removeAgent(initial.id, fatal.agentId);
      setConfig(updated.config);
      setFatal(null);
      toast.success('Participant removed — continuing with the rest.');
      runLoop();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const sessionObj: Session = {
    ...initial,
    config,
    turns,
    status,
    totalWords,
    totalCostUsd,
  };

  // Spoken exports (Markdown/PDF) stay clean of inline markers, but must not
  // ship silently if a turn was truncated — block with an override.
  const truncatedTurns = turns.filter((t) => t.wasTruncated);
  function doSpokenExport(fmt: 'markdown' | 'pdf') {
    if (fmt === 'markdown') {
      download(
        `${slug(config.title)}.md`,
        toMarkdown(sessionObj),
        'text/markdown',
      );
    } else {
      const a = document.createElement('a');
      a.href = `/api/sessions/${initial.id}/export/pdf`;
      a.click();
    }
  }
  function requestSpokenExport(fmt: 'markdown' | 'pdf') {
    if (truncatedTurns.length > 0) setPendingExport(fmt);
    else doSpokenExport(fmt);
  }

  const totalSearches = turns.reduce(
    (n, t) => n + (t.searches?.length ?? 0),
    0,
  );
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
              {a.displayName} ({a.personaSnapshot?.name ?? getPersona(a.personaId)?.name},{' '}
              {getModel(a.modelId)?.displayName})
            </span>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-background/90 backdrop-blur border-b flex flex-wrap items-center gap-3">
        {!complete && (
          <Button onClick={startRun} disabled={running || preflighting}>
            {preflighting
              ? 'Checking models…'
              : running
                ? 'Running…'
                : turns.length
                  ? 'Continue'
                  : 'Run'}
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
        {turns.length > 0 && !running && (
          <Button
            variant="outline"
            onClick={handleRerun}
            disabled={rerunning}
            title="Delete the transcript and start over from the same configuration"
          >
            {rerunning ? 'Resetting…' : 'Rerun'}
          </Button>
        )}
        {!complete && (
          <Button
            variant="outline"
            onClick={openSwitch}
            title="Change a participant's model — works mid-run, from their next turn"
          >
            Switch model
          </Button>
        )}
        <div className="ml-auto flex items-center gap-4 text-sm text-muted-foreground">
          <span>{turns.length} turns</span>
          <span>
            {totalWords.toLocaleString()} / {config.targetWordCount.toLocaleString()} words ({targetPct}%)
          </span>
          <span>{formatUsd(totalCostUsd)}</span>
          {firstTurnAt && (
            <span title="Elapsed wall-clock (first turn → now)">
              ⏱ {formatDuration(elapsedMs)}
            </span>
          )}
          {totalSearches > 0 && (
            <span title="Web searches (billed separately from tokens)">
              🔎 {totalSearches}
            </span>
          )}
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
              <DropdownMenuItem onClick={() => requestSpokenExport('markdown')}>
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
              <DropdownMenuItem onClick={() => requestSpokenExport('pdf')}>
                PDF
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  download(
                    `${slug(config.title)}-elevenlabs.json`,
                    toElevenLabsScript(sessionObj),
                    'application/json',
                  )
                }
              >
                ElevenLabs script
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

      {/* Persisted last-failure cause — survives reload/closing the dialog. */}
      {lastError && !running && status !== 'complete' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-1">
          <p className="font-medium text-destructive">
            Last run failed{lastError.agentName ? ` on ${lastError.agentName}` : ''}
            {lastError.model ? ` (${lastError.model})` : ''} — turn {lastError.turnIndex}
            {lastError.provider ? ` · ${lastError.provider}` : ''}
          </p>
          <p className="text-destructive/90 font-mono text-xs break-words">
            {lastError.message}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {new Date(lastError.at).toLocaleString()} · fix it (substitute the model or
            top up the provider) then press Continue, or Rerun to start over.
          </p>
        </div>
      )}

      {flakyModels.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-500">
          ⚠ Unreliable on this prompt shape — returned empty on more than half their turns:{' '}
          {flakyModels
            .map((m) => `${m.name} (${m.model}, ${m.empty}/${m.total})`)
            .join('; ')}
          . This is a roster problem — consider substituting the model.
        </div>
      )}

      {/* Transcript */}
      {complete && (
        <div className="mb-5 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Cold open candidate</h2>
            <Button size="sm" variant="outline" onClick={handleColdOpen} disabled={coldOpenLoading}>
              {coldOpenLoading ? 'Finding…' : coldOpen ? 'Re-find' : 'Find cold open'}
            </Button>
          </div>
          {coldOpen ? (
            <blockquote className="mt-2 border-l-2 pl-3 text-sm">
              <p className="italic">&ldquo;{coldOpen.text}&rdquo;</p>
              <p className="mt-1 text-xs text-muted-foreground">
                — {coldOpen.speaker}
                {coldOpen.turnIndex != null && ` · turn #${coldOpen.turnIndex}`}
                {coldOpen.reason && ` · ${coldOpen.reason}`}
              </p>
            </blockquote>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              The best 15–30 seconds for the clip before the intro.
            </p>
          )}
        </div>
      )}

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
            showTags={showTags}
            onRegenerate={() => handleRegenerate(t.index)}
            onDelete={() => handleDelete(t.index)}
            onEdit={(text) => handleEdit(t.index, text)}
            onEditTags={(tagged) => handleEditTags(t.index, tagged)}
          />
        ))}
        {running && <ThinkingRow />}
        <div ref={bottomRef} />
      </div>

      {/* Voice pass */}
      {complete && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Voice pass (ElevenLabs v3)</h2>
              <p className="text-xs text-muted-foreground">
                Inserts performance tags without changing a spoken word. Export
                the ElevenLabs script from the Export menu.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasTags && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTags((v) => !v)}
                >
                  {showTags ? 'Hide tags' : 'Show tags'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleVoicePass}
                disabled={voicePassLoading}
              >
                {voicePassLoading
                  ? 'Tagging…'
                  : hasTags
                    ? 'Re-run voice pass'
                    : 'Run voice pass'}
              </Button>
            </div>
          </div>
          {voicePass && (
            <p className="text-xs text-muted-foreground">
              {voicePass.verified} of {voicePass.verified + voicePass.failed}{' '}
              turns verified (spoken words unchanged) ·{' '}
              {voicePass.tagCount} tags · ~1 tag per {voicePass.tagsPerWords}{' '}
              words
              {voicePass.failed > 0 &&
                ` · ${voicePass.failed} turn(s) left untagged (tagger altered the words)`}
. Set ElevenLabs stability to <strong>Natural</strong> (Creative
              overacts; Robust ignores tags).
            </p>
          )}
        </div>
      )}

      {/* Claims checklist */}
      {complete && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Claims checklist</h2>
              <p className="text-xs text-muted-foreground">
                Extracts every statistic, date, named study, and quotation so you
                can verify before publishing.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExtractClaims}
              disabled={claimsLoading}
            >
              {claimsLoading
                ? 'Extracting…'
                : claims
                  ? 'Re-extract'
                  : 'Extract claims'}
            </Button>
          </div>
          {blockingWarnings.length > 0 && (
            <div className="mb-3 rounded-md border-2 border-destructive/60 bg-destructive/10 p-3">
              <p className="mb-2 text-sm font-semibold text-destructive">
                ⛔ Do not publish — {blockingWarnings.length} blocking{' '}
                {blockingWarnings.length === 1 ? 'issue' : 'issues'}
              </p>
              <ul className="space-y-2">
                {blockingWarnings.map((w, i) => (
                  <li key={i} className="text-sm">
                    {w.message}
                    {(w.figure || w.turnIndex != null || w.citedBy?.length) && (
                      <span className="block text-xs text-muted-foreground">
                        {w.figure && `${w.figure} · `}
                        {w.turnIndex != null && `retracted at turn #${w.turnIndex}`}
                        {w.citedBy?.length ? ` · earlier cited by ${w.citedBy.join(', ')}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {conflicts.filter((c) => c.kind === 'unit').length > 0 && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <p className="mb-2 text-sm font-medium text-destructive">
                ✕ Unit / order-of-magnitude errors (always wrong)
              </p>
              <ul className="space-y-2">
                {conflicts
                  .filter((c) => c.kind === 'unit')
                  .map((cf, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium">{cf.quantity}:</span>{' '}
                      {cf.values.map((v, j) => (
                        <span key={j}>
                          {j > 0 && <span className="text-destructive"> → </span>}
                          {v.value}
                          {v.turnIndex != null && (
                            <span className="text-muted-foreground">
                              {' '}({v.speaker ? `${v.speaker}, ` : ''}turn #{v.turnIndex})
                            </span>
                          )}
                        </span>
                      ))}
                      {cf.note && <span className="block text-xs text-muted-foreground">{cf.note}</span>}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {conflicts.filter((c) => c.kind !== 'unit').length > 0 && (
            <div className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                ⚠ Conflicting values — resolve before publishing
              </p>
              <ul className="space-y-2">
                {conflicts
                  .filter((c) => c.kind !== 'unit')
                  .map((cf, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium">{cf.quantity}:</span>{' '}
                      {cf.values.map((v, j) => (
                        <span key={j}>
                          {j > 0 && <span className="text-amber-600"> vs </span>}
                          {v.value}
                          {v.turnIndex != null && (
                            <span className="text-muted-foreground">
                              {' '}({v.speaker ? `${v.speaker}, ` : ''}turn #{v.turnIndex})
                            </span>
                          )}
                        </span>
                      ))}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {claims && claims.length > 0 && (
            <ul className="space-y-2">
              {claims.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!!checked[i]}
                    onChange={() => toggleClaim(i)}
                  />
                  <span className={checked[i] ? 'line-through text-muted-foreground' : ''}>
                    <Badge variant="outline" className="mr-2 text-[10px]">
                      {c.type}
                    </Badge>
                    {c.claim}
                    {(c.speaker || c.turnIndex != null) && (
                      <span className="text-muted-foreground">
                        {' — '}
                        {c.speaker}
                        {c.turnIndex != null && ` · turn #${c.turnIndex}`}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {claims && claims.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No checkable claims found.
            </p>
          )}
        </div>
      )}

      {/* Fatal provider failure (P0-2 §3, §4) */}
      <Dialog open={switchOpen} onOpenChange={(o) => !o && setSwitchOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch model</DialogTitle>
            <DialogDescription>
              {running
                ? 'The run keeps going. The new model takes over from this participant’s next turn (a turn already in progress finishes on the old one).'
                : 'Change a participant’s model, then press Continue to resume.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Participant</p>
              <Select value={switchAgentId} onValueChange={(v) => v && setSwitchAgentId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => {
                      if (v === MODERATOR_ID) {
                        return `${config.moderator.displayName || 'Moderator'} — ${getModel(config.moderator.modelId)?.displayName ?? config.moderator.modelId}`;
                      }
                      const a = config.agents.find((x) => x.id === v);
                      return a
                        ? `${a.displayName} — ${getModel(a.modelId)?.displayName ?? a.modelId}`
                        : 'Pick a participant';
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {config.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.displayName} — {getModel(a.modelId)?.displayName ?? a.modelId}
                    </SelectItem>
                  ))}
                  <SelectItem value={MODERATOR_ID}>
                    {config.moderator.displayName || 'Moderator'} —{' '}
                    {getModel(config.moderator.modelId)?.displayName ?? config.moderator.modelId}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">New model</p>
              <Select value={switchModelId} onValueChange={(v) => v && setSwitchModelId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => MODELS.find((m) => m.id === v)?.displayName ?? 'Pick a model'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TIER_ORDER.map((tier) => {
                    const current =
                      switchAgentId === MODERATOR_ID
                        ? config.moderator.modelId
                        : config.agents.find((a) => a.id === switchAgentId)?.modelId;
                    const tierModels = MODELS.filter(
                      (m) => m.enabled && m.tier === tier && m.id !== current,
                    );
                    if (!tierModels.length) return null;
                    return (
                      <SelectGroup key={tier}>
                        <SelectLabel className="text-[11px] uppercase tracking-wide">
                          {TIER_LABEL[tier]}
                        </SelectLabel>
                        {tierModels.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <span className="flex items-center gap-2">
                              {m.displayName}
                              <span className="text-[10px] text-muted-foreground">
                                {PROVIDER_LABEL[m.provider]} · {routeLabel(m)}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSwitchOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSwitch} disabled={!switchAgentId || !switchModelId || switching}>
              {switching ? 'Switching…' : 'Switch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fatal} onOpenChange={(o) => !o && setFatal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {fatal?.failureClass === 'fatal'
                ? 'Session halted — provider error'
                : 'Turn failed'}
            </DialogTitle>
            <DialogDescription>
              {fatal?.agentName} on {fatal?.model} ·{' '}
              {fatal?.failureClass ?? 'error'}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-sm font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
            {fatal?.message}
          </div>
          {fatal?.failureClass === 'fatal' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Substitute a model for this participant and continue from here:
              </p>
              <div className="flex gap-2">
                <Select
                  value={subModelId}
                  onValueChange={(v) => v && setSubModelId(v)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue>
                      {(v) =>
                        MODELS.find((m) => m.id === v)?.displayName ??
                        'Pick a model'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={!subModelId}
                  onClick={substituteAndContinue}
                >
                  Substitute
                </Button>
              </div>
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button
              onClick={() => {
                setFatal(null);
                runLoop();
              }}
            >
              Retry
            </Button>
            {fatal?.agentId && fatal.agentId !== MODERATOR_ID && (
              <Button variant="outline" onClick={removeAndContinue}>
                Remove {fatal.agentName}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setFatal(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Truncation export guard — clean exports, but never silently clean */}
      <Dialog
        open={!!pendingExport}
        onOpenChange={(o) => !o && setPendingExport(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Truncated turns in this session</DialogTitle>
            <DialogDescription>
              These turns were cut off and never finished their sentence.
              Regenerate or edit them before publishing. You can export anyway.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
            {truncatedTurns.map((t) => (
              <li key={t.index} className="rounded-md border px-2 py-1">
                Turn #{t.index} — {t.speakerDisplayName}:{' '}
                <span className="text-muted-foreground">
                  …{t.text.trim().slice(-40)}
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const fmt = pendingExport;
                setPendingExport(null);
                if (fmt) doSpokenExport(fmt);
              }}
            >
              Export anyway
            </Button>
            <Button variant="ghost" onClick={() => setPendingExport(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-flight failure (P0-3 §2) */}
      <Dialog
        open={!!preflightFails}
        onOpenChange={(o) => !o && setPreflightFails(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Can&apos;t start — model check failed</DialogTitle>
            <DialogDescription>
              Every model is tested before the session starts. Fix these and try
              again — the session was not started.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            {preflightFails?.map((c) => (
              <li key={c.modelId} className="rounded-md border p-2">
                <span className="font-medium">{c.displayName}</span>
                <p className="text-xs font-mono text-destructive mt-1 whitespace-pre-wrap">
                  {c.message}
                </p>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                setPreflightFails(null);
                startRun();
              }}
            >
              Re-check
            </Button>
            <Button variant="ghost" onClick={() => setPreflightFails(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TurnBlock({
  turn,
  editable,
  busy,
  showTags,
  onRegenerate,
  onDelete,
  onEdit,
  onEditTags,
}: {
  turn: Turn;
  editable: boolean;
  busy: boolean;
  showTags: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
  onEdit: (text: string) => void;
  onEditTags: (taggedText: string) => void;
}) {
  const isModerator = turn.speakerId === MODERATOR_ID;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);
  const [tagsEditing, setTagsEditing] = useState(false);
  const [tagsDraft, setTagsDraft] = useState(turn.taggedText ?? turn.text);
  const displayText =
    showTags && turn.taggedText ? turn.taggedText : turn.text;

  // Interjections render as a compact aside, not a full block.
  if (turn.turnClass === 'interjection') {
    return (
      <div className="group flex items-center gap-2 pl-4 text-sm text-muted-foreground italic">
        <span className="text-[10px] not-italic uppercase tracking-wide">
          {turn.speakerDisplayName}
        </span>
        <span>“{displayText}”</span>
        {editable && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
          >
            Delete
          </Button>
        )}
      </div>
    );
  }

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
        {turn.wasTruncated && (
          <Badge variant="outline" className="text-[10px] border-destructive/50 text-destructive">
            ⚠ truncated
          </Badge>
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
            {showTags && turn.taggedText && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setTagsDraft(turn.taggedText ?? turn.text);
                  setTagsEditing(true);
                }}
              >
                Edit tags
              </Button>
            )}
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
      ) : tagsEditing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            rows={5}
            className="font-mono text-sm"
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onEditTags(tagsDraft);
                setTagsEditing(false);
              }}
            >
              Save tags
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTagsEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p
          className={
            'mt-1 whitespace-pre-wrap leading-relaxed text-[15px] ' +
            (showTags && turn.taggedText ? 'font-mono text-[13px]' : '')
          }
        >
          {displayText}
        </p>
      )}

      {turn.searchDegraded && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
          ⚠ A web search failed on this turn — the point above was made without grounding.
        </p>
      )}

      {turn.searches && turn.searches.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            🔎 {turn.searches.length} web search
            {turn.searches.length > 1 ? 'es' : ''} ·{' '}
            {turn.searches.reduce((n, s) => n + s.results.length, 0)} sources
            {turn.searches[0]?.mode === 'shared' ? ' · shared' : ' · native'}
          </summary>
          <div className="mt-1 space-y-2 border-l pl-3">
            {turn.searches.map((s, i) => (
              <div key={i}>
                <p className="text-muted-foreground">
                  <span className="font-medium">Query:</span> {s.query}
                </p>
                <ul className="mt-0.5 space-y-1">
                  {s.results.map((src, j) => (
                    <li key={j}>
                      <a
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline break-all"
                      >
                        {src.title || src.url}
                      </a>
                      {src.snippet && (
                        <span className="block text-muted-foreground">{src.snippet}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
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
