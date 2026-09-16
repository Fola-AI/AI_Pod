import { describe, it, expect, vi, afterEach } from 'vitest';
import { planNextTurn, MODERATOR_ID } from './orchestrator';
import type { TurnPlan } from './orchestrator';
import { executeTurn } from './execute-turn';
import type {
  AgentConfig,
  GenerateResult,
  ProviderAdapter,
  SessionConfig,
  Turn,
} from './types';

function agent(id: string, name: string): AgentConfig {
  return {
    id,
    displayName: name,
    personaId: 'pragmatist',
    modelId: 'claude-haiku-4-5',
    temperature: 0.85,
    maxWordsPerTurn: 120,
  };
}

const config: SessionConfig = {
  id: 's1',
  title: 'T',
  topic: 'Topic',
  format: 'panel',
  domain: 'test',
  agentCount: 3,
  agents: [agent('a1', 'Lara'), agent('a2', 'Kimi'), agent('a3', 'Tony')],
  moderator: {
    displayName: 'Moderator',
    modelId: 'claude-haiku-4-5',
    interjectionFrequency: 'medium',
    temperature: 0.7,
  },
  targetWordCount: 900,
  maxTurns: 14,
  openingBanter: false,
  interjectionRate: 'high',
  createdAt: '',
};

function stub(text: string): ProviderAdapter {
  return {
    id: 'anthropic',
    async generate(): Promise<GenerateResult> {
      return {
        text,
        stopReason: 'complete',
        rawStopReason: 'end_turn',
        inputTokens: 5,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
}

const skipStub = stub('[SKIP]');
const fullStub = stub('This is a complete sentence, long enough to pass.');

const interjectionPlan: TurnPlan = {
  speakerId: 'a3',
  speakerDisplayName: 'Tony',
  turnType: 'standard',
  turnClass: 'interjection',
  modelId: 'claude-haiku-4-5',
  personaId: 'pragmatist',
  temperature: 0.85,
  maxWords: 15,
  agent: config.agents[2],
  instructionOpts: { interjection: true },
};

afterEach(() => vi.restoreAllMocks());

describe('interjection [SKIP] handling', () => {
  it('returns null (no turn) when an interjection responds [SKIP]', async () => {
    const result = await executeTurn(config, [], interjectionPlan, skipStub);
    expect(result).toBeNull();
  });

  it('persists a real interjection (turnClass interjection) when not skipped', async () => {
    const result = await executeTurn(config, [], interjectionPlan, fullStub);
    expect(result).not.toBeNull();
    expect(result!.turnClass).toBe('interjection');
  });

  it('never persists a skipped interjection and keeps indices contiguous', async () => {
    // Force every interjection roll to succeed so the skip path is exercised.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const turns: Turn[] = [];
    for (let i = 0; i < 60; i++) {
      let plan = planNextTurn(config, turns, {});
      if (!plan) break;

      const adapter =
        plan.turnClass === 'interjection' ? skipStub : fullStub;
      let executed = await executeTurn(config, turns, plan, adapter);

      // Skip → fall through to the next full turn (route behaviour).
      if (executed === null) {
        plan = planNextTurn(config, turns, { suppressInterjection: true });
        if (!plan) break;
        executed = await executeTurn(config, turns, plan, fullStub);
      }
      if (executed) turns.push({ ...executed, index: turns.length });
    }

    // Every interjection was [SKIP], so none was stored.
    expect(turns.filter((t) => t.turnClass === 'interjection')).toHaveLength(0);
    // Indices are 0..n-1 with no gaps or duplicates.
    expect(turns.map((t) => t.index)).toEqual(turns.map((_, i) => i));
    // The session still ran to a real end (moderator closing present).
    expect(
      turns.some(
        (t) => t.turnType === 'moderator-closing' && t.speakerId === MODERATOR_ID,
      ),
    ).toBe(true);
  });
});
