import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildPlan,
  plannedTurnCount,
  nextSlotIndex,
  closingsStart,
  rotate,
  presentationMissingCandidate,
  rebuttalMissingRivals,
  moderatorIssues,
  agentAliases,
  moderatorSlotInstruction,
} from './structured-rounds';
import { planNextTurn } from './orchestrator';
import type { AgentConfig, SessionConfig, Turn } from './types';

const ag = (id: string, name: string, candidate: string): AgentConfig => ({
  id,
  displayName: name,
  personaId: 'pragmatist',
  modelId: 'claude-haiku-4-5',
  temperature: 0.8,
  maxWordsPerTurn: 160,
  stance: `Advocate for ${candidate}`,
  candidate,
});
const AGENTS = [
  ag('a', 'Lara', 'London'),
  ag('b', 'Tony', 'Tokyo'),
  ag('c', 'Kimi', 'Berlin'),
  ag('d', 'Ada', 'Bogotá'),
];
const rounds = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Theme ${i + 1}` }));

function cfg(over: Partial<SessionConfig['structuredRounds']> = {}, roundsN = 2): SessionConfig {
  const sr = {
    rounds: rounds(roundsN),
    presentationWords: 450,
    rebuttalWords: 300,
    speakerIntros: true,
    advocateClosings: false,
    closingWords: 150,
    baseOrder: AGENTS.map((a) => a.id),
    ...over,
  };
  return {
    id: 's',
    title: 'T',
    topic: 'Which city has the best public transport?',
    format: 'structured-rounds',
    domain: 'test',
    agentCount: 4,
    agents: AGENTS,
    moderator: { displayName: 'Moderator', modelId: 'claude-haiku-4-5', interjectionFrequency: 'high', temperature: 0.7 },
    targetWordCount: 2600,
    maxTurns: 24,
    openingBanter: true, // must be ignored
    interjectionRate: 'high', // must be ignored
    structuredRounds: { ...sr, plan: buildPlan(sr) },
    createdAt: '',
  };
}

describe('B4 plan — formula, order, invariants', () => {
  it('3 rounds × 4 advocates with speaker intros = 56 slots (formula as written)', () => {
    const plan = buildPlan({ rounds: rounds(3), speakerIntros: true, advocateClosings: false, baseOrder: ['a', 'b', 'c', 'd'] });
    expect(plan.length).toBe(56);
    expect(plannedTurnCount(3, 4, true, false)).toBe(56);
  });

  it('the B-2 test config (4 advocates, 2 rounds, intros on) = 38 slots', () => {
    expect(cfg().structuredRounds!.plan!.length).toBe(38);
  });

  it('closed-form count equals the built plan for every combination', () => {
    for (let n = 3; n <= 6; n++)
      for (let r = 1; r <= 8; r++)
        for (const intros of [true, false])
          for (const closings of [true, false]) {
            const base = Array.from({ length: n }, (_, i) => `x${i}`);
            const plan = buildPlan({ rounds: rounds(r), speakerIntros: intros, advocateClosings: closings, baseOrder: base });
            expect(plan.length).toBe(plannedTurnCount(r, n, intros, closings));
          }
  });

  it('presentation order rotates per round; rebuttal order is its reverse', () => {
    const plan = cfg({}, 3).structuredRounds!.plan!;
    for (let r = 0; r < 3; r++) {
      const P = plan.filter((s) => s.kind === 'PRESENTATION' && s.round === r).map((s) => s.speakerId);
      const R = plan.filter((s) => s.kind === 'REBUTTAL' && s.round === r).map((s) => s.speakerId);
      expect(P).toEqual(rotate(['a', 'b', 'c', 'd'], r));
      expect(R).toEqual([...P].reverse());
    }
  });

  it('never two consecutive turns by the same agent, in any configuration', () => {
    for (let n = 3; n <= 6; n++)
      for (let r = 1; r <= 8; r++)
        for (const intros of [true, false])
          for (const closings of [true, false]) {
            const base = Array.from({ length: n }, (_, i) => `x${i}`);
            const plan = buildPlan({ rounds: rounds(r), speakerIntros: intros, advocateClosings: closings, baseOrder: base });
            for (let i = 1; i < plan.length; i++) {
              const same = plan[i].speakerId === plan[i - 1].speakerId && plan[i].speakerId !== 'moderator';
              expect(same).toBe(false);
            }
          }
  });

  it('every advocate presents and rebuts exactly once per round (equal airtime)', () => {
    const plan = cfg({}, 3).structuredRounds!.plan!;
    for (const a of AGENTS) {
      expect(plan.filter((s) => s.kind === 'PRESENTATION' && s.speakerId === a.id)).toHaveLength(3);
      expect(plan.filter((s) => s.kind === 'REBUTTAL' && s.speakerId === a.id)).toHaveLength(3);
    }
  });
});

describe('B4 execution — resume, retry, stop', () => {
  const plan = cfg().structuredRounds!.plan!;
  const done = (n: number) => Array.from({ length: n }, (_, i) => ({ planSlot: i }));

  it('starts at 0, continues after the highest delivered slot, ends with null', () => {
    expect(nextSlotIndex(plan, [])).toBe(0);
    expect(nextSlotIndex(plan, done(5))).toBe(5);
    expect(nextSlotIndex(plan, done(plan.length))).toBeNull();
  });

  it('a failed turn persists nothing, so the retry fills the same slot', () => {
    expect(nextSlotIndex(plan, done(7))).toBe(7);
    expect(nextSlotIndex(plan, done(7))).toBe(7); // retry: still 7
  });

  it('stop & close skips ahead to the closings section', () => {
    expect(nextSlotIndex(plan, done(3), true)).toBe(closingsStart(plan));
    expect(plan[closingsStart(plan)].kind).toBe('CLOSE');
  });
});

describe('B5 engine-level switches — planner ignores routing, banter and interjections', () => {
  afterEach(() => vi.restoreAllMocks());
  const turn = (i: number, speakerId: string, text: string, planSlot: number): Turn => ({
    index: i, speakerId, speakerDisplayName: speakerId, turnType: 'round-intro', turnClass: 'full',
    text, modelId: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0,
    wasEdited: false, isStale: false, wasTruncated: false, planSlot, createdAt: '',
  });

  it('first slot is the OPENING, not banter (banter on in config)', () => {
    const p = planNextTurn(cfg(), [])!;
    expect(p.turnType).toBe('moderator-opening');
    expect(p.planSlot).toBe(0);
  });

  it('ignores a speaker named in moderator text and never rolls an interjection', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // would force an interjection elsewhere
    const c = cfg();
    const plan = c.structuredRounds!.plan!;
    // Deliver slots 0..2; slot 2 is moderator text that names Ada (not the next planned speaker).
    const turns = [0, 1, 2].map((i) =>
      turn(i, plan[i].speakerId, i === 2 ? 'Ada, you go first.' : 'x', i),
    );
    const p = planNextTurn(c, turns)!;
    expect(p.planSlot).toBe(3);
    expect(p.speakerId).toBe(plan[3].speakerId);
    expect(p.turnClass).toBe('full');
  });
});

describe('B8 validators', () => {
  const c = cfg();
  const [lara, tony] = AGENTS;

  it('presentation must name the own candidate', () => {
    expect(presentationMissingCandidate('London has the Tube and Overground.', lara)).toBe(false);
    expect(presentationMissingCandidate('My city has a great metro.', lara)).toBe(true);
  });

  it('rebuttal must reference every rival by advocate name or candidate alias', () => {
    expect(rebuttalMissingRivals('Tony, Tokyo is pricey. Kimi oversold Berlin. Bogotá floods.', lara, c)).toEqual([]);
    const missing = rebuttalMissingRivals('Tony is wrong about Tokyo.', lara, c).map((a) => a.displayName);
    expect(missing).toEqual(['Kimi', 'Ada']);
  });

  it('matches accented names (JS \\b is ASCII-only — regression)', () => {
    expect(rebuttalMissingRivals('Bogotá floods. São Paulo too.', lara, { ...c, agents: [lara, { ...AGENTS[3] }] })).toEqual([]);
  });

  it('candidate surnames count as aliases', () => {
    const a = { ...tony, candidate: 'Bola Tinubu' };
    expect(agentAliases(a)).toEqual(['Tony', 'Bola Tinubu', 'Tinubu']);
  });

  it('moderator: flags a question to an advocate, a wrong order, and a wrong intro', () => {
    const intro = c.structuredRounds!.plan![1]; // ROUND_INTRO r0, order Lara, Tony, Kimi, Ada
    expect(moderatorIssues('Round one: transport. Lara, Tony, Kimi, then Ada present.', intro, c)).toEqual([]);
    expect(moderatorIssues('Round one. Tony, Lara, Kimi and Ada.', intro, c).join()).toMatch(/order/);
    expect(moderatorIssues('Lara, are you ready to begin?', intro, c).join()).toMatch(/question/);
    // Restating the topic names candidates, not advocates — not a question to anyone.
    const opening = c.structuredRounds!.plan![0];
    expect(moderatorIssues('Our topic: which city has the best transport — London, Tokyo, Berlin or Bogotá?', opening, c)).toEqual([]);
    const sIntro = c.structuredRounds!.plan![2]; // SPEAKER_INTRO for Lara
    expect(moderatorIssues('Lara presents for London.', sIntro, c)).toEqual([]);
    expect(moderatorIssues('Tony presents for Tokyo.', sIntro, c).join()).toMatch(/did not introduce Lara/);
  });
});

describe('B7 moderator slot prompts — hand-offs and length', () => {
  it('with speaker intros on, only the speaker intro hands over the floor', () => {
    const c = cfg();
    const plan = c.structuredRounds!.plan!;
    for (const kind of ['OPENING', 'ROUND_INTRO', 'PHASE_SWITCH'] as const) {
      const slot = plan.find((s) => s.kind === kind)!;
      expect(moderatorSlotInstruction(c, slot)).toMatch(/Do not hand the floor/);
    }
    const intro = plan.find((s) => s.kind === 'SPEAKER_INTRO')!;
    expect(moderatorSlotInstruction(c, intro)).not.toMatch(/Do not hand the floor/);
  });

  it('with speaker intros off, the round intro may hand over (no one else will)', () => {
    const c = cfg({ speakerIntros: false });
    const slot = c.structuredRounds!.plan!.find((s) => s.kind === 'ROUND_INTRO')!;
    expect(moderatorSlotInstruction(c, slot)).not.toMatch(/Do not hand the floor/);
  });

  it('opening and close carry their word limit', () => {
    const c = cfg();
    const plan = c.structuredRounds!.plan!;
    expect(moderatorSlotInstruction(c, plan[0])).toMatch(/under 150 words/);
    expect(moderatorSlotInstruction(c, plan[plan.length - 1])).toMatch(/under 150 words/);
  });
});
