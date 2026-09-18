import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planNextTurn,
  estimateEligibleSlots,
  interjectionProbability,
} from './orchestrator';
import type { AgentConfig, SessionConfig, Turn } from './types';

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
  targetWordCount: 2600,
  maxTurns: 30,
  openingBanter: false, // isolate round-loop routing
  interjectionRate: 'off', // no random interjection roll in these tests
  createdAt: '',
};

let n = 0;
function turn(speakerId: string, name: string, turnType: Turn['turnType'], text: string): Turn {
  return {
    index: n++,
    speakerId,
    speakerDisplayName: name,
    turnType,
    turnClass: 'full',
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
  };
}

function baseTurns(): Turn[] {
  n = 0;
  return [
    turn('moderator', 'Moderator', 'moderator-opening', 'Welcome to the panel.'),
    turn('a1', 'Lara', 'opening', 'Short opening.'),
    turn('a2', 'Kimi', 'opening', 'Short opening.'),
    turn('a3', 'Tony', 'opening', 'Short opening.'),
    turn('a1', 'Lara', 'standard', 'Short reply.'),
  ];
}

describe('moderator-directed routing', () => {
  it('routes the next turn to the named participant, overriding rotation', () => {
    const turns = baseTurns();
    // Rotation would pick Kimi next anyway; name Tony to prove the override.
    turns.push(
      turn('moderator', 'Moderator', 'moderator', 'Tony, what is your evidence for that?'),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.speakerId).toBe('a3'); // Tony, not the rotation pick
    expect(plan.instructionOpts.moderatorDirected).toBe(true);
  });

  it('honours a direct address even when another name is mentioned second', () => {
    const turns = baseTurns();
    turns.push(
      turn(
        'moderator',
        'Moderator',
        'moderator',
        "Kimi, respond to Lara's point about scaffolding costs.",
      ),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.speakerId).toBe('a2'); // Kimi (addressed), not Lara (referenced)
    expect(plan.instructionOpts.moderatorDirected).toBe(true);
  });

  it('routes to the addressee, not the name in a possessive (addressee first)', () => {
    const turns = baseTurns();
    turns.push(
      turn(
        'moderator',
        'Moderator',
        'moderator',
        "Kimi, give me the strongest version of Tony's side.",
      ),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.speakerId).toBe('a2'); // Kimi (addressed), not Tony (possessive)
    expect(plan.instructionOpts.moderatorDirected).toBe(true);
  });

  it('routes to the last address when a prior speaker is referenced first (B-5.5 regression)', () => {
    const turns = baseTurns();
    // Moderator back-references Tony, then directs the steelman to Kimi.
    turns.push(
      turn(
        'moderator',
        'Moderator',
        'moderator',
        "Tony, you've made a moral claim about sufficiency. Kimi, give me the strongest version of Tony's side — the case that hitting the target still isn't enough.",
      ),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.speakerId).toBe('a2'); // Kimi (the directive), not Tony (referenced first + possessive)
    expect(plan.instructionOpts.moderatorDirected).toBe(true);
  });

  it('honours a stated closing order from the call-closings turn', () => {
    const turns = baseTurns();
    turns.push(
      turn(
        'moderator',
        'Moderator',
        'call-closings',
        'Tony, Lara, Kimi — a closing thought each, in that order.',
      ),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.turnType).toBe('closing');
    expect(plan.speakerId).toBe('a3'); // Tony first, per the stated order
  });

  it('falls back to config order when the call-closings names no full sequence', () => {
    const turns = baseTurns();
    turns.push(
      turn('moderator', 'Moderator', 'call-closings', 'Let us hear closing thoughts.'),
    );
    const plan = planNextTurn(config, turns, {})!;
    expect(plan.turnType).toBe('closing');
    expect(plan.speakerId).toBe('a1'); // Lara — config order
  });

  it('falls back to rotation when the moderator names no one', () => {
    const turns = baseTurns();
    turns.push(
      turn('moderator', 'Moderator', 'moderator', 'Let us get concrete with a number.'),
    );
    const plan = planNextTurn(config, turns, {})!;
    // standardCount = 1 -> rotation pick is agents[1 % 3] = Kimi
    expect(plan.speakerId).toBe('a2');
    expect(plan.instructionOpts.moderatorDirected).toBeFalsy();
  });
});

describe('interjection count-targeting (B-6)', () => {
  afterEach(() => vi.restoreAllMocks());
  const medium = { ...config, interjectionRate: 'medium' as const };

  it('estimates more eligible slots for a longer episode', () => {
    const short = estimateEligibleSlots({ ...medium, targetWordCount: 1200 });
    const long = estimateEligibleSlots({ ...medium, targetWordCount: 2600 });
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(medium.agentCount);
  });

  it('probability is 0 when off, and 0 once the target is met', () => {
    expect(interjectionProbability({ ...config, interjectionRate: 'off' }, [])).toBe(0);
    // Fabricate enough stored interjections to meet the medium target (5).
    const done = Array.from({ length: 5 }, () =>
      turn('a1', 'Lara', 'standard', 'react'),
    ).map((t) => ({ ...t, turnClass: 'interjection' as const }));
    expect(interjectionProbability(medium, done)).toBe(0);
  });

  it('probability rises as the round fills up (self-correcting on word progress)', () => {
    const words = Array.from({ length: 100 }, () => 'word').join(' ');
    const early = interjectionProbability(medium, baseTurns()); // little said yet
    // Many word-bearing standard turns → close to the round target → catch up.
    const many = [
      ...baseTurns(),
      ...Array.from({ length: 12 }, () => turn('a1', 'Lara', 'standard', words)),
    ];
    expect(interjectionProbability(medium, many)).toBeGreaterThan(early);
  });

  it('an interjection can follow an OPENING turn (openings now eligible)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // force the roll + pick
    const turns = [
      turn('moderator', 'Moderator', 'moderator-opening', 'Welcome.'),
      turn('a1', 'Lara', 'opening', 'My opening position.'),
    ];
    const plan = planNextTurn(medium, turns, {})!;
    expect(plan.turnClass).toBe('interjection');
    expect(plan.speakerId).not.toBe('a1'); // reactor is not the last speaker
  });

  it('does not interject during the completion re-plan (suppressed)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const turns = [
      turn('moderator', 'Moderator', 'moderator-opening', 'Welcome.'),
      turn('a1', 'Lara', 'opening', 'My opening position.'),
    ];
    const plan = planNextTurn(medium, turns, { suppressInterjection: true })!;
    expect(plan.turnClass).not.toBe('interjection');
  });
});
