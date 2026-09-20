import { describe, it, expect } from 'vitest';
import {
  mixedTierWarning,
  buildTierMatchRoster,
  reshuffleWithinTier,
} from './tiering';
import { getModel } from '@/config/models';
import type { ProviderId } from '@/lib/types';

// Known registry ids by tier (see config/models.ts).
const FRONTIER = 'claude-opus-5';
const PROFESSIONAL = 'claude-sonnet-5';
const FAST = 'claude-haiku-4-5';

describe('mixedTierWarning', () => {
  it('returns null when every agent shares a tier', () => {
    expect(
      mixedTierWarning([
        { displayName: 'Lara', modelId: FRONTIER },
        { displayName: 'Tony', modelId: FRONTIER },
      ]),
    ).toBeNull();
  });

  it('is serious for a frontier↔fast mix and names both agents', () => {
    const w = mixedTierWarning([
      { displayName: 'Lara', modelId: FRONTIER },
      { displayName: 'Tony', modelId: FAST },
    ])!;
    expect(w.severity).toBe('serious');
    expect(w.message).toContain('Lara is frontier');
    expect(w.message).toContain('Tony is fast');
    expect(w.message).toContain('Capability differences will read as persona differences.');
  });

  it('is mild for an adjacent (frontier↔professional) mix', () => {
    const w = mixedTierWarning([
      { displayName: 'Lara', modelId: FRONTIER },
      { displayName: 'Tony', modelId: PROFESSIONAL },
    ])!;
    expect(w.severity).toBe('mild');
    expect(w.message).toContain('Adjacent tiers');
  });

  it('names the out-of-band agent when there is a plurality tier', () => {
    const w = mixedTierWarning([
      { displayName: 'Lara', modelId: FRONTIER },
      { displayName: 'Kimi', modelId: FRONTIER },
      { displayName: 'Tony', modelId: FAST },
    ])!;
    // Majority frontier stated together; the outlier named with its tier.
    expect(w.message).toContain('Lara and Kimi are frontier');
    expect(w.message).toContain('Tony is fast');
    expect(w.severity).toBe('serious');
  });
});

describe('buildTierMatchRoster', () => {
  it('gives one distinct model per available vendor at the tier', () => {
    const { models } = buildTierMatchRoster('frontier', () => true);
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // distinct
    // one per vendor
    const vendors = models.map((m) => m.provider);
    expect(new Set(vendors).size).toBe(vendors.length);
    expect(models.every((m) => m.tier === 'frontier')).toBe(true);
  });

  it('reports vendors with no model at the tier (Meta and Mistral at frontier)', () => {
    const { missingNoModel } = buildTierMatchRoster('frontier', () => true);
    expect(missingNoModel).toContain('meta');
    expect(missingNoModel).toContain('mistral');
  });

  it('caps the roster at MAX_AGENTS and reports the overflow vendors', () => {
    // Frontier has 7 available vendors; the cap is 6.
    const { models, cappedOut } = buildTierMatchRoster('frontier', () => true);
    expect(models.length).toBeLessThanOrEqual(6);
    expect(cappedOut.length).toBeGreaterThan(0); // at least one vendor dropped
    // A capped-out vendor must not also appear in the roster.
    const inRoster = new Set(models.map((m) => m.provider));
    expect(cappedOut.every((p) => !inRoster.has(p))).toBe(true);
  });

  it('reports vendors with a model but no key as missingNoKey, and excludes them', () => {
    const isAvailable = (p: ProviderId) => p !== 'alibaba';
    const { models, missingNoKey } = buildTierMatchRoster('frontier', isAvailable);
    expect(missingNoKey).toContain('alibaba');
    expect(models.some((m) => m.provider === 'alibaba')).toBe(false);
  });

  it('reports the empty professional tier for Alibaba', () => {
    const { missingNoModel } = buildTierMatchRoster('professional', () => true);
    expect(missingNoModel).toContain('alibaba');
  });
});

describe('reshuffleWithinTier', () => {
  it('keeps each agent within its tier and never picks an unavailable model', () => {
    const agents = [{ modelId: FRONTIER }, { modelId: FAST }];
    // Only allow anthropic, so every pick must be an available anthropic model.
    const ids = reshuffleWithinTier(agents, (p) => p === 'anthropic');
    expect(getModel(ids[0])!.tier).toBe('frontier');
    expect(getModel(ids[1])!.tier).toBe('fast');
    expect(getModel(ids[0])!.provider).toBe('anthropic');
    expect(getModel(ids[1])!.provider).toBe('anthropic');
  });

  it('keeps models distinct across the roster where the tier allows', () => {
    const agents = [{ modelId: FRONTIER }, { modelId: FRONTIER }];
    const ids = reshuffleWithinTier(agents, () => true);
    expect(ids[0]).not.toBe(ids[1]); // frontier has >1 model
  });
});
