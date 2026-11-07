import { describe, it, expect, vi, afterEach } from 'vitest';
import { planNextTurn } from './orchestrator';
import type { TurnPlan } from './orchestrator';
import { executeTurn, cleanInterjection } from './execute-turn';
import { nameRegex } from './name-match';
import type {
  AgentConfig,
  GenerateParams,
  GenerateResult,
  ProviderAdapter,
  SessionConfig,
  SessionFormat,
  Turn,
} from './types';

const agent = (id: string, name: string): AgentConfig => ({
  id,
  displayName: name,
  personaId: 'pragmatist',
  modelId: 'claude-haiku-4-5',
  temperature: 0.85,
  maxWordsPerTurn: 120,
});

function cfg(over: Partial<SessionConfig> = {}): SessionConfig {
  const agents = over.agents ?? [
    agent('a1', 'Aisha'),
    agent('a2', 'John'),
    agent('a3', 'Mohammed'),
    agent('a4', 'Eniola'),
  ];
  return {
    id: 's',
    title: 'T',
    topic: 'Who is best placed to lead?',
    format: 'panel',
    domain: 'test',
    agentCount: agents.length,
    agents,
    moderator: { displayName: 'Moderator', modelId: 'claude-haiku-4-5', interjectionFrequency: 'medium', temperature: 0.7 },
    targetWordCount: 20000,
    maxTurns: 60,
    openingBanter: false,
    interjectionRate: 'off',
    createdAt: '',
    ...over,
  };
}

let n = 0;
const T = (speakerId: string, turnType: Turn['turnType'], text = 'x', turnClass: Turn['turnClass'] = 'full'): Turn => ({
  index: n++,
  speakerId,
  speakerDisplayName: speakerId,
  turnType,
  turnClass,
  text,
  modelId: 'claude-haiku-4-5',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  wasEdited: false,
  isStale: false,
  wasTruncated: false,
  createdAt: '',
});

afterEach(() => vi.restoreAllMocks());

describe('Panel never gives one agent two full turns in a row', () => {
  it('Nigeria 2027 #22→#23: a directed answer that lands on the rotation slot', () => {
    const c = cfg();
    // The real sequence (#5–#22, interjections omitted). Standard turns before
    // #23 = 7 and the moderator has spoken twice (cadence 3 → not due), so
    // rotation = 7 % 4 = 3 = Eniola, who has just answered (the bug).
    const turns: Turn[] = [
      T('moderator', 'moderator-opening', 'With me: Aisha, John, Mohammed and Eniola.'),
      ...['a2', 'a1', 'a3', 'a4'].map((id) => T(id, 'opening')),
      T('a1', 'standard'), T('a2', 'standard'), T('a3', 'standard'),
      T('moderator', 'moderator', 'Mohammed, which state, which year, and what is your source?'),
      T('a3', 'standard'), T('a1', 'standard'), T('a2', 'standard'),
      T('moderator', 'moderator', 'Eniola, what has your candidate published on security?'),
    ];
    const directed = planNextTurn(c, turns)!;
    expect(directed.speakerId).toBe('a4');
    turns.push(T('a4', 'standard'));
    const next = planNextTurn(c, turns)!;
    expect(next.speakerId === 'a4' && next.turnClass === 'full').toBe(false);
  });

  const formats: SessionFormat[] = ['panel', 'debate', 'postmortem', 'deliberation', 'shared-curiosity', 'quickfire', 'story-swap'];
  it('holds across formats, panel sizes and random moderator addresses (simulation)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    vi.spyOn(Math, 'random').mockImplementation(rand);
    for (const format of formats)
      for (let size = 2; size <= 6; size++)
        for (let run = 0; run < 15; run++) {
          const agents = Array.from({ length: size }, (_, i) => agent(`a${i}`, ['Aisha', 'John', 'Zoë', 'Ọlá', 'Eniola', 'Bogdán'][i]));
          const c = cfg({ format, agents, interjectionRate: 'high', openingBanter: run % 2 === 0, stances: undefined } as Partial<SessionConfig>);
          const turns: Turn[] = [];
          for (let i = 0; i < 80; i++) {
            const plan = planNextTurn(c, turns);
            if (!plan) break;
            // The moderator often names a random participant, as real moderators do.
            const who = agents[Math.floor(rand() * size)].displayName;
            const text = plan.speakerId === 'moderator' && rand() < 0.7 ? `${who}, over to you?` : 'A complete sentence.';
            turns.push(T(plan.speakerId, plan.turnType, text, plan.turnClass));
          }
          const full = turns.filter((t) => t.turnClass !== 'interjection');
          for (let i = 1; i < full.length; i++) {
            const same = full[i].speakerId !== 'moderator' && full[i].speakerId === full[i - 1].speakerId;
            if (same) throw new Error(`${format} size ${size}: ${full[i].speakerId} twice at ${i}`);
          }
        }
  });
});

describe('Unicode names in moderator routing (ASCII \\b fix)', () => {
  it('routes to a participant whose name ends in an accented letter', () => {
    const c = cfg({ agents: [agent('a1', 'Aisha'), agent('a2', 'Zoë'), agent('a3', 'Ọlá')] });
    const base: Turn[] = [
      T('moderator', 'moderator-opening'),
      T('a1', 'opening'), T('a2', 'opening'), T('a3', 'opening'),
      T('a1', 'standard'),
    ];
    expect(planNextTurn(c, [...base, T('moderator', 'moderator', 'Zoë, is that right?')])!.speakerId).toBe('a2');
    expect(planNextTurn(c, [...base, T('moderator', 'moderator', 'Ọlá — your view?')])!.speakerId).toBe('a3');
  });

  it('opening order honours an accented starter', () => {
    const c = cfg({ agents: [agent('a1', 'Aisha'), agent('a2', 'Zoë'), agent('a3', 'Ọlá')] });
    const p = planNextTurn(c, [T('moderator', 'moderator-opening', 'Welcome. Zoë, you open for us.')])!;
    expect(p.speakerId).toBe('a2');
  });

  it('matches whole names only', () => {
    expect(nameRegex('Zoë').test('Zoë, go ahead')).toBe(true);
    expect(nameRegex('Zoë').test('Zoëy spoke')).toBe(false);
    expect(nameRegex('Ada').test('Adaeze spoke')).toBe(false);
    expect(nameRegex('John').test('JOHN?')).toBe(true);
  });
});

describe('Interjections never store a cut-off fragment', () => {
  it('cleanInterjection: fragment → skip; whole sentences kept; short asides kept', () => {
    expect(cleanInterjection('Aisha, measurable revenue is not', true)).toBe('');
    expect(cleanInterjection('Hold on. That figure is from 2019 and the', true)).toBe('Hold on.');
    expect(cleanInterjection('Wait, say that again', false)).toBe('Wait, say that again');
    const long = 'That is simply not true. ' + 'And the rest of this runs on and on with far too many words for an aside that should be short '.repeat(2);
    expect(cleanInterjection(long, false)).toBe('That is simply not true.');
  });

  const plan: TurnPlan = {
    speakerId: 'a2', speakerDisplayName: 'John', turnType: 'standard', turnClass: 'interjection',
    modelId: 'claude-haiku-4-5', personaId: 'pragmatist', temperature: 0.85, maxWords: 15,
    agent: agent('a2', 'John'), instructionOpts: { interjection: true },
  };
  const stub = (text: string, stopReason: GenerateResult['stopReason'], seen: GenerateParams[] = []): ProviderAdapter => ({
    id: 'anthropic',
    async generate(p: GenerateParams): Promise<GenerateResult> {
      seen.push(p);
      return { text, stopReason, rawStopReason: String(stopReason), inputTokens: 5, outputTokens: 5, latencyMs: 1 };
    },
  });

  it('a reaction cut off mid-sentence is not persisted (falls through like [SKIP])', async () => {
    const out = await executeTurn(cfg(), [], plan, stub('Aisha, measurable revenue is not', 'max_tokens'));
    expect(out).toBeNull();
  });

  it('a cut-off reaction with a whole first sentence keeps only that sentence, flagged', async () => {
    const out = await executeTurn(cfg(), [], plan, stub('Not quite. The ledger shows', 'max_tokens'));
    expect(out!.text).toBe('Not quite.');
    expect(out!.wasTruncated).toBe(true);
  });

  it('gives reasoning models headroom (no 100-token cap)', async () => {
    const seen: GenerateParams[] = [];
    await executeTurn(cfg(), [], plan, stub('Exactly.', 'complete', seen));
    expect(seen[0].maxTokens).toBeGreaterThanOrEqual(1000);
  });
});
