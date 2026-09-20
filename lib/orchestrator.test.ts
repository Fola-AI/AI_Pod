import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planNextTurn,
  estimateEligibleSlots,
  interjectionProbability,
  AGENT_TURN_TYPES,
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

describe('moderator-directed routing — dashes, colon, deferral, opening (B-7)', () => {
  // A 4-agent config so the exact failing strings (Kimi, Ada) apply.
  const cfg4: SessionConfig = {
    ...config,
    agentCount: 4,
    agents: [
      agent('a1', 'Lara'),
      agent('a2', 'Tony'),
      agent('a3', 'Kimi'),
      agent('a4', 'Ada'),
    ],
  };
  const modTurn = (text: string, type: Turn['turnType'] = 'moderator') =>
    turn('moderator', 'Moderator', type, text);

  it('matches an em-dash address ("Kimi — China…")', () => {
    const turns = [...openedTurns4(), modTurn('Kimi — China leads the world here.')];
    expect(planNextTurn(cfg4, turns, {})!.speakerId).toBe('a3');
  });
  it('matches an en-dash address', () => {
    const turns = [...openedTurns4(), modTurn('Kimi – your read on China?')];
    expect(planNextTurn(cfg4, turns, {})!.speakerId).toBe('a3');
  });
  it('matches a colon address', () => {
    const turns = [...openedTurns4(), modTurn('Kimi: take the China angle.')];
    expect(planNextTurn(cfg4, turns, {})!.speakerId).toBe('a3');
  });
  it('routes to the operative address, not a deferred one (exact failing string)', () => {
    const turns = [
      ...openedTurns4(),
      modTurn(
        'Kimi — China. Roughly half the world’s new panels went up in one country last year. If China’s installations slow down, does the global growth story stop being a story? Ada, have the figure ready after her.',
      ),
    ];
    expect(planNextTurn(cfg4, turns, {})!.speakerId).toBe('a3'); // Kimi, not Ada (deferred)
  });
  it('opening round honours a moderator-named starter (exact failing string)', () => {
    const turns = [
      modTurn(
        'Ada, start us with a number. How much solar went in last year, and how does that compare to the year before?',
        'moderator-opening',
      ),
    ];
    const plan = planNextTurn(cfg4, turns, {})!;
    expect(plan.turnType).toBe('opening');
    expect(plan.speakerId).toBe('a4'); // Ada leads, not Lara (config order)
  });
  it('opening round falls back to config order when no starter is named', () => {
    const turns = [modTurn('Let us begin. Give me your openings.', 'moderator-opening')];
    const plan = planNextTurn(cfg4, turns, {})!;
    expect(plan.turnType).toBe('opening');
    expect(plan.speakerId).toBe('a1'); // Lara — config order
  });

  function openedTurns4(): Turn[] {
    n = 0;
    return [
      turn('moderator', 'Moderator', 'moderator-opening', 'Welcome.'),
      turn('a1', 'Lara', 'opening', 'Opening.'),
      turn('a2', 'Tony', 'opening', 'Opening.'),
      turn('a3', 'Kimi', 'opening', 'Opening.'),
      turn('a4', 'Ada', 'opening', 'Opening.'),
      turn('a1', 'Lara', 'standard', 'Reply.'),
    ];
  }
});

describe('named-address routing is applied in EVERY phase (one rule)', () => {
  const cfg4: SessionConfig = {
    ...config, // openingBanter: false (base) — banter tests opt in via cfg4Banter
    agentCount: 4,
    agents: [
      agent('a1', 'Lara'),
      agent('a2', 'Tony'),
      agent('a3', 'Kimi'),
      agent('a4', 'Ada'),
    ],
  };
  const cfg4Banter: SessionConfig = { ...cfg4, openingBanter: true };
  const mod = (text: string, type: Turn['turnType']) =>
    turn('moderator', 'Moderator', type, text);

  it('BANTER: a moderator-named starter leads, even after greeting everyone (exact defect)', () => {
    n = 0;
    // The greeting lists everyone in config order, then names Ada to start — the
    // pattern that shipped Lara-first with "Moderator asked Ada first, but fine".
    const turns = [
      mod('Evening, all. Lara, Tony, Kimi, Ada — good to have you back. Ada, you first.', 'moderator-banter'),
    ];
    const plan = planNextTurn(cfg4Banter, turns, {})!;
    expect(plan.turnType).toBe('banter');
    expect(plan.speakerId).toBe('a4'); // Ada, not Lara (config order)
  });

  it('BANTER: falls back to config order when no one is named', () => {
    n = 0;
    const turns = [mod('Evening, all. Good to have you back.', 'moderator-banter')];
    const plan = planNextTurn(cfg4Banter, turns, {})!;
    expect(plan.turnType).toBe('banter');
    expect(plan.speakerId).toBe('a1'); // Lara — config order
  });

  it('OPENING: a moderator-named starter leads', () => {
    n = 0;
    const turns = [
      mod('Welcome. Ada, start us with a number.', 'moderator-opening'),
    ];
    const plan = planNextTurn(cfg4, turns, {})!;
    expect(plan.turnType).toBe('opening');
    expect(plan.speakerId).toBe('a4'); // Ada
  });

  it('STANDARD: a moderator interjection routes to the named agent', () => {
    const turns = [
      mod('Welcome.', 'moderator-opening'),
      turn('a1', 'Lara', 'opening', 'Opening.'),
      turn('a2', 'Tony', 'opening', 'Opening.'),
      turn('a3', 'Kimi', 'opening', 'Opening.'),
      turn('a4', 'Ada', 'opening', 'Opening.'),
      turn('a1', 'Lara', 'standard', 'Reply.'),
      mod('Kimi, your take?', 'moderator'),
    ];
    expect(planNextTurn(cfg4, turns, {})!.speakerId).toBe('a3'); // Kimi
  });

  it('CLOSING: a stated closing order is honoured', () => {
    const turns = [
      mod('Welcome.', 'moderator-opening'),
      turn('a1', 'Lara', 'opening', 'Opening.'),
      turn('a2', 'Tony', 'opening', 'Opening.'),
      turn('a3', 'Kimi', 'opening', 'Opening.'),
      turn('a4', 'Ada', 'opening', 'Opening.'),
      mod('Tony, Ada, Lara, Kimi — a closing thought each, in that order.', 'call-closings'),
    ];
    const plan = planNextTurn(cfg4, turns, {})!;
    expect(plan.turnType).toBe('closing');
    expect(plan.speakerId).toBe('a2'); // Tony first, per the stated order
  });

  it('GUARD: every agent turn type has routing coverage (fails if a phase is added unrouted)', () => {
    // If a new agent turn type is added to AGENT_TURN_TYPES, this typed record
    // stops compiling until a coverage entry is added, and the runtime assertion
    // fails until the set matches — forcing the new phase through the rule.
    const COVERED: Record<(typeof AGENT_TURN_TYPES)[number], true> = {
      banter: true,
      opening: true,
      standard: true,
      closing: true,
    };
    expect(Object.keys(COVERED).sort()).toEqual([...AGENT_TURN_TYPES].sort());
  });
});
