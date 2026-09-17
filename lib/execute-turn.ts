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
  SessionConfig,
  Turn,
} from '@/lib/types';
import { getModel, MODELS, providerSupportsWebSearch } from '@/config/models';
import { getAdapter, withRetry } from '@/lib/providers';
import type { ProviderId } from '@/lib/types';
import { EmptyContentError } from '@/lib/providers/errors';
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

/** Search uses to grant this turn, or undefined to disable search (P1-2). */
function computeWebSearchMaxUses(
  config: SessionConfig,
  plan: TurnPlan,
  priorTurns: Turn[],
  isModerator: boolean,
  provider: ProviderId,
): number | undefined {
  const cfg = config.webSearch;
  const sessionOn = cfg?.enabled !== false; // default true
  const agentOn = plan.agent ? plan.agent.webSearchEnabled !== false : false;
  const substantive = !isModerator && plan.turnClass === 'full';
  if (!sessionOn || !agentOn || !substantive || !providerSupportsWebSearch(provider)) {
    return undefined;
  }
  const perTurn = Math.min(3, cfg?.maxSearchesPerTurn ?? 2);
  const perSession = cfg?.maxSearchesPerSession ?? 20;
  const used = priorTurns.reduce((n, t) => n + (t.searches?.length ?? 0), 0);
  const remaining = perSession - used;
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

  // Web search (P1-2): only supported providers, only substantive agent turns,
  // within the per-turn and per-session caps.
  const webSearchMaxUses = computeWebSearchMaxUses(
    config,
    plan,
    priorTurns,
    isModerator,
    model.provider,
  );

  const systemPrompt = isModerator
    ? buildModeratorSystemPrompt(config)
    : buildAgentSystemPrompt(config, plan.agent!, {
        holdsSeat: plan.holdsSeat,
        webSearch: webSearchMaxUses !== undefined,
      });

  const buildTurn = (
    result: GenerateResult,
    wasTruncated: boolean,
  ): Omit<Turn, 'index'> => ({
    speakerId: plan.speakerId,
    speakerDisplayName: plan.speakerDisplayName,
    turnType: plan.turnType,
    turnClass: plan.turnClass,
    text: result.text,
    searches: result.searches,
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
    return buildTurn({ ...result, text }, result.stopReason === 'max_tokens');
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

  const call = (maxTokens: number, userMessage: string) =>
    withRetry(() =>
      adapter.generate({
        apiModelString: model.apiModelString,
        systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        temperature: plan.temperature,
        maxTokens,
        webSearchMaxUses,
      }),
    );

  // Attempt 1.
  let result: GenerateResult = await call(baseMaxTokens, baseUserMessage);
  let v = validateTurn(result.text, result.stopReason);

  // Empty: the call succeeded but content is blank. Retry twice, then fatal.
  if (!v.valid && v.reason === 'empty') {
    for (let i = 0; i < 2 && !v.valid; i++) {
      result = await call(baseMaxTokens, baseUserMessage);
      v = validateTurn(result.text, result.stopReason);
    }
    if (!v.valid && v.reason === 'empty') {
      throw new EmptyContentError(model.provider, model.displayName);
    }
  }

  // Truncated: retry once with double the budget and an explicit finish
  // instruction. If it still doesn't land, persist it flagged.
  let wasTruncated = false;
  if (!v.valid && v.reason === 'truncated') {
    const retryMessage = `${baseUserMessage}\n\nKeep this turn under ${plan.maxWords} words and finish your final sentence completely.`;
    result = await call(baseMaxTokens * 2, retryMessage);
    v = validateTurn(result.text, result.stopReason);
    wasTruncated = !v.valid;
  }

  return buildTurn(result, wasTruncated);
}

export function turnWordCount(t: { text: string }): number {
  return countWords(t.text);
}
