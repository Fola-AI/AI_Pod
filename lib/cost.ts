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
