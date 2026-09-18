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

// Target number of agent reaction interjections per SESSION (A-1, B-6 fix).
// A per-slot probability collapsed to ~0-1 on short rounds; we target a count
// instead and derive an adaptive probability, so the rate holds independent of
// episode length.
const INTERJECTION_TARGET: Record<InterjectionRate, number> = {
  off: 0,
  low: 2,
  medium: 5,
  high: 9,
};

// Estimate how many turns in this session can be *followed* by an interjection
// (openings + standard turns; closings and moderator/banter turns cannot).
// Derived from the word budget so it scales with episode length.
export function estimateEligibleSlots(config: SessionConfig): number {
  const N = config.agentCount;
  const avgWords =
    config.agents.reduce((s, a) => s + a.maxWordsPerTurn, 0) / N || 120;
  const reservedForClosings = N * avgWords + 90;
  const roundTargetWords = Math.max(
    config.targetWordCount * 0.55,
    config.targetWordCount - reservedForClosings,
  );
  const openingWords = N * avgWords;
  const estStandards = Math.max(0, Math.round((roundTargetWords - openingWords) / avgWords));
  return N + estStandards; // N openings + estimated standard turns
}

// Adaptive probability that an interjection follows this eligible turn, aiming
// to hit the session target evenly. Remaining slots are estimated LIVE from word
// progress toward the round target (not a fixed slot count), so the rate
// self-corrects when turns run longer or shorter than planned and doesn't bias
// low on a run that overshoots the word budget.
export function interjectionProbability(config: SessionConfig, turns: Turn[]): number {
  const target = INTERJECTION_TARGET[config.interjectionRate ?? 'medium'];
  if (target <= 0) return 0;
  const done = turns.filter((t) => t.turnClass === 'interjection').length;
  const remainingTarget = target - done;
  if (remainingTarget <= 0) return 0;

  const N = config.agentCount;
  const avgWords =
    config.agents.reduce((s, a) => s + a.maxWordsPerTurn, 0) / N || 120;
  const reservedForClosings = N * avgWords + 90;
  const roundTargetWords = Math.max(
    config.targetWordCount * 0.55,
    config.targetWordCount - reservedForClosings,
  );
  const openingsRemaining = Math.max(
    0,
    N - turns.filter((t) => t.turnType === 'opening').length,
  );
  // Words per agent turn, using the ACTUAL average seen so far (models routinely
  // overshoot maxWordsPerTurn), so we don't over- or under-count remaining turns.
  const substantive = turns.filter(
    (t) =>
      t.turnClass !== 'interjection' &&
      (t.turnType === 'opening' || t.turnType === 'standard'),
  );
  const observedAvg = substantive.length
    ? substantive.reduce((s, t) => s + countWords(t.text), 0) / substantive.length
    : avgWords;
  const perTurn = Math.max(avgWords, observedAvg);

  // Estimate the TOTAL standard turns the round will hold, then subtract those
  // done. Only openings + standards are eligible for a following interjection,
  // but openings and short moderator interjections also consume the word budget,
  // so we fold the moderator's cadence into the per-standard word cost — without
  // this the eligible-slot count is inflated and the rate biases low.
  const modWords = 55; // typical moderator interjection length
  const modEvery = INTERJECTION_EVERY[config.moderator.interjectionFrequency];
  const wordsPerStandard = perTurn + modWords / modEvery;
  const totalStandards = Math.max(
    0,
    (roundTargetWords - N * perTurn) / wordsPerStandard,
  );
  const standardsDone = turns.filter(
    (t) => t.turnType === 'standard' && t.turnClass !== 'interjection',
  ).length;
  const remainingStandards = Math.max(0, Math.round(totalStandards - standardsDone));
  // Bias the remaining-slot estimate DOWN (models overshoot the word cap, so the
  // round holds fewer standard turns than the budget implies). Overshooting the
  // count is capped by remainingTarget above; undershooting is not — so it is
  // safe to lean toward a higher probability here.
  const remainingSlots = Math.max(1, Math.round((openingsRemaining + remainingStandards) * 0.7));
  return Math.min(0.9, remainingTarget / remainingSlots);
}

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

/**
 * The order agents should give closings in. If the moderator's call-closings
 * turn names every agent, that stated order wins (same principle as
 * moderator-directed routing); otherwise config order.
 */
function statedClosingOrder(config: SessionConfig, turns: Turn[]): AgentConfig[] {
  const call = [...turns].reverse().find((t) => t.turnType === 'call-closings');
  if (!call) return config.agents;
  const positioned = config.agents.map((agent) => {
    const n = escapeRegex(agent.displayName);
    const idx = call.text.search(new RegExp(`\\b${n}\\b`, 'i'));
    return { agent, idx };
  });
  // Only honour a stated order when every agent is named exactly.
  if (positioned.some((p) => p.idx < 0)) return config.agents;
  return positioned.sort((a, b) => a.idx - b.idx).map((p) => p.agent);
}

/** Plan a turn inside the round loop (agents rotate, moderator interjects). */
function planRoundTurn(config: SessionConfig, turns: Turn[]): TurnPlan {
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

  // (Agent reaction interjections are handled in planNextTurn, before the phase
  // logic, so openings are eligible too — see maybeAgentInterjection.)

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

// An agent reaction interjection that may follow the last turn, or null. Fires
// after any opening or standard turn (openings included — B-6 fix), at the
// adaptive count-targeting probability.
function maybeAgentInterjection(
  config: SessionConfig,
  turns: Turn[],
): TurnPlan | null {
  const last = turns[turns.length - 1];
  if (!last || last.turnClass === 'interjection') return null;
  if (last.turnType !== 'opening' && last.turnType !== 'standard') return null;
  if (Math.random() >= interjectionProbability(config, turns)) return null;

  const N = config.agentCount;
  const openingsDone = turns.filter((t) => t.turnType === 'opening').length;
  const fullStandardCount = turns.filter(
    (t) => t.turnType === 'standard' && t.turnClass !== 'interjection',
  ).length;
  const nextFullId =
    openingsDone < N
      ? config.agents[openingsDone].id
      : config.agents[fullStandardCount % N].id;
  const reactor = pickInterjector(config, last.speakerId, nextFullId);
  if (!reactor) return null;
  return agentPlan(
    config,
    reactor,
    'standard',
    { interjection: true },
    { turnClass: 'interjection', maxWords: 15 },
  );
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

  // Agent reaction interjection — may follow any opening or standard turn, so it
  // is checked here (before the openings/round phases) rather than only inside
  // the round loop. Suppressed during the completion re-plan.
  if (!(opts.suppressInterjection ?? false)) {
    const interjection = maybeAgentInterjection(config, turns);
    if (interjection) return interjection;
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

  // 5. Agent closing statements. Honour an order the moderator stated in the
  // call-closings turn ("Otis, Sol, Gretchen, Deepa — in that order"); fall back
  // to config order if the moderator named no complete sequence.
  const closingsDone = turns.filter((t) => t.turnType === 'closing').length;
  if (closingsDone < N) {
    const order = statedClosingOrder(config, turns);
    return agentPlan(config, order[closingsDone], 'closing', {});
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
