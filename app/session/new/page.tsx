'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { MODELS, PROVIDER_LABEL } from '@/config/models';
import { BUILT_IN_PERSONAS } from '@/lib/personas';
import { FORMAT_LIST, FORMATS, isStanceBearing } from '@/lib/formats';
import type { ProviderId, SessionFormat } from '@/lib/types';
import { createSession, fetchProviders } from '@/lib/client';

interface AgentDraft {
  id: string;
  displayName: string;
  personaId: string;
  modelId: string;
  stance: string;
  temperature: number;
  maxWordsPerTurn: number;
}

const NAME_POOL = ['Lara', 'Tony', 'Kimi', 'Ada', 'Zoe', 'Ravi'];
const DEFAULT_PERSONAS = [
  'pragmatist',
  'idealist',
  'contrarian',
  'data-hound',
  'historian',
  'storyteller',
];
const FRONTIER_DEFAULT = 'claude-opus-5';

function makeAgent(i: number): AgentDraft {
  return {
    id: crypto.randomUUID(),
    displayName: NAME_POOL[i] ?? `Agent ${i + 1}`,
    personaId: DEFAULT_PERSONAS[i] ?? 'pragmatist',
    modelId: FRONTIER_DEFAULT,
    stance: '',
    temperature: 0.85,
    maxWordsPerTurn: 160,
  };
}

export default function NewSessionPage() {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState<SessionFormat>('panel');
  const [domain, setDomain] = useState('general');
  const [targetWordCount, setTargetWordCount] = useState(2600);
  const [maxTurns, setMaxTurns] = useState(24);
  const [agents, setAgents] = useState<AgentDraft[]>([
    makeAgent(0),
    makeAgent(1),
    makeAgent(2),
  ]);
  const [sources, setSources] = useState<
    { id: string; title: string; content: string }[]
  >([]);
  const [modName, setModName] = useState('Moderator');
  const [modModelId, setModModelId] = useState(FRONTIER_DEFAULT);
  const [interjectionFrequency, setInterjectionFrequency] = useState<
    'low' | 'medium' | 'high'
  >('medium');
  const [saving, setSaving] = useState(false);

  const [available, setAvailable] = useState<Record<ProviderId, boolean> | null>(
    null,
  );

  useEffect(() => {
    fetchProviders()
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(null));
  }, []);

  function addSource() {
    if (sources.length >= 5) return toast.error('Up to 5 documents.');
    setSources((p) => [
      ...p,
      { id: crypto.randomUUID(), title: `Source ${p.length + 1}`, content: '' },
    ]);
  }
  function updateSource(id: string, patch: Partial<{ title: string; content: string }>) {
    setSources((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function removeSource(id: string) {
    setSources((p) => p.filter((s) => s.id !== id));
  }
  async function onUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      if (sources.length >= 5) break;
      const text = await file.text();
      setSources((p) => [
        ...p,
        {
          id: crypto.randomUUID(),
          title: file.name.replace(/\.[^.]+$/, ''),
          content: text,
        },
      ]);
    }
    e.target.value = '';
  }

  const stanceRequired = isStanceBearing(format);
  const formatMeta = FORMATS[format];

  const topicWarning = useMemo(() => detectSensitiveTopic(topic), [topic]);

  function setAgentCount(n: number) {
    setAgents((prev) => {
      if (n === prev.length) return prev;
      if (n < prev.length) return prev.slice(0, n);
      const next = [...prev];
      for (let i = prev.length; i < n; i++) next.push(makeAgent(i));
      return next;
    });
  }

  function updateAgent(id: string, patch: Partial<AgentDraft>) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  // Shuffle personas across agents, keeping names and models fixed (PRD §4.2).
  function shufflePersonas() {
    setAgents((prev) => {
      const personas = prev.map((a) => a.personaId);
      for (let i = personas.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [personas[i], personas[j]] = [personas[j], personas[i]];
      }
      return prev.map((a, i) => ({ ...a, personaId: personas[i] }));
    });
    toast.success('Personas shuffled — names and models kept');
  }

  async function submit() {
    if (!title.trim()) return toast.error('Add a title.');
    if (!topic.trim()) return toast.error('Add a topic.');
    if (stanceRequired && format === 'debate') {
      const missing = agents.filter((a) => !a.stance.trim());
      if (missing.length) return toast.error('Each debater needs a stance.');
    }
    setSaving(true);
    try {
      const session = await createSession({
        title: title.trim(),
        topic: topic.trim(),
        format,
        domain: domain.trim() || 'general',
        sourceMaterial: sources.filter((s) => s.content.trim()).length
          ? sources
              .filter((s) => s.content.trim())
              .map((s) => ({
                id: s.id,
                title: s.title.trim() || 'Source',
                content: s.content.trim(),
              }))
          : undefined,
        agentCount: agents.length,
        agents: agents.map((a) => ({
          id: a.id,
          displayName: a.displayName.trim(),
          personaId: a.personaId,
          modelId: a.modelId,
          stance: a.stance.trim() || undefined,
          temperature: a.temperature,
          maxWordsPerTurn: a.maxWordsPerTurn,
        })),
        moderator: {
          displayName: modName.trim() || 'Moderator',
          modelId: modModelId,
          interjectionFrequency,
          temperature: 0.7,
        },
        targetWordCount,
        maxTurns,
      });
      toast.success('Session created');
      router.push(`/session/${session.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New session</h1>
        <p className="text-sm text-muted-foreground">
          Configure the topic, the participants, and the moderator, then run it.
        </p>
      </div>

      {/* Topic & format */}
      <Card>
        <CardHeader>
          <CardTitle>Topic</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="Should African countries build their own LLMs?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="topic">Topic framing</Label>
            <Textarea
              id="topic"
              rows={4}
              placeholder="The full framing given to every participant…"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            {topicWarning && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                ⚠ {topicWarning} Consider whether this should be published.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Format</Label>
              <Select
                value={format}
                onValueChange={(v) => v && setFormat(v as SessionFormat)}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v) => FORMATS[v as SessionFormat]?.label ?? 'Select'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {FORMAT_LIST.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{formatMeta.shape}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                placeholder="economics, politics, technology…"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Participants */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Participants</CardTitle>
            <CardDescription>
              Name, persona, and model are independent — swap any one.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={shufflePersonas}
            >
              Shuffle personas
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAgentCount(agents.length - 1)}
              disabled={agents.length <= 3}
            >
              −
            </Button>
            <span className="text-sm w-6 text-center">{agents.length}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAgentCount(agents.length + 1)}
              disabled={agents.length >= 6}
            >
              +
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            3 is cleanest on video, 4 is comfortable. At 5–6, raise the word
            target so everyone gets enough turns.
          </p>
          {agents.map((a, i) => (
            <div key={a.id} className="rounded-lg border p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Character name</Label>
                  <Input
                    value={a.displayName}
                    onChange={(e) =>
                      updateAgent(a.id, { displayName: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Persona</Label>
                  <Select
                    value={a.personaId}
                    onValueChange={(v) =>
                      v && updateAgent(a.id, { personaId: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(v) =>
                          BUILT_IN_PERSONAS.find((p) => p.id === v)?.name ??
                          'Select'
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {BUILT_IN_PERSONAS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Model</Label>
                  <ModelSelect
                    value={a.modelId}
                    available={available}
                    onChange={(v) => updateAgent(a.id, { modelId: v })}
                  />
                </div>
              </div>

              {stanceRequired && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Stance{' '}
                    {format === 'debate' && (
                      <span className="text-destructive">*</span>
                    )}
                  </Label>
                  <Input
                    placeholder='e.g. "For", "Against", or a specific position'
                    value={a.stance}
                    onChange={(e) =>
                      updateAgent(a.id, { stance: e.target.value })
                    }
                  />
                </div>
              )}

              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Advanced
                </summary>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Temperature ({a.temperature})</Label>
                    <Input
                      type="number"
                      step="0.05"
                      min={0}
                      max={2}
                      value={a.temperature}
                      onChange={(e) =>
                        updateAgent(a.id, {
                          temperature: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Max words / turn</Label>
                    <Input
                      type="number"
                      min={40}
                      max={600}
                      value={a.maxWordsPerTurn}
                      onChange={(e) =>
                        updateAgent(a.id, {
                          maxWordsPerTurn: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              </details>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Seat {i + 1}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Source material */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Source material</CardTitle>
            <CardDescription>
              Optional. Injected into every participant; the moderator challenges
              claims that contradict it. The highest-leverage lever for quality.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              render={<label htmlFor="src-upload" />}
            >
              Upload .txt/.md
            </Button>
            <input
              id="src-upload"
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              multiple
              hidden
              onChange={onUploadFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addSource}
              disabled={sources.length >= 5}
            >
              Paste text
            </Button>
          </div>
        </CardHeader>
        {sources.length > 0 && (
          <CardContent className="space-y-3">
            {sources.map((s) => {
              const words = s.content.trim()
                ? s.content.trim().split(/\s+/).length
                : 0;
              return (
                <div key={s.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      className="h-7"
                      value={s.title}
                      onChange={(e) =>
                        updateSource(s.id, { title: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeSource(s.id)}
                    >
                      Remove
                    </Button>
                  </div>
                  <Textarea
                    rows={4}
                    placeholder="Paste research, an article, notes…"
                    value={s.content}
                    onChange={(e) =>
                      updateSource(s.id, { content: e.target.value })
                    }
                  />
                  <p
                    className={
                      'text-xs ' +
                      (words > 4000
                        ? 'text-destructive'
                        : 'text-muted-foreground')
                    }
                  >
                    {words.toLocaleString()} words
                    {words > 4000 && ' — over the 4,000-word guideline'}
                  </p>
                </div>
              );
            })}
          </CardContent>
        )}
      </Card>

      {/* Moderator */}
      <Card>
        <CardHeader>
          <CardTitle>Moderator</CardTitle>
          <CardDescription>
            Steers with tactical modes — give it a frontier model.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={modName}
              onChange={(e) => setModName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            <ModelSelect
              value={modModelId}
              available={available}
              onChange={setModModelId}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Interjection frequency</Label>
            <Select
              value={interjectionFrequency}
              onValueChange={(v) =>
                v && setInterjectionFrequency(v as 'low' | 'medium' | 'high')
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {(v) =>
                    v === 'low'
                      ? 'Low'
                      : v === 'high'
                        ? 'High'
                        : 'Medium'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low (~every 5th turn)</SelectItem>
                <SelectItem value="medium">Medium (~every 3rd turn)</SelectItem>
                <SelectItem value="high">High (~every 2nd turn)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Length */}
      <Card>
        <CardHeader>
          <CardTitle>Length</CardTitle>
          <CardDescription>
            Word budget controls length (~150 words per spoken minute).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">
              Target word count (~{Math.round(targetWordCount / 150)} min)
            </Label>
            <Input
              type="number"
              min={300}
              step={100}
              value={targetWordCount}
              onChange={(e) => setTargetWordCount(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Max turns (hard cap 40)</Label>
            <Input
              type="number"
              min={4}
              max={40}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Number(e.target.value))}
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" onClick={() => router.push('/')}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create session'}
        </Button>
      </div>
    </div>
  );
}

function ModelSelect({
  value,
  available,
  onChange,
}: {
  value: string;
  available: Record<ProviderId, boolean> | null;
  onChange: (v: string) => void;
}) {
  const providers = Array.from(new Set(MODELS.map((m) => m.provider)));
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger>
        <SelectValue>
          {(v) => MODELS.find((m) => m.id === v)?.displayName ?? 'Select model'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => (
          <SelectGroup key={p}>
            <SelectLabel>{PROVIDER_LABEL[p]}</SelectLabel>
            {MODELS.filter((m) => m.provider === p).map((m) => {
              const ok = available ? available[m.provider] : true;
              return (
                <SelectItem key={m.id} value={m.id} disabled={!ok}>
                  <span className="flex items-center gap-2">
                    {m.displayName}
                    {!ok && (
                      <Badge variant="outline" className="text-[10px]">
                        {available ? 'unavailable' : '…'}
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function detectSensitiveTopic(topic: string): string | null {
  const t = topic.toLowerCase();
  if (/\b(election|vote|ballot|candidate)\b/.test(t))
    return 'This topic touches on elections.';
  if (/\b(medical|cancer|vaccine|diagnos|treatment|drug)\b/.test(t))
    return 'This topic involves medical claims.';
  if (/\b(lawsuit|court|trial|convicted|allegedly)\b/.test(t))
    return 'This topic may involve active legal proceedings.';
  return null;
}
