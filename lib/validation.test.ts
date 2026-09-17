import { describe, it, expect } from 'vitest';
import { createSessionSchema, validateReferences } from '@/lib/validation';

// A minimal valid input body; mode is set per-test.
function baseInput(mode: 'none' | 'shared' | 'native', modelId: string) {
  return createSessionSchema.parse({
    title: 'T',
    topic: 'Topic',
    format: 'panel',
    domain: 'energy',
    agentCount: 3,
    agents: [
      { id: 'a1', displayName: 'A', personaId: 'data-hound', modelId, temperature: 0.8, maxWordsPerTurn: 100 },
      { id: 'a2', displayName: 'B', personaId: 'contrarian', modelId: 'claude-haiku-4-5', temperature: 0.8, maxWordsPerTurn: 100 },
      { id: 'a3', displayName: 'C', personaId: 'pragmatist', modelId: 'gpt-5-6-sol', temperature: 0.8, maxWordsPerTurn: 100 },
    ],
    moderator: { modelId: 'claude-haiku-4-5' },
    webSearch: { mode },
  });
}

describe('search mode defaults', () => {
  it('defaults to shared with the B-5.5 caps', () => {
    const cfg = createSessionSchema.parse({
      title: 'T', topic: 'x', format: 'panel', domain: 'd', agentCount: 3,
      agents: [
        { id: 'a1', displayName: 'A', personaId: 'data-hound', modelId: 'gpt-5-6-sol' },
        { id: 'a2', displayName: 'B', personaId: 'contrarian', modelId: 'grok-4-6' },
        { id: 'a3', displayName: 'C', personaId: 'pragmatist', modelId: 'deepseek-chat' },
      ],
      moderator: { modelId: 'deepseek-chat' },
    });
    expect(cfg.webSearch.mode).toBe('shared');
    expect(cfg.webSearch.maxSearchesPerSession).toBe(25);
    expect(cfg.webSearch.resultsPerSearch).toBe(5);
    expect(cfg.webSearch.forceFirstSearch).toBeUndefined(); // per-model default
  });
});

describe('native mode blocks non-native providers (criterion 8)', () => {
  it('rejects an agent on a provider without native search', () => {
    // grok-4-6 (xAI) has no native search.
    const errs = validateReferences(baseInput('native', 'grok-4-6'));
    expect(errs.some((e) => /native search/i.test(e))).toBe(true);
  });
  it('allows a native-capable roster in native mode', () => {
    const errs = validateReferences(baseInput('native', 'gpt-5-6-sol'));
    expect(errs).toEqual([]);
  });
  it('allows any provider in shared mode', () => {
    const errs = validateReferences(baseInput('shared', 'grok-4-6'));
    expect(errs).toEqual([]);
  });
});
