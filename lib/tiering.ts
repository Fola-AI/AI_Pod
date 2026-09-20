// Tier-aware roster helpers (same-class pairing). Pure functions shared by the
// builder — no env access. Availability is passed in as a predicate so this stays
// client-safe (the builder derives it from the /api/providers status, which is
// already route-aware: an OpenRouter vendor is "available" iff the one gateway
// key is set).

import { MODELS, getModel, tierGap, TIER_LABEL } from '@/config/models';
import { MAX_AGENTS } from '@/lib/validation';
import type { ModelEntry, ModelTier, ProviderId } from '@/lib/types';

export type IsProviderAvailable = (provider: ProviderId) => boolean;

function enabledAtTier(tier: ModelTier): ModelEntry[] {
  return MODELS.filter((m) => m.enabled && m.tier === tier);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface MixedTierWarning {
  message: string;
  severity: 'mild' | 'serious';
}

/**
 * Warn when a roster mixes tiers, naming which agents are out of band and scaling
 * the message to the gap: frontier↔fast (gap 2) is serious; an adjacent mix
 * (frontier↔professional, professional↔fast) is mild. Returns null when every
 * agent shares a tier (or none resolve).
 */
export function mixedTierWarning(
  agents: { displayName: string; modelId: string }[],
): MixedTierWarning | null {
  const withTier = agents
    .map((a) => ({ name: a.displayName, tier: getModel(a.modelId)?.tier }))
    .filter((a): a is { name: string; tier: ModelTier } => Boolean(a.tier));
  const tiers = Array.from(new Set(withTier.map((a) => a.tier)));
  if (withTier.length < 2 || tiers.length <= 1) return null;

  // Widest gap present drives severity.
  let maxGap = 0;
  for (const a of tiers) for (const b of tiers) maxGap = Math.max(maxGap, tierGap(a, b));
  const severity: MixedTierWarning['severity'] = maxGap >= 2 ? 'serious' : 'mild';

  // Plurality tier, if one is strictly most common — its members are "in band"
  // and the rest are named as outliers. On a tie, name every agent's tier.
  const counts = new Map<ModelTier, number>();
  for (const a of withTier) counts.set(a.tier, (counts.get(a.tier) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const majorityTiers = [...counts.entries()].filter(([, n]) => n === top).map(([t]) => t);

  let body: string;
  if (majorityTiers.length === 1) {
    const majority = majorityTiers[0];
    const inBand = withTier.filter((a) => a.tier === majority).map((a) => a.name);
    const outliers = withTier.filter((a) => a.tier !== majority);
    const be = inBand.length > 1 ? 'are' : 'is';
    body =
      `${joinNames(inBand)} ${be} ${majority}, ` +
      outliers.map((a) => `${a.name} is ${a.tier}`).join(', ');
  } else {
    body = withTier.map((a) => `${a.name} is ${a.tier}`).join(', ');
  }

  const tail =
    severity === 'serious'
      ? ' Capability differences will read as persona differences.'
      : ' Adjacent tiers — the capability gap is small.';
  return { message: `Mixed tiers — ${body}.${tail}`, severity };
}

export interface TierMatchResult {
  /** One model per available vendor at the tier — distinct models guaranteed. */
  models: ModelEntry[];
  /** Vendors with no model at this tier at all (structural — thin tier). */
  missingNoModel: ProviderId[];
  /** Vendors that have a model at this tier but whose key is missing. */
  missingNoKey: ProviderId[];
  /** Vendors dropped only because the roster hit the MAX_AGENTS cap. */
  cappedOut: ProviderId[];
}

/**
 * Build a Tier Match roster: one agent per vendor at `tier`, distinct models
 * guaranteed, never selecting a model whose provider key is missing. Reports what
 * couldn't be filled (no model at the tier vs. no key) so a thin roster reads as
 * deliberate. When more vendors qualify than the app allows (MAX_AGENTS), the
 * roster is capped and the overflow vendors are reported rather than producing an
 * invalid roster. `pick` chooses among a vendor's tier models (random for shuffle).
 */
export function buildTierMatchRoster(
  tier: ModelTier,
  isAvailable: IsProviderAvailable,
  pick: (models: ModelEntry[]) => ModelEntry = (m) => m[0],
  maxAgents: number = MAX_AGENTS,
): TierMatchResult {
  const allVendors = Array.from(
    new Set(MODELS.filter((m) => m.enabled).map((m) => m.provider)),
  );
  const atTier = enabledAtTier(tier);
  const vendorsAtTier = new Set(atTier.map((m) => m.provider));

  const picked: ModelEntry[] = [];
  const missingNoModel: ProviderId[] = [];
  const missingNoKey: ProviderId[] = [];

  for (const v of allVendors) {
    if (!vendorsAtTier.has(v)) {
      missingNoModel.push(v);
      continue;
    }
    if (!isAvailable(v)) {
      missingNoKey.push(v);
      continue;
    }
    picked.push(pick(atTier.filter((m) => m.provider === v)));
  }

  // Cap to the app's agent limit; report the overflow rather than fail validation.
  const models = picked.slice(0, maxAgents);
  const cappedOut = picked.slice(maxAgents).map((m) => m.provider);
  return { models, missingNoModel, missingNoKey, cappedOut };
}

/**
 * Re-roll each agent's model within its own current tier: keep the tier, pick a
 * different available model, keep the roster's models distinct, and never pick an
 * unavailable-key model. Agents whose tier has only one available model keep it.
 * Returns the new modelId per input agent (order preserved).
 */
export function reshuffleWithinTier(
  agents: { modelId: string }[],
  isAvailable: IsProviderAvailable,
): string[] {
  const used = new Set<string>();
  return agents.map((a) => {
    const tier = getModel(a.modelId)?.tier;
    if (!tier) return a.modelId;
    const pool = enabledAtTier(tier).filter((m) => isAvailable(m.provider));
    const distinct = pool.filter((m) => !used.has(m.id));
    const choices = distinct.length ? distinct : pool;
    if (!choices.length) return a.modelId;
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    used.add(chosen.id);
    return chosen.id;
  });
}

/** Human-readable list of vendor labels for the "what's missing" note. */
export { TIER_LABEL };
