import { describe, it, expect } from 'vitest';
import { toElevenLabsScript } from './export';
import type { Session, Turn } from './types';

function turn(
  index: number,
  speakerId: string,
  name: string,
  text: string,
  taggedText?: string,
): Turn {
  return {
    index,
    speakerId,
    speakerDisplayName: name,
    turnType: 'standard',
    turnClass: 'full',
    text,
    taggedText,
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

const session: Session = {
  id: 's1',
  config: {
    id: 's1',
    title: 'Cities',
    topic: 'T',
    format: 'panel',
    domain: 'd',
    agentCount: 2,
    agents: [
      {
        id: 'a1',
        displayName: 'Lara',
        personaId: 'pragmatist',
        modelId: 'claude-haiku-4-5',
        temperature: 0.85,
        maxWordsPerTurn: 120,
        voiceId: 'voice-lara',
      },
      {
        id: 'a2',
        displayName: 'Kimi',
        personaId: 'data-hound',
        modelId: 'claude-haiku-4-5',
        temperature: 0.85,
        maxWordsPerTurn: 120,
        // no voiceId
      },
    ],
    moderator: {
      displayName: 'Moderator',
      modelId: 'claude-haiku-4-5',
      interjectionFrequency: 'medium',
      temperature: 0.7,
      voiceId: 'voice-mod',
    },
    targetWordCount: 2000,
    maxTurns: 20,
    createdAt: '',
  },
  turns: [
    turn(0, 'moderator', 'Moderator', 'Welcome.'),
    turn(1, 'a1', 'Lara', 'Cars are habit.', '[calm] Cars are habit.'),
    turn(2, 'a2', 'Kimi', 'The number is one in ten.'),
  ],
  status: 'complete',
  totalWords: 10,
  totalCostUsd: 0,
  createdAt: '',
};

describe('toElevenLabsScript', () => {
  const parsed = JSON.parse(toElevenLabsScript(session));

  it('is ordered by turn and one entry per turn', () => {
    expect(parsed.dialogue).toHaveLength(3);
    expect(parsed.dialogue.map((d: any) => d.speaker)).toEqual([
      'Moderator',
      'Lara',
      'Kimi',
    ]);
  });

  it('uses taggedText where present, plain text otherwise', () => {
    expect(parsed.dialogue[1].text).toBe('[calm] Cars are habit.');
    expect(parsed.dialogue[2].text).toBe('The number is one in ten.');
  });

  it('carries the voice id per speaker where set, null otherwise', () => {
    expect(parsed.dialogue[0].voiceId).toBe('voice-mod'); // moderator
    expect(parsed.dialogue[1].voiceId).toBe('voice-lara'); // agent with voice
    expect(parsed.dialogue[2].voiceId).toBeNull(); // agent without voice
  });

  it('notes the ElevenLabs stability requirement', () => {
    expect(parsed.note).toMatch(/Creative|Natural/);
    expect(parsed.note).toMatch(/break tags/i);
  });
});
