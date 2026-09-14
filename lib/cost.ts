// Cost accounting from provider-returned token counts and registry pricing.

import { getModel } from '@/config/models';

/** Cost in USD for a single call. Missing prices count as 0 (indicative only). */
export function turnCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const model = getModel(modelId);
  if (!model) return 0;
  const inRate = model.inputPricePerMTok ?? 0;
  const outRate = model.outputPricePerMTok ?? 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/** Round to cents-ish for display without losing small amounts. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

import type { SessionConfig } from '@/lib/types';

/**
 * Indicative projected cost for a session before running it (PRD §9.3). Because
 * each turn resends the growing transcript, input tokens accumulate roughly
 * quadratically. Prices vary by model, so this blends participant prices — treat
 * the number as a ballpark, not a quote.
 */
export function estimateSessionCost(config: SessionConfig): number {
  const N = config.agentCount;
  const avgWords =
    config.agents.reduce((s, a) => s + a.maxWordsPerTurn, 0) / Math.max(1, N);
  const avgOutTokens = avgWords * 1.35;

  // Estimated turn count: intro + enough rounds to hit target + closings.
  const roundTurns = Math.min(
    config.maxTurns,
    Math.ceil(config.targetWordCount / Math.max(40, avgWords)),
  );
  const totalTurns = 1 /* mod opening */ + N /* openings */ + roundTurns + N /* closings */ + 2;

  // System prompt + source material tokens repeated every turn.
  const sourceWords = (config.sourceMaterial ?? []).reduce(
    (s, d) => s + countWords(d.content),
    0,
  );
  const perTurnFixedTokens = 450 + sourceWords * 1.35;

  // Transcript grows ~linearly; summed input over all turns is triangular.
  const totalOutputTokens = totalTurns * avgOutTokens;
  const totalTranscriptInput = avgOutTokens * (totalTurns * (totalTurns - 1)) / 2;
  const totalInputTokens = totalTranscriptInput + perTurnFixedTokens * totalTurns;

  // Blend prices across every participant + the moderator.
  const modelIds = [...config.agents.map((a) => a.modelId), config.moderator.modelId];
  const prices = modelIds.map((id) => {
    const m = getModel(id);
    return { inp: m?.inputPricePerMTok ?? 0, out: m?.outputPricePerMTok ?? 0 };
  });
  const blendedIn = prices.reduce((s, p) => s + p.inp, 0) / prices.length;
  const blendedOut = prices.reduce((s, p) => s + p.out, 0) / prices.length;

  return (
    (totalInputTokens / 1_000_000) * blendedIn +
    (totalOutputTokens / 1_000_000) * blendedOut
  );
}
