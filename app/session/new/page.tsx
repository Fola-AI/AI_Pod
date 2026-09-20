'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  MODELS,
  PROVIDER_LABEL,
  TIER_LABEL,
  TIER_ORDER,
  getModel,
  modelSupportsFunctionCalling,
  providerSupportsWebSearch,
  routeLabel,
} from '@/config/models';
import type { Character, Persona } from '@/lib/types';
import { FORMAT_LIST, FORMATS, isStanceBearing } from '@/lib/formats';
import {
  buildTierMatchRoster,
  mixedTierWarning,
  reshuffleWithinTier,
} from '@/lib/tiering';
import type {
  ModelTier,
  ProviderId,
  SessionFormat,
  SessionConfig,
} from '@/lib/types';

// How an agent's model will be grounded under the chosen session mode. `ok`
// means the agent gets live search it can toggle; otherwise the label explains
// the state (research-pack fallback, or blocked in native mode).
function agentGroundingState(
  modelId: string,
  mode: 'none' | 'shared' | 'native',
): { ok: boolean; label: string } {
  if (mode === 'none') return { ok: false, label: 'No grounding this session' };
  const model = getModel(modelId);
  if (mode === 'native') {
    return model && providerSupportsWebSearch(model.provider)
      ? { ok: true, label: 'Native provider search' }
      : {
          ok: false,
          label: `Off — ${model ? PROVIDER_LABEL[model.provider] : 'this provider'} has no native search; use Shared mode`,
        };
  }
  // shared
  return modelSupportsFunctionCalling(modelId)
    ? { ok: true, label: 'Searches via the shared web tool' }
    : { ok: false, label: "Research pack — this model can't call tools" };
}
import {
  createSession,
  fetchProviders,
  fetchPersonas,
  fetchCharacters,
  testModel,
} from '@/lib/client';
import { estimateSessionCost, formatUsd } from '@/lib/cost';
import { PRESETS } from '@/lib/presets';

interface AgentDraft {
  id: string;
  displayName: string;
  personaId: string;
  modelId: string;
  stance: string;
  temperature: number;
  maxWordsPerTurn: number;
  referenceImage: string;
  voiceId: string;
  webSearchEnabled: boolean;
  characterId?: string; // optional show-bible character (B-6)
}

const NAME_POOL = ['Lara', 'Tony', 'Kimi', 'Ada', 'Zoe', 'Ravi', 'Nia', 'Sam', 'Ben'];
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
    referenceImage: '',
    voiceId: '',
    webSearchEnabled: true,
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
  const [budgetCap, setBudgetCap] = useState('');
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
  const [modVoiceId, setModVoiceId] = useState('');
  const [interjectionFrequency, setInterjectionFrequency] = useState<
    'low' | 'medium' | 'high'
  >('medium');
  const [interjectionRate, setInterjectionRate] = useState<
    'off' | 'low' | 'medium' | 'high'
  >('medium');
  const [openingBanter, setOpeningBanter] = useState(true);
  const [searchMode, setSearchMode] = useState<'none' | 'shared' | 'native'>('shared');
  const [forceFirstSearch, setForceFirstSearch] = useState(false);
  const [researchPack, setResearchPack] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tier-aware selection: filter the pickers to one tier, and remember the last
  // Tier Match result so the thin-roster note stays visible (not just a toast).
  const [tierFilter, setTierFilter] = useState<ModelTier | 'all'>('all');
  const [verifying, setVerifying] = useState(false);
  // The applied preset stays shown in the control, marked "(modified)" once any
  // preset-controlled setting changes after applying it.
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetModified, setPresetModified] = useState(false);
  const applyingPreset = useRef(false); // suppress the modified-effect on apply
  const [tierMatchInfo, setTierMatchInfo] = useState<{
    tier: ModelTier;
    filled: number;
    missingNoModel: ProviderId[];
    missingNoKey: ProviderId[];
    cappedOut: ProviderId[];
  } | null>(null);

  type ProviderStatus = Awaited<ReturnType<typeof fetchProviders>>;
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [relationships, setRelationships] = useState<
    { agentA: string; agentB: string; dynamic: string }[]
  >([]);

  useEffect(() => {
    fetchProviders()
      .then(setProviders)
      .catch(() => setProviders(null));
    fetchPersonas()
      .then(setPersonas)
      .catch(() => setPersonas([]));
    fetchCharacters()
      .then(setCharacters)
      .catch(() => setCharacters([]));
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

  const estimatedCost = useMemo(() => {
    const cfg: SessionConfig = {
      id: 'estimate',
      title,
      topic,
      format,
      domain,
      sourceMaterial: sources
        .filter((s) => s.content.trim())
        .map((s) => ({ id: s.id, title: s.title, content: s.content })),
      agentCount: agents.length,
      agents: agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        personaId: a.personaId,
        modelId: a.modelId,
        temperature: a.temperature,
        maxWordsPerTurn: a.maxWordsPerTurn,
      })),
      moderator: {
        displayName: modName,
        modelId: modModelId,
        interjectionFrequency,
        temperature: 0.7,
      },
      targetWordCount,
      maxTurns,
      createdAt: '',
    };
    return estimateSessionCost(cfg);
  }, [
    agents,
    sources,
    modModelId,
    interjectionFrequency,
    targetWordCount,
    maxTurns,
    format,
    domain,
    title,
    topic,
    modName,
  ]);

  function setAgentCount(n: number) {
    setAgents((prev) => {
      if (n === prev.length) return prev;
      if (n < prev.length) return prev.slice(0, n);
      const next = [...prev];
      for (let i = prev.length; i < n; i++) next.push(makeAgent(i));
      return next;
    });
  }

  // Same-model guardrail (P0-3 §4).
  const distinctModels = new Set(agents.map((a) => a.modelId)).size;
  const modelWarning =
    distinctModels === 1
      ? 'All participants are using the same model. The discussion will not show variation between models.'
      : distinctModels < agents.length
        ? 'Two or more agents share a model — those voices will sound similar.'
        : null;

  // Route-aware availability, from the /api/providers status (optimistic while
  // it loads). An OpenRouter vendor is available iff the one gateway key is set.
  const providerAvailable = (p: ProviderId) => providers?.available?.[p] ?? true;

  // Mixed-tier warning — the reason for this whole feature (same-class pairing).
  const tierWarn = useMemo(
    () => mixedTierWarning(agents.map((a) => ({ displayName: a.displayName, modelId: a.modelId }))),
    [agents],
  );

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

  // Shuffle models within each agent's current tier — tiers and names kept,
  // models stay distinct, and no model with a missing key is picked (P0-3 §4).
  function shuffleWithinTier() {
    setAgents((prev) => {
      const ids = reshuffleWithinTier(prev, providerAvailable);
      return prev.map((a, i) => ({ ...a, modelId: ids[i] }));
    });
    toast.success('Models shuffled within tier — tiers and names kept');
  }

  // Tier Match preset: one agent per available vendor at the chosen tier, distinct
  // models guaranteed. Inherits Full Podcast's non-roster settings. States what it
  // couldn't fill (no model at the tier, or no key) so a thin roster is visibly
  // deliberate rather than looking like a bug.
  function applyTierMatch(tier: ModelTier) {
    const { models, missingNoModel, missingNoKey, cappedOut } = buildTierMatchRoster(
      tier,
      providerAvailable,
    );
    if (!models.length) {
      toast.error(`No available models at the ${TIER_LABEL[tier]} tier — add a provider key.`);
      return;
    }
    const fp = PRESETS.find((p) => p.id === 'full-podcast');
    if (fp) {
      setFormat(fp.format);
      setTargetWordCount(fp.targetWordCount);
      setInterjectionFrequency(fp.interjectionFrequency);
      if (fp.interjectionRate !== undefined) setInterjectionRate(fp.interjectionRate);
      if (fp.openingBanter !== undefined) setOpeningBanter(fp.openingBanter);
      if (fp.webSearchMode !== undefined) setSearchMode(fp.webSearchMode);
    }
    setAgents(models.map((m, i) => ({ ...makeAgent(i), modelId: m.id })));
    setTierFilter(tier); // focus the pickers on the matched tier
    setTierMatchInfo({ tier, filled: models.length, missingNoModel, missingNoKey, cappedOut });
    toast.success(`Tier Match — ${models.length} vendors at the ${TIER_LABEL[tier]} tier`);
  }

  // Verify every distinct model in the roster (agents + moderator) with a real
  // test call, so a depleted-credits / broken model shows BEFORE committing —
  // the check that would otherwise only fire at the run screen's pre-flight.
  async function verifyRosterModels() {
    const ids = Array.from(new Set([...agents.map((a) => a.modelId), modModelId]));
    setVerifying(true);
    try {
      const results = await Promise.all(
        ids.map(async (id) => ({ id, r: await testModel(id).catch((e) => ({ ok: false, message: (e as Error).message })) })),
      );
      const failed = results.filter((x) => !x.r.ok);
      // Refresh providers so modelTests (and thus availability) reflect the run.
      await fetchProviders().then(setProviders).catch(() => {});
      if (failed.length === 0) {
        toast.success(`All ${ids.length} models verified callable.`);
      } else {
        toast.error(
          `${failed.length} model(s) failed: ${failed
            .map((x) => `${getModel(x.id)?.displayName ?? x.id} — ${x.r.message ?? 'failed'}`)
            .join(' · ')}`,
          { duration: 12000 },
        );
      }
    } finally {
      setVerifying(false);
    }
  }

  function applyPreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    applyingPreset.current = true; // the resulting state change isn't a "modification"
    setFormat(preset.format);
    setTargetWordCount(preset.targetWordCount);
    setInterjectionFrequency(preset.interjectionFrequency);
    // B-7: presets may also set the conversational-texture switches.
    if (preset.interjectionRate !== undefined) setInterjectionRate(preset.interjectionRate);
    if (preset.openingBanter !== undefined) setOpeningBanter(preset.openingBanter);
    if (preset.webSearchMode !== undefined) setSearchMode(preset.webSearchMode);
    setAgents(
      preset.agents.map((pa, i) => ({
        ...makeAgent(i),
        displayName: pa.displayName,
        personaId: pa.personaId,
        stance: pa.stance ?? '',
      })),
    );
    setPresetId(id);
    setPresetModified(false);
    toast.success(`Applied preset: ${preset.label}`);
  }

  // Once a preset is applied, mark it "(modified)" as soon as any preset-controlled
  // setting changes. The apply itself is suppressed via the ref.
  useEffect(() => {
    if (!presetId) return;
    if (applyingPreset.current) {
      applyingPreset.current = false;
      return;
    }
    setPresetModified(true);
  }, [presetId, format, targetWordCount, interjectionFrequency, interjectionRate, openingBanter, searchMode, agents]);

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
          referenceImage: a.referenceImage.trim() || undefined,
          voiceId: a.voiceId.trim() || undefined,
          webSearchEnabled: a.webSearchEnabled,
          characterId: a.characterId || undefined,
        })),
        relationships: relationships.filter((r) => r.agentA && r.agentB && r.dynamic.trim())
          .length
          ? relationships.filter((r) => r.agentA && r.agentB && r.dynamic.trim())
          : undefined,
        moderator: {
          displayName: modName.trim() || 'Moderator',
          modelId: modModelId,
          interjectionFrequency,
          temperature: 0.7,
          voiceId: modVoiceId.trim() || undefined,
        },
        targetWordCount,
        maxTurns,
        budgetCapUsd: budgetCap.trim() ? Number(budgetCap) : undefined,
        interjectionRate,
        openingBanter,
        webSearch: {
          mode: searchMode,
          maxSearchesPerTurn: 2,
          maxSearchesPerSession: 25,
          resultsPerSearch: 5,
          // Only send when the operator opts to force ALL agents; otherwise
          // leave it per-model (auto for low-tool-propensity models).
          forceFirstSearch: forceFirstSearch || undefined,
          researchPack: researchPack || undefined,
        },
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New session</h1>
          <p className="text-sm text-muted-foreground">
            Configure the topic, the participants, and the moderator, then run it.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-48">
            <Label className="text-xs">Start from a preset</Label>
            <Select
              value={presetId ?? ''}
              onValueChange={(v) => v && applyPreset(v)}
            >
              <SelectTrigger>
                <SelectValue>
                  {(v) => {
                    const p = PRESETS.find((x) => x.id === v);
                    if (!p) return 'Choose a preset…';
                    return `${p.label}${presetModified ? ' (modified)' : ''}`;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44">
            <Label className="text-xs">Tier Match</Label>
            <Select value={''} onValueChange={(v) => v && applyTierMatch(v as ModelTier)}>
              <SelectTrigger>
                <SelectValue>
                  {() => 'Pick a tier…'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TIER_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIER_LABEL[t]} — one per vendor
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
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
            {presetId && (
              <p className="text-xs text-muted-foreground">
                {PRESETS.find((p) => p.id === presetId)?.label}
                {presetModified ? ' (modified)' : ''}: {agents.length} voices ·{' '}
                {FORMATS[format].label} · ~{targetWordCount.toLocaleString()} words ·
                banter {openingBanter ? 'on' : 'off'} · interjections {interjectionRate} ·
                search {searchMode === 'none' ? 'off' : searchMode}
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
              variant="ghost"
              size="sm"
              onClick={shuffleWithinTier}
            >
              Shuffle models within tier
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={verifyRosterModels}
              disabled={verifying}
            >
              {verifying ? 'Verifying…' : 'Verify models'}
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

          {/* Tier filter — scopes every model picker below to one tier. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Show tier:</span>
            {(['all', ...TIER_ORDER] as const).map((t) => (
              <Button
                key={t}
                type="button"
                size="sm"
                variant={tierFilter === t ? 'secondary' : 'ghost'}
                className="h-7 text-xs"
                onClick={() => setTierFilter(t)}
              >
                {t === 'all' ? 'All' : TIER_LABEL[t]}
              </Button>
            ))}
          </div>

          {tierMatchInfo && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                {TIER_LABEL[tierMatchInfo.tier]} tier — {tierMatchInfo.filled}{' '}
                {tierMatchInfo.filled === 1 ? 'vendor' : 'vendors'} in the roster.
              </p>
              {tierMatchInfo.missingNoModel.length > 0 && (
                <p className="text-muted-foreground">
                  No model at this tier:{' '}
                  {tierMatchInfo.missingNoModel.map((p) => PROVIDER_LABEL[p]).join(', ')}.
                </p>
              )}
              {tierMatchInfo.missingNoKey.length > 0 && (
                <p className="text-muted-foreground">
                  Unavailable (no key):{' '}
                  {tierMatchInfo.missingNoKey.map((p) => PROVIDER_LABEL[p]).join(', ')}.
                </p>
              )}
              {tierMatchInfo.cappedOut.length > 0 && (
                <p className="text-muted-foreground">
                  Over the {`${tierMatchInfo.filled}`}-agent cap, so omitted:{' '}
                  {tierMatchInfo.cappedOut.map((p) => PROVIDER_LABEL[p]).join(', ')}.
                </p>
              )}
            </div>
          )}

          {tierWarn && (
            <div
              className={
                'rounded-md border px-3 py-2 text-xs ' +
                (tierWarn.severity === 'serious'
                  ? 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-400'
                  : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-500')
              }
            >
              ⚠ {tierWarn.message}
            </div>
          )}
          {modelWarning && (
            <div
              className={
                'rounded-md border px-3 py-2 text-xs ' +
                (distinctModels === 1
                  ? 'border-destructive/40 bg-destructive/5 text-destructive'
                  : 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-500')
              }
            >
              ⚠ {modelWarning}
            </div>
          )}
          {agents.map((a, i) => {
            const char = characters.find((c) => c.id === a.characterId);
            const overridden = (field: 'name' | 'persona' | 'voice') => {
              if (!char) return false;
              if (field === 'name') return a.displayName !== char.displayName;
              if (field === 'persona') return a.personaId !== char.defaultPersonaId;
              return (a.voiceId || '') !== (char.voiceId || '');
            };
            const OverrideMark = ({ field }: { field: 'name' | 'persona' | 'voice' }) =>
              overridden(field) ? (
                <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-500">
                  · overridden
                </span>
              ) : null;
            return (
            <div key={a.id} className="rounded-lg border p-4 space-y-3">
              {characters.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Character (show bible, optional)</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                    value={a.characterId ?? ''}
                    onChange={(e) => {
                      const c = characters.find((x) => x.id === e.target.value);
                      updateAgent(
                        a.id,
                        c
                          ? {
                              characterId: c.id,
                              displayName: c.displayName,
                              personaId: c.defaultPersonaId || a.personaId,
                              voiceId: c.voiceId ?? a.voiceId,
                            }
                          : { characterId: undefined },
                      );
                    }}
                  >
                    <option value="">(none)</option>
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Character name
                    <OverrideMark field="name" />
                  </Label>
                  <Input
                    value={a.displayName}
                    onChange={(e) =>
                      updateAgent(a.id, { displayName: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Persona
                    <OverrideMark field="persona" />
                  </Label>
                  <Select
                    value={a.personaId}
                    onValueChange={(v) =>
                      v && updateAgent(a.id, { personaId: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(v) =>
                          personas.find((p) => p.id === v)?.name ??
                          'Select'
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {personas.map((p) => (
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
                    status={providers}
                    tierFilter={tierFilter}
                    onChange={(v) => updateAgent(a.id, { modelId: v })}
                  />
                  {(() => {
                    const m = getModel(a.modelId);
                    if (!m) return null;
                    const test = providers?.modelTests?.[a.modelId];
                    return (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          {TIER_LABEL[m.tier]}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {PROVIDER_LABEL[m.provider]} · {routeLabel(m)}
                        </span>
                        {test && (
                          <span
                            className={
                              'text-[10px] ' +
                              (test.ok
                                ? 'text-emerald-600 dark:text-emerald-500'
                                : 'text-destructive')
                            }
                            title={test.message}
                          >
                            {test.ok ? '✓ verified' : `✗ ${test.message ?? 'failed'}`}
                          </span>
                        )}
                      </div>
                    );
                  })()}
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
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Reference image (filename or URL)
                    </Label>
                    <Input
                      placeholder="lara-face.png or https://…"
                      value={a.referenceImage}
                      onChange={(e) =>
                        updateAgent(a.id, { referenceImage: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      ElevenLabs voice id (for synthesis)
                    </Label>
                    <Input
                      placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
                      value={a.voiceId}
                      onChange={(e) =>
                        updateAgent(a.id, { voiceId: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <Label className="text-xs">Grounding</Label>
                    {(() => {
                      const state = agentGroundingState(a.modelId, searchMode);
                      if (searchMode === 'none') {
                        return (
                          <p className="h-8 flex items-center text-xs text-muted-foreground">
                            No grounding this session
                          </p>
                        );
                      }
                      if (!state.ok) {
                        return (
                          <p className="h-8 flex items-center text-xs text-amber-600 dark:text-amber-500">
                            {state.label}
                          </p>
                        );
                      }
                      return (
                        <label className="flex items-center gap-2 h-8 text-sm">
                          <input
                            type="checkbox"
                            checked={a.webSearchEnabled}
                            onChange={(e) =>
                              updateAgent(a.id, { webSearchEnabled: e.target.checked })
                            }
                          />
                          {a.webSearchEnabled ? state.label : 'Grounding off for this agent'}
                        </label>
                      );
                    })()}
                  </div>
                </div>
              </details>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Seat {i + 1}
              </span>
            </div>
            );
          })}

          <div className="space-y-2 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Relationships (optional)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setRelationships((r) => [
                    ...r,
                    { agentA: agents[0]?.id ?? '', agentB: agents[1]?.id ?? '', dynamic: '' },
                  ])
                }
              >
                Add
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Chemistry from history — injected into both agents&rsquo; prompts.
            </p>
            {relationships.map((r, ri) => (
              <div key={ri} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_2fr_auto] gap-2">
                <select
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={r.agentA}
                  onChange={(e) =>
                    setRelationships((rs) =>
                      rs.map((x, i) => (i === ri ? { ...x, agentA: e.target.value } : x)),
                    )
                  }
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
                <select
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={r.agentB}
                  onChange={(e) =>
                    setRelationships((rs) =>
                      rs.map((x, i) => (i === ri ? { ...x, agentB: e.target.value } : x)),
                    )
                  }
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
                <Input
                  list="relationship-presets"
                  placeholder="e.g. Old friends who disagree about everything and enjoy it"
                  value={r.dynamic}
                  onChange={(e) =>
                    setRelationships((rs) =>
                      rs.map((x, i) => (i === ri ? { ...x, dynamic: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRelationships((rs) => rs.filter((_, i) => i !== ri))}
                >
                  ✕
                </Button>
              </div>
            ))}
            <datalist id="relationship-presets">
              <option value="Old friends who disagree about everything and enjoy it" />
              <option value="Respect each other but find the other exhausting" />
              <option value="One is always trying to make the other laugh" />
              <option value="Recently changed their mind because of something the other said" />
            </datalist>
          </div>
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
              status={providers}
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
          <div className="space-y-1.5">
            <Label className="text-xs">ElevenLabs voice id (optional)</Label>
            <Input
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              value={modVoiceId}
              onChange={(e) => setModVoiceId(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Conversation texture */}
      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <CardDescription>
            Reactions and opening chat that make it sound like people, not a panel.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Interjections (short reactions)</Label>
            <Select
              value={interjectionRate}
              onValueChange={(v) =>
                v && setInterjectionRate(v as 'off' | 'low' | 'medium' | 'high')
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {(v) =>
                    v === 'off'
                      ? 'Off'
                      : v === 'low'
                        ? 'Low'
                        : v === 'high'
                          ? 'High'
                          : 'Medium'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium (~1 per 2 turns)</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Opening banter</Label>
            <label className="flex items-center gap-2 h-8 text-sm">
              <input
                type="checkbox"
                checked={openingBanter}
                onChange={(e) => setOpeningBanter(e.target.checked)}
              />
              Light chat before the topic
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Grounding mode</Label>
            <select
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm"
              value={searchMode}
              onChange={(e) =>
                setSearchMode(e.target.value as 'none' | 'shared' | 'native')
              }
            >
              <option value="shared">Shared tool (all providers)</option>
              <option value="native">Native (Anthropic / OpenAI / Google only)</option>
              <option value="none">None</option>
            </select>
            <p className="text-[10px] text-muted-foreground">
              {searchMode === 'shared'
                ? 'Every agent searches through one internal tool (Brave), on equal footing. Models that can’t call tools get a research brief.'
                : searchMode === 'native'
                  ? 'Provider-native search. Agents on providers without it are blocked — switch them or use Shared.'
                  : 'Agents debate ungrounded.'}
            </p>
            {searchMode === 'shared' && (
              <label className="flex items-center gap-2 h-8 text-sm">
                <input
                  type="checkbox"
                  checked={forceFirstSearch}
                  onChange={(e) => setForceFirstSearch(e.target.checked)}
                />
                Force every agent to search on turn one (else auto by model)
              </label>
            )}
            {searchMode !== 'none' && (
              <label className="flex items-center gap-2 h-8 text-sm">
                <input
                  type="checkbox"
                  checked={researchPack}
                  onChange={(e) => setResearchPack(e.target.checked)}
                />
                Add a pre-run research brief for everyone
              </label>
            )}
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
          <div className="space-y-1.5">
            <Label className="text-xs">Budget cap (USD, optional)</Label>
            <Input
              type="number"
              min={0}
              step="0.5"
              placeholder="e.g. 1.00 — jumps to closings if exceeded"
              value={budgetCap}
              onChange={(e) => setBudgetCap(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <div className="rounded-lg border bg-muted/40 px-3 py-2 w-full">
              <p className="text-xs text-muted-foreground">Estimated cost</p>
              <p className="text-lg font-semibold">
                ~{formatUsd(estimatedCost)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Indicative — actual depends on models and length.
              </p>
            </div>
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
  status,
  onChange,
  tierFilter = 'all',
}: {
  value: string;
  status: Awaited<ReturnType<typeof fetchProviders>> | null;
  onChange: (v: string) => void;
  tierFilter?: ModelTier | 'all';
}) {
  // Reason a model can't be picked: no adapter, or no key. Null status = loading.
  function pickState(p: ProviderId): { ok: boolean; reason: string } {
    if (!status) return { ok: true, reason: '…' };
    if (!status.implemented[p]) return { ok: false, reason: 'no adapter' };
    if (!status.hasKey[p]) return { ok: false, reason: 'no key' };
    return { ok: status.available[p], reason: 'unavailable' };
  }
  const tiers = TIER_ORDER.filter((t) => tierFilter === 'all' || t === tierFilter);
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger>
        <SelectValue>
          {(v) => MODELS.find((m) => m.id === v)?.displayName ?? 'Select model'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {tiers.map((tier) => {
          const tierModels = MODELS.filter((m) => m.tier === tier);
          if (!tierModels.length) return null;
          const provs = Array.from(new Set(tierModels.map((m) => m.provider)));
          return (
            <SelectGroup key={tier}>
              <SelectLabel className="text-[11px] uppercase tracking-wide text-foreground">
                {TIER_LABEL[tier]}
              </SelectLabel>
              {provs.map((p) => (
                <Fragment key={`${tier}-${p}`}>
                  <SelectLabel className="pl-4 text-[10px] font-normal text-muted-foreground">
                    {PROVIDER_LABEL[p]}
                  </SelectLabel>
                  {tierModels
                    .filter((m) => m.provider === p)
                    .map((m) => {
                      const { ok, reason } = pickState(m.provider);
                      return (
                        <SelectItem key={m.id} value={m.id} disabled={!ok} className="pl-6">
                          <span className="flex items-center gap-2">
                            {m.displayName}
                            <span className="text-[10px] text-muted-foreground">
                              {routeLabel(m)}
                            </span>
                            {!ok && (
                              <Badge variant="outline" className="text-[10px]">
                                {reason}
                              </Badge>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
                </Fragment>
              ))}
            </SelectGroup>
          );
        })}
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
