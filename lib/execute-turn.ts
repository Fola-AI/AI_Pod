// Executes a single planned turn: assembles prompts, calls the provider, and
// returns a Turn ready to persist. Used by /api/turn and regenerate.
//
// P0-1: max_tokens is set generously and is NEVER derived from maxWordsPerTurn
// (that only caused truncation). Concision is a prompt instruction. Every result
// is validated; truncated turns get one doubled-budget retry, empty turns get
// two retries then fail fatally (P0-2).

import type {
  GenerateResult,
  SessionConfig,
  Turn,
} from '@/lib/types';
import { getModel, MODELS } from '@/config/models';
import { getAdapter, withRetry } from '@/lib/providers';
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

export async function executeTurn(
  config: SessionConfig,
  priorTurns: Turn[],
  plan: TurnPlan,
): Promise<Omit<Turn, 'index'>> {
  const model = getModel(plan.modelId);
  if (!model) {
    throw new Error(`Unknown model "${plan.modelId}".`);
  }

  const adapter = getAdapter(model.provider); // throws MissingKeyError if no key

  const isModerator = plan.speakerId === MODERATOR_ID;
  const systemPrompt = isModerator
    ? buildModeratorSystemPrompt(config)
    : buildAgentSystemPrompt(config, plan.agent!, {
        holdsSeat: plan.holdsSeat,
      });

  // Feed this speaker their own last one or two openers so they vary (agents
  // only — the moderator's brief turns don't need it).
  const previousOpeners = isModerator
    ? []
    : priorTurns
        .filter((t) => t.speakerId === plan.speakerId)
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

  const costUsd = turnCostUsd(
    plan.modelId,
    result.inputTokens,
    result.outputTokens,
  );

  return {
    speakerId: plan.speakerId,
    speakerDisplayName: plan.speakerDisplayName,
    turnType: plan.turnType,
    text: result.text,
    // Read the model that actually produced this from the response path (P0-3).
    modelId: resolveModelId(plan.modelId, result.rawModel),
    personaId: plan.personaId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
    latencyMs: result.latencyMs,
    wasEdited: false,
    isStale: false,
    wasTruncated,
    createdAt: new Date().toISOString(),
  };
}

export function turnWordCount(t: { text: string }): number {
  return countWords(t.text);
}
