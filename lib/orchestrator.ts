// Turn-sequence state machine (PRD §7.1). Pure functions over the stored
// transcript, so the next turn is derived deterministically on every call and a
// browser refresh resumes rather than restarts. Planning is server-authoritative.

import type {
  AgentConfig,
  InterjectionRate,
  SessionConfig,
  Turn,
  TurnClass,
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

// Probability of inserting an agent reaction interjection after a full turn (A-1).
const INTERJECTION_PROBABILITY: Record<InterjectionRate, number> = {
  off: 0,
  low: 0.25,
  medium: 0.5, // ~1 interjection per 2 full turns
  high: 0.75,
};

export interface TurnPlan {
  speakerId: string; // agent.id or 'moderator'
  speakerDisplayName: string;
  turnType: TurnType;
  turnClass: TurnClass;
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
  // maxTurns counts substantive (full) turns, not reaction interjections.
  const fullTurnCount = turns.filter((t) => t.turnClass !== 'interjection').length;
  if (fullTurnCount >= config.maxTurns) return true;

  const standardCount = turns.filter(
    (t) => t.turnType === 'standard' && t.turnClass !== 'interjection',
  ).length;
  const words = accumulatedWords(turns);
  const roundComplete =
    standardCount > 0 && standardCount % config.agentCount === 0;

  // Reserve room for the closing round (N agent closings + moderator bookends)
  // so the *total* transcript lands near targetWordCount, not target + closings.
  const avgMaxWords =
    config.agents.reduce((s, a) => s + a.maxWordsPerTurn, 0) /
    config.agentCount;
  const reservedForClosings = config.agentCount * avgMaxWords + 90;
  const roundTarget = Math.max(
    config.targetWordCount * 0.55,
    config.targetWordCount - reservedForClosings,
  );

  return words >= roundTarget && roundComplete;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * If a moderator interjection names a participant, that participant must answer
 * next — overriding rotation.
 *
 * Prefer a direct address (name at the start, or "Name," / "Name?" / "Name:").
 * When several names are addressed, the LAST wins: moderators routinely
 * reference a prior speaker before directing the next one ("Otis, you made a
 * claim… Gretchen, steelman it"), and the operative instruction comes last.
 * Possessive forms ("Otis's side") are objects, not addressees, and are ignored
 * entirely. Falls back to the first plainly-mentioned name.
 */
function findDirectedAgent(config: SessionConfig, text: string) {
  let addressed: { agent: AgentConfig; idx: number } | null = null; // last address
  let mentioned: { agent: AgentConfig; idx: number } | null = null; // first mention
  for (const agent of config.agents) {
    const n = escapeRegex(agent.displayName);
    const re = new RegExp(`\\b${n}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      const after = text.slice(idx + agent.displayName.length);
      // Possessive ("Otis's" / "Otis'") — a referenced object, never the speaker.
      if (/^['’]s?\b/.test(after)) continue;
      const before = text.slice(0, idx);
      const atLineStart = /(^|\n)\s*$/.test(before);
      const addrPunct = /^\s*[,?:]/.test(after);
      if (atLineStart || addrPunct) {
        if (addressed === null || idx > addressed.idx) addressed = { agent, idx };
      } else if (mentioned === null || idx < mentioned.idx) {
        mentioned = { agent, idx };
      }
    }
  }
  return (addressed ?? mentioned)?.agent ?? null;
}

/** Plan a turn inside the round loop (agents rotate, moderator interjects). */
function planRoundTurn(
  config: SessionConfig,
  turns: Turn[],
  suppressInterjection = false,
): TurnPlan {
  const last = turns[turns.length - 1];

  // A moderator interjection that named someone directs the next turn to them.
  if (last && last.turnType === 'moderator') {
    const directed = findDirectedAgent(config, last.text);
    if (directed) {
      return agentPlan(config, directed, 'standard', { moderatorDirected: true });
    }
  }

  // Rotation and moderator cadence count full (non-interjection) turns only.
  const fullStandardCount = turns.filter(
    (t) => t.turnType === 'standard' && t.turnClass !== 'interjection',
  ).length;
  const nextFullAgent = config.agents[fullStandardCount % config.agentCount];

  // Agent reaction interjection (A-1): roll after a full agent turn (not after a
  // moderator turn or another interjection). On [SKIP] the route falls through
  // to the next full turn, so we never chain or loop.
  const rate = config.interjectionRate ?? 'medium';
  if (
    !suppressInterjection &&
    last &&
    last.turnClass !== 'interjection' &&
    (last.turnType === 'standard' || last.turnType === 'opening') &&
    Math.random() < INTERJECTION_PROBABILITY[rate]
  ) {
    const reactor = pickInterjector(config, last.speakerId, nextFullAgent.id);
    if (reactor) {
      return agentPlan(
        config,
        reactor,
        'standard',
        { interjection: true },
        { turnClass: 'interjection', maxWords: 15 },
      );
    }
  }

  // Moderator interjection when due (counts full standard turns).
  const interjectionsDone = turns.filter(
    (t) => t.turnType === 'moderator',
  ).length;
  const every = INTERJECTION_EVERY[config.moderator.interjectionFrequency];
  const interjectionsExpected = Math.floor(fullStandardCount / every);
  if (fullStandardCount > 0 && interjectionsDone < interjectionsExpected) {
    return moderatorPlan(config, 'moderator', {});
  }

  return agentPlan(config, nextFullAgent, 'standard', {});
}

function moderatorPlan(
  config: SessionConfig,
  turnType: Extract<
    TurnType,
    | 'moderator-banter'
    | 'moderator-opening'
    | 'moderator'
    | 'call-closings'
    | 'moderator-closing'
  >,
  instructionOpts: TurnInstructionOpts,
): TurnPlan {
  return {
    speakerId: MODERATOR_ID,
    speakerDisplayName: config.moderator.displayName || 'Moderator',
    turnType,
    turnClass: 'full',
    modelId: config.moderator.modelId,
    temperature: config.moderator.temperature,
    maxWords: 60,
    instructionOpts,
  };
}

function agentPlan(
  config: SessionConfig,
  agent: AgentConfig,
  turnType: Extract<TurnType, 'banter' | 'opening' | 'standard' | 'closing'>,
  instructionOpts: TurnInstructionOpts,
  overrides: { turnClass?: TurnClass; maxWords?: number } = {},
): TurnPlan {
  // hot-seat: the seat holder rotates once at the midpoint.
  const holdsSeat =
    config.format === 'hot-seat' ? isSeatHolder(config, agent) : undefined;
  return {
    speakerId: agent.id,
    speakerDisplayName: agent.displayName,
    turnType,
    turnClass: overrides.turnClass ?? 'full',
    modelId: agent.modelId,
    personaId: agent.personaId,
    temperature: agent.temperature,
    maxWords: overrides.maxWords ?? agent.maxWordsPerTurn,
    agent,
    instructionOpts,
    holdsSeat,
  };
}

/** Pick a reacting agent for an interjection: not the last speaker, not the
 *  next full speaker. Returns null if there's no suitable third party. */
function pickInterjector(
  config: SessionConfig,
  lastSpeakerId: string,
  nextFullSpeakerId: string,
): AgentConfig | null {
  const candidates = config.agents.filter(
    (a) => a.id !== lastSpeakerId && a.id !== nextFullSpeakerId,
  );
  const pool = candidates.length > 0
    ? candidates
    : config.agents.filter((a) => a.id !== lastSpeakerId);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
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
  opts: { stopRequested?: boolean; suppressInterjection?: boolean } = {},
): TurnPlan | null {
  const N = config.agentCount;
  const bantering = config.openingBanter !== false; // default on

  // 0. Opening banter (A-2): moderator light chat, then one reply per agent.
  if (bantering) {
    if (turns.length === 0) {
      return moderatorPlan(config, 'moderator-banter', { moderatorBanter: true });
    }
    const banterReplies = turns.filter((t) => t.turnType === 'banter').length;
    if (banterReplies < N) {
      return agentPlan(
        config,
        config.agents[banterReplies],
        'banter',
        { banter: true },
        { maxWords: 40 },
      );
    }
  }

  // 1. Moderator opening (topic introduction).
  if (!turns.some((t) => t.turnType === 'moderator-opening')) {
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
    return planRoundTurn(config, turns, opts.suppressInterjection ?? false);
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

/** Reconstruct the plan for an already-produced turn, for regeneration. */
export function planFromStoredTurn(
  config: SessionConfig,
  turn: Turn,
): TurnPlan {
  if (turn.speakerId === MODERATOR_ID) {
    const instructionOpts: TurnInstructionOpts =
      turn.turnType === 'moderator-banter'
        ? { moderatorBanter: true }
        : turn.turnType === 'moderator-opening'
          ? { moderatorOpening: true }
          : turn.turnType === 'call-closings'
            ? { moderatorCallClosings: true }
            : turn.turnType === 'moderator-closing'
              ? { moderatorClosing: true }
              : {};
    return {
      speakerId: MODERATOR_ID,
      speakerDisplayName: config.moderator.displayName || 'Moderator',
      turnType: turn.turnType,
      turnClass: 'full',
      modelId: config.moderator.modelId,
      temperature: config.moderator.temperature,
      maxWords: 60,
      instructionOpts,
    };
  }

  const agent =
    config.agents.find((a) => a.id === turn.speakerId) ?? config.agents[0];
  const isInterjection = turn.turnClass === 'interjection';
  const instructionOpts: TurnInstructionOpts = isInterjection
    ? { interjection: true }
    : turn.turnType === 'banter'
      ? { banter: true }
      : {};
  return {
    speakerId: agent.id,
    speakerDisplayName: agent.displayName,
    turnType: turn.turnType,
    turnClass: turn.turnClass,
    modelId: agent.modelId,
    personaId: agent.personaId,
    temperature: agent.temperature,
    maxWords: isInterjection ? 15 : turn.turnType === 'banter' ? 40 : agent.maxWordsPerTurn,
    agent,
    instructionOpts,
    holdsSeat:
      config.format === 'hot-seat'
        ? agent.id === config.agents[0].id
        : undefined,
  };
}
