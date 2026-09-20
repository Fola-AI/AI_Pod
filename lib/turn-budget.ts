// The single source of truth for a turn's max-token ceiling (P0-1 §2), shared by
// live turns (execute-turn) AND pre-flight/test calls so a check never uses a
// budget a real turn wouldn't. A 10-token pre-flight was rejected by reasoning
// models ("max_output_tokens below minimum") even though they run fine in a
// session — the check must use the same floor the session would.

import { getModel } from '@/config/models';

/**
 * Generous, word-budget-independent token ceiling for a turn.
 * - Moderator floor 400, agent floor 600.
 * - Then max(floor, maxWords·4).
 * - Then ≥500 for models flagged needsTokenHeadroomForTools (reasoning models
 *   that go silent under a tight budget). For agents this is subsumed by the 600
 *   floor; it bites only for a moderator on such a model.
 */
export function turnMaxTokens(opts: {
  isModerator: boolean;
  maxWords: number;
  modelId: string;
}): number {
  const floor = opts.isModerator ? 400 : 600;
  const budget = Math.max(floor, opts.maxWords * 4);
  const model = getModel(opts.modelId);
  return model?.needsTokenHeadroomForTools ? Math.max(500, budget) : budget;
}

/** Token budget for a pre-flight / test call: the same floor a real agent turn
 *  gets (default maxWords 160 → 640), so a check never fails where a turn works. */
export function preflightMaxTokens(modelId: string): number {
  return turnMaxTokens({ isModerator: false, maxWords: 160, modelId });
}
