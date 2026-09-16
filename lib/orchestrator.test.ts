import { describe, it, expect } from 'vitest';
import { planNextTurn } from './orchestrator';
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
