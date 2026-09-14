// Turn-sequence state machine (PRD §7.1). Pure functions over the stored
// transcript, so the next turn is derived deterministically on every call and a
// browser refresh resumes rather than restarts. Planning is server-authoritative.

import type {
  AgentConfig,
  SessionConfig,
  Turn,
  TurnType,
} from '@/lib/types';
import { countWords } from '@/lib/cost';
import type { TurnInstructionOpts } from '@/lib/prompts';

export const MODERATOR_ID = 'moderator';

const INTERJECTION_EVERY: Record<
  SessionConfig['moderator']['interjectionFrequency'],
  number
> = {
  low: 5,
  medium: 3,
  high: 2,
};

export interface TurnPlan {
  speakerId: string; // agent.id or 'moderator'
  speakerDisplayName: string;
  turnType: TurnType;
  modelId: string;
  personaId?: string;
  temperature: number;
  maxWords: number;
  agent?: AgentConfig; // present for agent turns
  instructionOpts: TurnInstructionOpts;
  /** hot-seat: whether this agent currently holds the seat. */
  holdsSeat?: boolean;
}

function accumulatedWords(turns: Turn[]): number {
  return turns.reduce((sum, t) => sum + countWords(t.text), 0);
}

/** Whether the round loop should end and closings should begin. */
function shouldBeginClosings(
  config: SessionConfig,
  turns: Turn[],
  stopRequested: boolean,
): boolean {
  if (stopRequested) return true;
  if (turns.length >= config.maxTurns) return true;

  const standardCount = turns.filter((t) => t.turnType === 'standard').length;
  const words = accumulatedWords(turns);
  const roundComplete =
    standardCount > 0 && standardCount % config.agentCount === 0;
  return words >= config.targetWordCount && roundComplete;
}

/** Plan a turn inside the round loop (agents rotate, moderator interjects). */
function planRoundTurn(config: SessionConfig, turns: Turn[]): TurnPlan {
  const roundTurns = turns.filter(
    (t) => t.turnType === 'standard' || t.turnType === 'moderator',
  );
  const standardCount = roundTurns.filter(
    (t) => t.turnType === 'standard',
  ).length;
  const interjectionsDone = roundTurns.filter(
    (t) => t.turnType === 'moderator',
  ).length;

  const every = INTERJECTION_EVERY[config.moderator.interjectionFrequency];
  const interjectionsExpected = Math.floor(standardCount / every);

  if (standardCount > 0 && interjectionsDone < interjectionsExpected) {
    return moderatorPlan(config, 'moderator', {});
  }

  const agent = config.agents[standardCount % config.agentCount];
  return agentPlan(config, agent, 'standard', {});
}

function moderatorPlan(
  config: SessionConfig,
  turnType: Extract<
    TurnType,
    'moderator-opening' | 'moderator' | 'call-closings' | 'moderator-closing'
  >,
  instructionOpts: TurnInstructionOpts,
): TurnPlan {
  return {
    speakerId: MODERATOR_ID,
    speakerDisplayName: config.moderator.displayName || 'Moderator',
    turnType,
    modelId: config.moderator.modelId,
    temperature: config.moderator.temperature,
    maxWords: 60,
    instructionOpts,
  };
}

function agentPlan(
  config: SessionConfig,
  agent: AgentConfig,
  turnType: Extract<TurnType, 'opening' | 'standard' | 'closing'>,
  instructionOpts: TurnInstructionOpts,
): TurnPlan {
  // hot-seat: the seat holder rotates once at the midpoint.
  const holdsSeat =
    config.format === 'hot-seat' ? isSeatHolder(config, agent) : undefined;
  return {
    speakerId: agent.id,
    speakerDisplayName: agent.displayName,
    turnType,
    modelId: agent.modelId,
    personaId: agent.personaId,
    temperature: agent.temperature,
    maxWords: agent.maxWordsPerTurn,
    agent,
    instructionOpts,
    holdsSeat,
  };
}

// Simple hot-seat helper: first agent holds the seat in the first half, second
// agent in the second half. (Full rotation logic can refine this later.)
function isSeatHolder(config: SessionConfig, agent: AgentConfig): boolean {
  return agent.id === config.agents[0].id;
}

/**
 * Compute the next turn to execute, or null if the session is complete.
 */
export function planNextTurn(
  config: SessionConfig,
  turns: Turn[],
  opts: { stopRequested?: boolean } = {},
): TurnPlan | null {
  const N = config.agentCount;

  // 1. Moderator opening.
  if (turns.length === 0) {
    return moderatorPlan(config, 'moderator-opening', {
      moderatorOpening: true,
    });
  }

  // 2. Agent openings, in order.
  const openingsDone = turns.filter((t) => t.turnType === 'opening').length;
  if (openingsDone < N) {
    return agentPlan(config, config.agents[openingsDone], 'opening', {});
  }

  const callClosingsDone = turns.some((t) => t.turnType === 'call-closings');

  // 3. Round loop (until stop conditions), else 4. moderator calls closings.
  if (!callClosingsDone) {
    if (shouldBeginClosings(config, turns, opts.stopRequested ?? false)) {
      return moderatorPlan(config, 'call-closings', {
        moderatorCallClosings: true,
      });
    }
    return planRoundTurn(config, turns);
  }

  // 5. Agent closing statements, in order.
  const closingsDone = turns.filter((t) => t.turnType === 'closing').length;
  if (closingsDone < N) {
    return agentPlan(config, config.agents[closingsDone], 'closing', {});
  }

  // 6. Moderator closing (declines a winner).
  const moderatorClosingDone = turns.some(
    (t) => t.turnType === 'moderator-closing',
  );
  if (!moderatorClosingDone) {
    return moderatorPlan(config, 'moderator-closing', {
      moderatorClosing: true,
    });
  }

  // Complete.
  return null;
}

/** For the live view: has the session reached its natural end? */
export function isSessionComplete(config: SessionConfig, turns: Turn[]): boolean {
  return planNextTurn(config, turns, {}) === null;
}
