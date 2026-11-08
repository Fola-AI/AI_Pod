// Executes a single planned turn: assembles prompts, calls the provider, and
// returns a Turn ready to persist. Used by /api/turn and regenerate.
//
// P0-1: max_tokens is set generously and is NEVER derived from maxWordsPerTurn
// (that only caused truncation). Concision is a prompt instruction. Every result
// is validated; truncated turns get one doubled-budget retry, empty turns get
// two retries then fail fatally (P0-2).

import type {
  GenerateResult,
  ProviderAdapter,
  SearchMode,
  SessionConfig,
  Turn,
  TurnSearch,
} from '@/lib/types';
import {
  calibratedWordBudget,
  getModel,
  MODELS,
  modelHasLowToolPropensity,
  modelSupportsFunctionCalling,
  providerSupportsWebSearch,
} from '@/config/models';
import { getAdapter, withRetry } from '@/lib/providers';
import type { ProviderId } from '@/lib/types';
import { EmptyContentError, ProviderError } from '@/lib/providers/errors';
import { hasSearchKey } from '@/lib/search';
import { runSharedSearchLoop } from '@/lib/tool-loop';
import {
  buildAgentSystemPrompt,
  buildModeratorSystemPrompt,
  buildTurnUserMessage,
  extractOpener,
} from '@/lib/prompts';
import type { TurnPlan } from '@/lib/orchestrator';
import { MODERATOR_ID } from '@/lib/orchestrator';
import { countWords, turnCostUsd } from '@/lib/cost';
import { validateTurn } from '@/lib/turn-validation';
import { turnMaxTokens } from '@/lib/turn-budget';
import {
  agentSlotInstruction,
  moderatorIssues,
  moderatorSlotInstruction,
  presentationMissingCandidate,
  rebuttalMissingRivals,
  slotLabel,
} from '@/lib/structured-rounds';

// Resolve the session's grounding mode, tolerant of legacy configs: pre-5.5
// sessions stored `webSearch.enabled` (a boolean) and used native search.
export function resolveSearchMode(config: SessionConfig): SearchMode {
  const cfg = config.webSearch as
    | (SessionConfig['webSearch'] & { enabled?: boolean })
    | undefined;
  if (!cfg) return 'shared'; // no config → new default
  if (cfg.mode) return cfg.mode;
  if (cfg.enabled === false) return 'none';
  return 'native'; // legacy shape with search on
}

// Searches already spent across the session (both modes write TurnSearch).
function searchesUsed(priorTurns: Turn[]): number {
  return priorTurns.reduce((n, t) => n + (t.searches?.length ?? 0), 0);
}

function sessionRemaining(config: SessionConfig, priorTurns: Turn[]): number {
  const perSession = config.webSearch?.maxSearchesPerSession ?? 25;
  return perSession - searchesUsed(priorTurns);
}

/** Native-search uses to grant this turn, or undefined to disable (mode: native). */
function computeWebSearchMaxUses(
  config: SessionConfig,
  plan: TurnPlan,
  priorTurns: Turn[],
  isModerator: boolean,
  provider: ProviderId,
): number | undefined {
  const cfg = config.webSearch;
  const agentOn = plan.agent ? plan.agent.webSearchEnabled !== false : false;
  const substantive = !isModerator && plan.turnClass === 'full';
  if (!agentOn || !substantive || !providerSupportsWebSearch(provider)) {
    return undefined;
  }
  const perTurn = Math.min(3, cfg?.maxSearchesPerTurn ?? 2);
  const remaining = sessionRemaining(config, priorTurns);
  if (remaining <= 0) return undefined;
  return Math.max(1, Math.min(perTurn, remaining));
}

/** Generous, word-budget-independent token ceiling (P0-1 §2). Shared with
 *  pre-flight via lib/turn-budget so a check never uses a smaller budget than a
 *  real turn (the ≥500 headroom rule for reasoning models is applied there). */
function maxTokensFor(plan: TurnPlan): number {
  return turnMaxTokens({
    isModerator: plan.speakerId === MODERATOR_ID,
    maxWords: plan.maxWords,
    modelId: plan.modelId,
  });
}

/** Map the provider-reported model string back to a registry id, if we can. */
function resolveModelId(fallbackId: string, rawModel?: string): string {
  if (!rawModel) return fallbackId;
  const match = MODELS.find(
    (m) => m.apiModelString === rawModel || m.id === rawModel,
  );
  return match?.id ?? fallbackId;
}

/**
 * Executes a turn. Returns the turn to persist, or `null` when an interjection
 * came back as [SKIP] (A-1: no turn is stored and the rotation continues).
 */
export async function executeTurn(
  config: SessionConfig,
  priorTurns: Turn[],
  plan: TurnPlan,
  // Test seam: inject a stub adapter instead of resolving one from env keys.
  overrideAdapter?: ProviderAdapter,
): Promise<Omit<Turn, 'index'> | null> {
  const model = getModel(plan.modelId);
  if (!model) {
    throw new Error(`Unknown model "${plan.modelId}".`);
  }

  // getAdapter throws MissingKeyError if no key (skipped when a stub is injected).
  const adapter = overrideAdapter ?? getAdapter(model.provider, model.route);

  const isModerator = plan.speakerId === MODERATOR_ID;
  const mode = resolveSearchMode(config);
  const substantive = !isModerator && plan.turnClass === 'full';
  const agentOn = plan.agent ? plan.agent.webSearchEnabled !== false : false;

  // Native mode (Batch 5): provider-native search on supported providers only.
  const webSearchMaxUses =
    mode === 'native'
      ? computeWebSearchMaxUses(config, plan, priorTurns, isModerator, model.provider)
      : undefined;

  // Shared mode (B-5.5): the internal web_search tool, for any function-calling
  // agent. Agents without function calling fall back to the research pack.
  const canFunctionCall = modelSupportsFunctionCalling(plan.modelId);
  const sharedRemaining = sessionRemaining(config, priorTurns);
  const useSharedSearch =
    mode === 'shared' &&
    substantive &&
    agentOn &&
    canFunctionCall &&
    hasSearchKey() &&
    sharedRemaining > 0;

  // Research pack: injected for every agent when the session opts in, and for
  // shared-mode agents that can't call tools (B-5.5).
  const researchPack =
    !isModerator && mode !== 'none' && config.researchPack
      ? config.webSearch?.researchPack === true || (mode === 'shared' && !canFunctionCall)
        ? config.researchPack
        : undefined
      : undefined;

  // Structured Rounds: this turn fills a fixed plan slot (Batch B).
  const slot = plan.slot;
  const systemPrompt = isModerator
    ? buildModeratorSystemPrompt(config)
    : buildAgentSystemPrompt(config, plan.agent!, {
        holdsSeat: plan.holdsSeat,
        search:
          webSearchMaxUses !== undefined ? 'native' : useSharedSearch ? 'shared' : undefined,
        researchPack,
        // The stated target is NOT scaled down per provider here: the programme
        // promises equal airtime, and in B-2 Claude hit the reduced figure exactly
        // (235 of 450 words). Other formats keep the calibration.
        programme: slot ? { slot, targetWords: plan.maxWords } : undefined,
      });

  const buildTurn = (
    result: GenerateResult,
    wasTruncated: boolean,
    searches: TurnSearch[] | undefined,
    searchDegraded: boolean,
    emptyRetries = 0,
  ): Omit<Turn, 'index'> => ({
    speakerId: plan.speakerId,
    speakerDisplayName: plan.speakerDisplayName,
    turnType: plan.turnType,
    turnClass: plan.turnClass,
    text: result.text,
    searches: searches && searches.length ? searches : undefined,
    searchDegraded: searchDegraded || undefined,
    modelId: resolveModelId(plan.modelId, result.rawModel),
    personaId: plan.personaId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: turnCostUsd(plan.modelId, result.inputTokens, result.outputTokens),
    latencyMs: result.latencyMs,
    wasEdited: false,
    isStale: false,
    wasTruncated,
    emptyRetries: emptyRetries || undefined,
    createdAt: new Date().toISOString(),
  });

  // --- Interjection (A-1): short reaction, low token budget, [SKIP] allowed ---
  if (plan.turnClass === 'interjection') {
    // Nudge away from repeated reactions — now that interjections are more
    // frequent, avoid the whole panel echoing "Exactly." Feed the recent
    // interjections across all speakers (opener-variety mechanism, reused).
    const recent = priorTurns
      .filter((t) => t.turnClass === 'interjection')
      .slice(-3)
      .map((t) => t.text.trim());
    const nudge =
      recent.length > 0
        ? `\n\nRecent reactions in this discussion: ${recent.map((r) => `"${r}"`).join('; ')}. Say something clearly different, or stay quiet.`
        : '';
    const userMessage =
      buildTurnUserMessage(priorTurns, plan.turnType, plan.instructionOpts) +
      nudge;
    const result = await withRetry(() =>
      adapter.generate({
        apiModelString: model.apiModelString,
      reasoningEffort: model.reasoningEffort,
      timeoutMs: model.callTimeoutMs,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        temperature: plan.temperature,
        // The prompt keeps reactions to 3–15 words; this ceiling is headroom so
        // a reasoning model isn't cut off mid-reaction (the old 100-token cap
        // exported "Aisha, measurable revenue is not").
        maxTokens: INTERJECTION_MAX_TOKENS,
      }),
    );
    const raw = result.text.replace(/\[SKIP\]/gi, '').trim();
    // [SKIP], nothing usable, or only a fragment → no turn (the route falls
    // through to the next full turn). A cut-off reaction is never stored.
    const cut = result.stopReason === 'max_tokens';
    const text = cleanInterjection(raw, cut);
    if (!text) return null;
    return buildTurn({ ...result, text }, cut, undefined, false);
  }

  // Feed this speaker their own last one or two openers so they vary (agents
  // only — the moderator's brief turns don't need it).
  const previousOpeners = isModerator
    ? []
    : priorTurns
        .filter((t) => t.speakerId === plan.speakerId && t.turnClass !== 'interjection')
        .slice(-2)
        .map((t) => extractOpener(t.text));

  const baseUserMessage = buildTurnUserMessage(
    priorTurns,
    plan.turnType,
    slot
      ? {
          ...plan.instructionOpts,
          structuredInstruction: isModerator
            ? moderatorSlotInstruction(config, slot)
            : agentSlotInstruction(config, slot),
        }
      : plan.instructionOpts,
    previousOpeners,
  );
  const baseMaxTokens = maxTokensFor(plan);

  // One turn attempt. In shared mode this runs the function-calling loop; in
  // native mode (or none) it's a single generate. Returns the result plus any
  // searches issued and whether a search failed.
  // Timed, so optional retries can tell whether another call still fits.
  const call = async (
    maxTokens: number,
    userMessage: string,
  ): Promise<{ result: GenerateResult; searches?: TurnSearch[]; degraded: boolean }> => {
    const t0 = Date.now();
    try {
      return await callOnce(maxTokens, userMessage);
    } finally {
      longestCallMs = Math.max(longestCallMs, Date.now() - t0);
    }
  };
  const turnStart = Date.now();
  let longestCallMs = 0;
  /**
   * Optional retries (meta, truncation, Structured Rounds reminders) only run if
   * another call as long as the slowest so far still fits the turn's time
   * budget. A slow reasoning model (Grok 4.7: ~2.5 min per call) otherwise blew
   * the route's 270s deadline on a reminder retry and the whole turn failed —
   * when keeping the draft with its flag was always an acceptable outcome.
   */
  const canAffordRetry = (what: string): boolean => {
    const used = Date.now() - turnStart;
    const ok = used + longestCallMs * 1.1 < RETRY_TIME_BUDGET_MS;
    if (!ok) {
      console.log(
        `[turn] ${plan.speakerDisplayName} (${model.displayName}): skipped ${what} retry — ${Math.round(used / 1000)}s used, slowest call ${Math.round(longestCallMs / 1000)}s`,
      );
    }
    return ok;
  };
  const callOnce = async (
    maxTokens: number,
    userMessage: string,
  ): Promise<{ result: GenerateResult; searches?: TurnSearch[]; degraded: boolean }> => {
    const base = {
      apiModelString: model.apiModelString,
      reasoningEffort: model.reasoningEffort,
      timeoutMs: model.callTimeoutMs,
      systemPrompt,
      messages: [{ role: 'user' as const, content: userMessage }],
      temperature: plan.temperature,
      maxTokens,
    };
    if (useSharedSearch) {
      // Guarantee each agent grounds at least once: force a search on their
      // first substantive turn (models vary widely in tool-use propensity, and
      // equal footing across characters is the point of shared mode).
      const priorFullTurns = priorTurns.some(
        (t) => t.speakerId === plan.speakerId && t.turnClass === 'full',
      );
      // Per-agent override → session override → default by model tool-propensity
      // (on for low-propensity models like DeepSeek/gpt-oss, off for the rest).
      const forceFirstOn =
        plan.agent?.forceFirstSearch ??
        config.webSearch?.forceFirstSearch ??
        modelHasLowToolPropensity(plan.modelId);
      const budget = {
        perTurn: Math.min(3, config.webSearch?.maxSearchesPerTurn ?? 2),
        resultsPerSearch: config.webSearch?.resultsPerSearch ?? 5,
        sessionRemaining: sharedRemaining,
        forceFirst: forceFirstOn && !priorFullTurns,
      };
      const outcome = await withRetry(() => runSharedSearchLoop(adapter, base, budget));
      return { result: outcome.result, searches: outcome.searches, degraded: outcome.degraded };
    }
    const result = await withRetry(() => adapter.generate({ ...base, webSearchMaxUses }));
    return { result, searches: result.searches, degraded: false };
  };

  // Attempt 1.
  let { result, searches, degraded } = await call(baseMaxTokens, baseUserMessage);
  let v = validateTurn(result.text, result.stopReason);

  // Empty: the call succeeded but content is blank. Retry twice (fresh whole-turn
  // call, full context), then fatal. Count the empties so a model that blanks on
  // >half its turns can be flagged as a roster problem on the transcript (bug 2).
  let emptyRetries = 0;
  if (!v.valid && v.reason === 'empty') {
    emptyRetries = 1; // attempt 1 came back empty
    for (let i = 0; i < 2 && !v.valid; i++) {
      ({ result, searches, degraded } = await call(baseMaxTokens, baseUserMessage));
      v = validateTurn(result.text, result.stopReason);
      if (!v.valid && v.reason === 'empty') emptyRetries++;
    }
    if (!v.valid && v.reason === 'empty') {
      throw new EmptyContentError(model.provider, model.displayName);
    }
  }

  // Meta-commentary: the model narrated its own process (e.g. "the search
  // results show…", "now I'll compose my closing"). Retry with an explicit
  // speak-only instruction; accept after two tries (better than looping).
  if (!v.valid && v.reason === 'meta') {
    for (let i = 0; i < 2 && !v.valid && v.reason === 'meta' && canAffordRetry('speak-only'); i++) {
      const speakOnly = `${baseUserMessage}\n\nSpeak only the words the audience hears. Do not narrate your own process, do not discuss which source or figure to use, and do not announce what you are about to say. Begin your spoken turn directly.`;
      ({ result, searches, degraded } = await call(baseMaxTokens, speakOnly));
      v = validateTurn(result.text, result.stopReason);
    }
  }

  // Truncated: retry up to twice with double the budget and an explicit finish
  // instruction. If it STILL ends mid-sentence, never export it that way (rule 2):
  // trim back to the last complete sentence and keep the flag. If nothing complete
  // remains, it's unusable — halt (like empty) rather than persist a fragment.
  let wasTruncated = false;
  if (!v.valid && v.reason === 'truncated') {
    const retryMessage = `${baseUserMessage}\n\nKeep this turn under ${slot ? plan.maxWords : calibratedWordBudget(plan.modelId, plan.maxWords)} words and finish your final sentence completely.`;
    for (let i = 0; i < 2 && !v.valid && v.reason === 'truncated' && canAffordRetry('truncation'); i++) {
      ({ result, searches, degraded } = await call(baseMaxTokens * 2, retryMessage));
      v = validateTurn(result.text, result.stopReason);
    }
    if (!v.valid && v.reason === 'truncated') {
      const trimmed = trimToLastSentence(result.text);
      if (!trimmed) {
        // No complete sentence to salvage — surface it, don't ship a fragment.
        throw new ProviderError(
          `${model.displayName} could not produce a complete sentence after retries (${model.provider}).`,
          { provider: model.provider, failureClass: 'fatal' },
        );
      }
      result = { ...result, text: trimmed };
      wasTruncated = true; // content was cut back; flag for the UI/export
    }
  }

  // Structured Rounds (B8): format-specific checks on top of validateTurn. Each
  // failure is retried once with a pointed reminder; a retry that is itself
  // malformed is discarded (the first, valid draft is kept). If the rule is
  // still broken the turn is kept and flagged — never silently dropped.
  const validationFlags: string[] = [];
  if (slot) {
    type Check = { flag: string; issue: () => string | null };
    const checks: Check[] = [];
    if (slot.kind === 'PRESENTATION' && plan.agent) {
      const a = plan.agent;
      checks.push({
        flag: 'presentation_missing_candidate',
        issue: () =>
          presentationMissingCandidate(result.text, a)
            ? `This is your presentation for ${a.candidate}. Name ${a.candidate} explicitly, and speak only about ${a.candidate}'s record and plans.`
            : null,
      });
    } else if (slot.kind === 'REBUTTAL' && plan.agent) {
      const a = plan.agent;
      checks.push({
        flag: 'rebuttal_incomplete',
        issue: () => {
          const missing = rebuttalMissingRivals(result.text, a, config);
          return missing.length
            ? `Your rebuttal must name and challenge every rival. You did not address: ${missing
                .map((m) => `${m.displayName}${m.candidate ? ` (${m.candidate})` : ''}`)
                .join(', ')}. Name each of them and give at least one evidence-based challenge to each.`
            : null;
        },
      });
    } else if (isModerator) {
      checks.push({
        flag: 'moderator_rule',
        issue: () => {
          const issues = moderatorIssues(result.text, slot, config);
          return issues.length
            ? `Your last draft broke the programme rules: it ${issues.join('; and ')}. Rewrite it: ask no advocate a question, and use exactly the order you were given.`
            : null;
        },
      });
    }
    for (const c of checks) {
      const reminder = c.issue();
      if (!reminder) continue;
      if (!canAffordRetry(c.flag)) {
        validationFlags.push(c.flag); // keep the draft, flagged — never fail the turn
        continue;
      }
      const kept = { result, searches, degraded };
      ({ result, searches, degraded } = await call(baseMaxTokens, `${baseUserMessage}\n\n${reminder}`));
      if (!validateTurn(result.text, result.stopReason).valid) {
        ({ result, searches, degraded } = kept); // malformed retry — keep the valid draft
      }
      if (c.issue()) validationFlags.push(c.flag);
    }
    // Run log: actual words against the drafting target for every turn.
    console.log(
      `[structured] slot ${plan.planSlot} ${slotLabel(config, slot)} — ${plan.speakerDisplayName}: ${countWords(
        result.text,
      )}/${plan.maxWords} words${validationFlags.length ? ` [${validationFlags.join(', ')}]` : ''}`,
    );
  }

  return {
    ...buildTurn(result, wasTruncated, searches, degraded, emptyRetries),
    planSlot: plan.planSlot,
    validationFlags: validationFlags.length ? validationFlags : undefined,
  };
}

export function turnWordCount(t: { text: string }): number {
  return countWords(t.text);
}

/**
 * Trim text back to its last complete sentence (ending on . ! ? … with any
 * trailing quote/bracket), so a still-truncated turn never reaches export ending
 * mid-sentence (standing rule 2). Returns '' if no usable complete sentence
 * remains (caller then treats it as unusable rather than persisting a fragment).
 */
const INTERJECTION_MAX_TOKENS = 1000;
/** Optional in-turn retries must finish inside this (route soft deadline: 270s). */
const RETRY_TIME_BUDGET_MS = 240_000;
const INTERJECTION_MAX_WORDS = 30;

/**
 * Make an interjection safe to store, or return '' to skip it. A reaction that
 * finished naturally and is short is kept as written (a spoken aside may lack a
 * full stop). If it was cut off, or ran long, keep only whole sentences from the
 * start, up to the word cap — never a fragment.
 */
export function cleanInterjection(text: string, cut: boolean): string {
  const t = text.trim();
  if (!t) return '';
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  if (!cut && words(t) <= INTERJECTION_MAX_WORDS) return t;
  const sentences = t.match(/[^.!?…]+[.!?…]+["'’”)\]]*/g) ?? [];
  let out = '';
  for (const s of sentences) {
    const next = `${out} ${s.trim()}`.trim();
    if (words(next) > INTERJECTION_MAX_WORDS) break;
    out = next;
  }
  return out;
}

export function trimToLastSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[\s\S]*[.!?…]["'’)\]]*/);
  const cut = m ? m[0].trim() : '';
  return cut.length >= 20 ? cut : '';
}
