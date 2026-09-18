import { describe, it, expect } from 'vitest';
import { buildAgentSystemPrompt } from '@/lib/prompts';
import type { AgentConfig, SessionConfig } from '@/lib/types';

const config = {
  id: 's',
  title: 'T',
  topic: 'Topic',
  format: 'panel',
  domain: 'test',
  agentCount: 1,
  agents: [],
  moderator: { displayName: 'M', modelId: 'claude-haiku-4-5', interjectionFrequency: 'medium', temperature: 0.7 },
  targetWordCount: 1200,
  maxTurns: 20,
  createdAt: '',
} as unknown as SessionConfig;

function agent(over: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    displayName: 'Lara',
    personaId: 'pragmatist',
    modelId: 'claude-haiku-4-5',
    temperature: 0.8,
    maxWordsPerTurn: 100,
    ...over,
  };
}

describe('buildAgentSystemPrompt persona resolution (B-6)', () => {
  it('uses the personaSnapshot text when present (replay/provenance)', () => {
    const a = agent({
      personaId: 'pragmatist',
      personaSnapshot: {
        name: 'Snapshot Persona',
        shortDescription: 'snap short',
        systemPromptFragment: 'SNAPSHOT-FRAGMENT-UNIQUE',
        speakingStyle: 'SNAPSHOT-STYLE-UNIQUE',
      },
    });
    const p = buildAgentSystemPrompt(config, a);
    expect(p).toContain('SNAPSHOT-FRAGMENT-UNIQUE');
    expect(p).toContain('SNAPSHOT-STYLE-UNIQUE');
  });

  it('falls back to the code persona for a pre-migration session (no snapshot)', () => {
    const a = agent({ personaId: 'pragmatist', personaSnapshot: undefined });
    const p = buildAgentSystemPrompt(config, a);
    // The built-in pragmatist fragment mentions "Monday morning".
    expect(p).toMatch(/Monday morning/i);
  });

  it('a later persona edit cannot change a snapshotted session', () => {
    // The snapshot is self-contained; nothing reads the live persona here.
    const a = agent({
      personaId: 'pragmatist',
      personaSnapshot: {
        name: 'X',
        shortDescription: '',
        systemPromptFragment: 'ORIGINAL-AT-CREATION',
        speakingStyle: '',
      },
    });
    const p = buildAgentSystemPrompt(config, a);
    expect(p).toContain('ORIGINAL-AT-CREATION');
    expect(p).not.toMatch(/Monday morning/i); // did NOT fall back to the code persona
  });
});
