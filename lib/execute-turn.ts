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
import { EmptyContentError } from '@/lib/providers/errors';
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

/** Generous, word-budget-independent token ceiling (P0-1 §2). */
function maxTokensFor(plan: TurnPlan): number {
  const floor = plan.speakerId === MODERATOR_ID ? 400 : 600;
  return Math.max(floor, plan.maxWords * 4);
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
  const adapter = overrideAdapter ?? getAdapter(model.provider);

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

  const systemPrompt = isModerator
    ? buildModeratorSystemPrompt(config)
    : buildAgentSystemPrompt(config, plan.agent!, {
        holdsSeat: plan.holdsSeat,
        search:
          webSearchMaxUses !== undefined ? 'native' : useSharedSearch ? 'shared' : undefined,
        researchPack,
      });

  const buildTurn = (
    result: GenerateResult,
    wasTruncated: boolean,
    searches: TurnSearch[] | undefined,
    searchDegraded: boolean,
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
    createdAt: new Date().toISOString(),
  });

  // --- Interjection (A-1): short reaction, low token budget, [SKIP] allowed ---
  if (plan.turnClass === 'interjection') {
    // Nudge away from repeated reactions ("Exactly." three times over).
    const recent = priorTurns
      .filter((t) => t.speakerId === plan.speakerId && t.turnClass === 'interjection')
      .slice(-2)
      .map((t) => t.text.trim());
    const nudge =
      recent.length > 0
        ? `\n\nYou recently reacted with: ${recent.map((r) => `"${r}"`).join('; ')}. React differently or stay quiet.`
        : '';
    const userMessage =
      buildTurnUserMessage(priorTurns, plan.turnType, plan.instructionOpts) +
      nudge;
    const result = await withRetry(() =>
      adapter.generate({
        apiModelString: model.apiModelString,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        temperature: plan.temperature,
        maxTokens: 100,
      }),
    );
    const text = result.text.replace(/\[SKIP\]/gi, '').trim();
    // [SKIP] or nothing usable → no turn (better than a forced reaction).
    if (text.length === 0) return null;
    return buildTurn(
      { ...result, text },
      result.stopReason === 'max_tokens',
      undefined,
      false,
    );
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
    plan.instructionOpts,
    previousOpeners,
  );
  const baseMaxTokens = maxTokensFor(plan);

  // One turn attempt. In shared mode this runs the function-calling loop; in
  // native mode (or none) it's a single generate. Returns the result plus any
  // searches issued and whether a search failed.
  const call = async (
    maxTokens: number,
    userMessage: string,
  ): Promise<{ result: GenerateResult; searches?: TurnSearch[]; degraded: boolean }> => {
    const base = {
      apiModelString: model.apiModelString,
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

  // Empty: the call succeeded but content is blank. Retry twice, then fatal.
  if (!v.valid && v.reason === 'empty') {
    for (let i = 0; i < 2 && !v.valid; i++) {
      ({ result, searches, degraded } = await call(baseMaxTokens, baseUserMessage));
      v = validateTurn(result.text, result.stopReason);
    }
    if (!v.valid && v.reason === 'empty') {
      throw new EmptyContentError(model.provider, model.displayName);
    }
  }

  // Meta-commentary: the model narrated its own process (e.g. "the search
  // results show…", "now I'll compose my closing"). Retry with an explicit
  // speak-only instruction; accept after two tries (better than looping).
  if (!v.valid && v.reason === 'meta') {
    for (let i = 0; i < 2 && !v.valid && v.reason === 'meta'; i++) {
      const speakOnly = `${baseUserMessage}\n\nSpeak only the words the audience hears. Do not narrate your own process, do not discuss which source or figure to use, and do not announce what you are about to say. Begin your spoken turn directly.`;
      ({ result, searches, degraded } = await call(baseMaxTokens, speakOnly));
      v = validateTurn(result.text, result.stopReason);
    }
  }

  // Truncated: retry once with double the budget and an explicit finish
  // instruction. If it still doesn't land, persist it flagged.
  let wasTruncated = false;
  if (!v.valid && v.reason === 'truncated') {
    const retryMessage = `${baseUserMessage}\n\nKeep this turn under ${calibratedWordBudget(plan.modelId, plan.maxWords)} words and finish your final sentence completely.`;
    ({ result, searches, degraded } = await call(baseMaxTokens * 2, retryMessage));
    v = validateTurn(result.text, result.stopReason);
    wasTruncated = !v.valid;
  }

  return buildTurn(result, wasTruncated, searches, degraded);
}

export function turnWordCount(t: { text: string }): number {
  return countWords(t.text);
}
