// Structured Rounds (Batch B). The engine, not the models, controls who speaks,
// when, and on what: the full turn plan is computed when the session is created,
// persisted with it, and executed slot by slot. Pure functions — no I/O.

import { nameRegex } from '@/lib/name-match';
import type {
  AgentConfig,
  PlanSlot,
  PlanSlotKind,
  SessionConfig,
  StructuredRoundsConfig,
  Turn,
  TurnType,
} from '@/lib/types';

const MODERATOR = 'moderator';

export const SR_MIN_ROUNDS = 1;
export const SR_MAX_ROUNDS = 8;
export const SR_DEFAULTS = {
  presentationWords: 450,
  rebuttalWords: 300,
  speakerIntros: true,
  advocateClosings: false,
  closingWords: 150,
};

/** Shift `order` left by `r` places (B4's rotate). */
export function rotate<T>(order: T[], r: number): T[] {
  const n = order.length;
  if (n === 0) return [];
  const k = ((r % n) + n) % n;
  return [...order.slice(k), ...order.slice(0, k)];
}

type PlanInput = Pick<
  StructuredRoundsConfig,
  'rounds' | 'speakerIntros' | 'advocateClosings' | 'baseOrder'
>;

/**
 * Build the full turn plan, exactly per B4:
 *   OPENING; per round r: ROUND_INTRO, then for a in P=rotate(base,r):
 *   [SPEAKER_INTRO] PRESENTATION; PHASE_SWITCH; for a in R=reverse(P):
 *   [SPEAKER_INTRO] REBUTTAL; then optional CLOSINGS_INTRO + per agent in
 *   rotate(base, rounds.length): [SPEAKER_INTRO] CLOSING; then CLOSE.
 */
export function buildPlan(sr: PlanInput): PlanSlot[] {
  const plan: PlanSlot[] = [{ kind: 'OPENING', speakerId: MODERATOR }];
  sr.rounds.forEach((_, r) => {
    const P = rotate(sr.baseOrder, r);
    const R = [...P].reverse(); // first presenter gets the last word
    plan.push({ kind: 'ROUND_INTRO', speakerId: MODERATOR, round: r, phase: 'presentation', order: P });
    for (const a of P) {
      if (sr.speakerIntros) {
        plan.push({ kind: 'SPEAKER_INTRO', speakerId: MODERATOR, round: r, phase: 'presentation', order: P, introFor: a });
      }
      plan.push({ kind: 'PRESENTATION', speakerId: a, round: r, phase: 'presentation', order: P });
    }
    plan.push({ kind: 'PHASE_SWITCH', speakerId: MODERATOR, round: r, phase: 'rebuttal', order: R });
    for (const a of R) {
      if (sr.speakerIntros) {
        plan.push({ kind: 'SPEAKER_INTRO', speakerId: MODERATOR, round: r, phase: 'rebuttal', order: R, introFor: a });
      }
      plan.push({ kind: 'REBUTTAL', speakerId: a, round: r, phase: 'rebuttal', order: R });
    }
  });
  if (sr.advocateClosings) {
    const C = rotate(sr.baseOrder, sr.rounds.length);
    plan.push({ kind: 'CLOSINGS_INTRO', speakerId: MODERATOR, phase: 'closing', order: C });
    for (const a of C) {
      if (sr.speakerIntros) {
        plan.push({ kind: 'SPEAKER_INTRO', speakerId: MODERATOR, phase: 'closing', order: C, introFor: a });
      }
      plan.push({ kind: 'CLOSING', speakerId: a, phase: 'closing', order: C });
    }
  }
  plan.push({ kind: 'CLOSE', speakerId: MODERATOR });
  return plan;
}

/** Closed-form turn count — must equal buildPlan().length (checked in tests). */
export function plannedTurnCount(
  rounds: number,
  advocates: number,
  speakerIntros: boolean,
  advocateClosings: boolean,
): number {
  const perAgent = speakerIntros ? 2 : 1;
  const perRound = 2 + 2 * advocates * perAgent;
  const closings = advocateClosings ? 1 + advocates * perAgent : 0;
  return 2 + rounds * perRound + closings;
}

/** Drafting target (words) for a slot. Agent targets come from the config. */
export function slotTargetWords(slot: PlanSlot, sr: StructuredRoundsConfig): number {
  switch (slot.kind) {
    case 'PRESENTATION':
      return sr.presentationWords;
    case 'REBUTTAL':
      return sr.rebuttalWords;
    case 'CLOSING':
      return sr.closingWords;
    case 'ROUND_INTRO':
      return 50;
    case 'SPEAKER_INTRO':
      return 25;
    case 'PHASE_SWITCH':
    case 'CLOSINGS_INTRO':
      return 40;
    case 'OPENING':
    case 'CLOSE':
      return 150;
  }
}

/** Estimated spoken words for the whole plan (for the builder's runtime). */
export function estimatePlanWords(plan: PlanSlot[], sr: StructuredRoundsConfig): number {
  return plan.reduce((sum, s) => sum + slotTargetWords(s, sr), 0);
}

export const SLOT_TURN_TYPE: Record<PlanSlotKind, TurnType> = {
  OPENING: 'moderator-opening',
  ROUND_INTRO: 'round-intro',
  SPEAKER_INTRO: 'speaker-intro',
  PRESENTATION: 'presentation',
  PHASE_SWITCH: 'phase-switch',
  REBUTTAL: 'rebuttal',
  CLOSINGS_INTRO: 'call-closings',
  CLOSING: 'closing',
  CLOSE: 'moderator-closing',
};

/** Where the closings section starts (CLOSINGS_INTRO, else CLOSE). */
export function closingsStart(plan: PlanSlot[]): number {
  const ci = plan.findIndex((s) => s.kind === 'CLOSINGS_INTRO');
  return ci >= 0 ? ci : plan.length - 1;
}

/**
 * The next slot to fill. Each persisted turn records its slot, so this is
 * "one after the highest delivered slot": a failed turn persists nothing and
 * its retry fills the same slot; a reload resumes exactly where it stopped.
 * Stop & close / budget cap skip ahead to the closings section.
 */
export function nextSlotIndex(
  plan: PlanSlot[],
  turns: Pick<Turn, 'planSlot'>[],
  stopRequested = false,
): number | null {
  const delivered = turns
    .map((t) => t.planSlot)
    .filter((n): n is number => typeof n === 'number');
  let next = delivered.length ? Math.max(...delivered) + 1 : 0;
  if (stopRequested) next = Math.max(next, closingsStart(plan));
  return next < plan.length ? next : null;
}

// --- Names, candidates, aliases ---------------------------------------------

function speakerName(config: SessionConfig, id: string): string {
  if (id === MODERATOR) return config.moderator.displayName || 'Moderator';
  return config.agents.find((a) => a.id === id)?.displayName ?? id;
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** Names that refer to the candidate (not the advocate). */
export function candidateAliases(agent: AgentConfig): string[] {
  const c = agent.candidate?.trim();
  return c ? Array.from(new Set([c, surname(c)].filter(Boolean))) : [];
}

/** Every name that counts as referring to this advocate or their candidate. */
export function agentAliases(agent: AgentConfig): string[] {
  const configured = (agent.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const base = configured.length ? configured : [agent.displayName, ...candidateAliases(agent)];
  return Array.from(new Set(base.filter(Boolean)));
}

// Unicode-aware whole-word match: JS \\b is ASCII-only, so "Bogotá" or
// "São Paulo" would never match with it (false rebuttal_incomplete flags).
function nameRe(n: string): RegExp {
  return nameRegex(n);
}
function mentions(text: string, names: string[]): boolean {
  return names.some((n) => nameRe(n).test(text));
}
function firstIndex(text: string, names: string[]): number {
  let best = -1;
  for (const n of names) {
    const m = nameRe(n).exec(text);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

function orderNames(config: SessionConfig, order: string[] = []): string {
  return order.map((id) => speakerName(config, id)).join(', ');
}

function forWhom(agent: AgentConfig | undefined): string {
  return agent?.candidate?.trim() ? ` for ${agent.candidate.trim()}` : '';
}

// --- B6: per-turn programme block for agents ----------------------------------

const PHASE_LABEL = { presentation: 'PRESENTATION', rebuttal: 'REBUTTAL', closing: 'CLOSING' } as const;

/**
 * The "WHERE YOU ARE IN THE PROGRAMME" + "YOUR TASK THIS TURN" block, injected
 * into the agent's system prompt after the stance block. `targetWords` is the
 * (calibrated) drafting target to state.
 */
export function agentProgrammeBlock(
  config: SessionConfig,
  agent: AgentConfig,
  slot: PlanSlot,
  targetWords: number,
): string {
  const sr = config.structuredRounds!;
  const R = sr.rounds.length;
  const order = slot.order ?? [];
  const k = order.indexOf(agent.id) + 1;
  const lines: string[] = ['WHERE YOU ARE IN THE PROGRAMME'];
  if (slot.phase === 'closing' || slot.round === undefined) {
    lines.push(`Closing statements, after all ${R} rounds.`);
  } else {
    const round = sr.rounds[slot.round];
    lines.push(`Round ${slot.round + 1} of ${R}: ${round.title}`);
    if (round.brief?.trim()) lines.push(round.brief.trim());
  }
  lines.push(`Phase: ${PHASE_LABEL[slot.phase ?? 'presentation']}`);
  lines.push(`Order this phase: ${orderNames(config, order)}. You are speaking ${k} of ${order.length}.`);
  lines.push('');
  lines.push('YOUR TASK THIS TURN');
  const yours = agent.candidate?.trim() ? `your candidate (${agent.candidate.trim()})` : 'your candidate';
  if (slot.kind === 'PRESENTATION') {
    lines.push(
      `Present ${yours}'s record and plans on this round's theme, in depth.\nSpeak only about your own candidate in this turn. Do not rebut anyone yet.\nTarget about ${targetWords} words.`,
    );
  } else if (slot.kind === 'REBUTTAL') {
    const rivals = config.agents
      .filter((a) => a.id !== agent.id)
      .map((a) => `${a.displayName}${forWhom(a)}`)
      .join(', ');
    lines.push(
      `Challenge each rival's presentation from THIS round. Name every rival\n(${rivals}), give at least one evidence-based challenge to each, and compare each\nwith ${yours}'s record on the same theme. You may answer rebuttals already\nmade against your candidate in this phase. Target about ${targetWords} words.`,
    );
  } else {
    lines.push(`Give the case for ${yours} across all rounds. Target about ${targetWords} words.`);
  }
  return lines.join('\n');
}

/** Short user-message instruction for an agent slot (the system prompt carries the detail). */
export function agentSlotInstruction(config: SessionConfig, slot: PlanSlot): string {
  const sr = config.structuredRounds!;
  const where =
    slot.round !== undefined ? `Round ${slot.round + 1}: ${sr.rounds[slot.round].title}` : 'closing statements';
  const what =
    slot.kind === 'PRESENTATION' ? 'your presentation' : slot.kind === 'REBUTTAL' ? 'your rebuttal' : 'your closing statement';
  return `It is your turn — ${what} (${where}). Follow YOUR TASK THIS TURN exactly.`;
}

// --- B7: moderator slot instructions -------------------------------------------

export function moderatorSlotInstruction(config: SessionConfig, slot: PlanSlot): string {
  const sr = config.structuredRounds!;
  const R = sr.rounds.length;
  const names = orderNames(config, slot.order);
  // With speaker intros on, the next slot hands over the floor — so the opening,
  // round intro, phase switch and closings intro must not (B-2: "Lara, the floor
  // is yours" three times running).
  const noHandOff = sr.speakerIntros
    ? ' Do not hand the floor to anyone; each speaker is introduced separately.'
    : '';
  const limit = ` Keep it under ${slotTargetWords(slot, sr)} words.`;
  switch (slot.kind) {
    case 'OPENING':
      return `Open the programme. Follow the opening instructions in the session topic. Introduce each advocate and who they present for. Do not ask anyone a question. Do not hand the floor to anyone; the round introduction follows.${limit}`;
    case 'ROUND_INTRO': {
      const r = slot.round!;
      const round = sr.rounds[r];
      const correction =
        r > 0
          ? ' If the previous round contained an unreferenced claim, or an allegation made without a court judgment, add one neutral correction sentence, for example: "For the record, the figure on X was given without a reference and should be set aside."'
          : '';
      return `Introduce Round ${r + 1} of ${R}: ${round.title}.${round.brief?.trim() ? ` Scope: ${round.brief.trim()}` : ''} State the round number, the theme and the presentation order, exactly: ${names}.${correction} 30 to 50 words. No questions.${noHandOff}`;
    }
    case 'SPEAKER_INTRO': {
      const a = config.agents.find((x) => x.id === slot.introFor);
      const what = slot.phase === 'rebuttal' ? 'rebuttal' : slot.phase === 'closing' ? 'closing statement' : 'presentation';
      return `Introduce the next speaker: ${a?.displayName ?? 'the next advocate'}, giving their ${what}${forWhom(a)}. One line, 25 words maximum. No commentary, no questions.`;
    }
    case 'PHASE_SWITCH':
      return `Announce the rebuttal phase of Round ${slot.round! + 1}: ${sr.rounds[slot.round!].title}. State the rebuttal order, exactly: ${names}. 20 to 40 words. No questions.${noHandOff}`;
    case 'CLOSINGS_INTRO':
      return `Announce the closing statements, in this order, exactly: ${names}. 20 to 40 words. No questions.${noHandOff}`;
    case 'CLOSE':
      return `Close the programme. Follow the closing instructions in the session topic. Never ask the advocates for a final pick, never comment on who changed position, never declare a winner.${limit}`;
    default:
      return '';
  }
}

/** The moderator's system-prompt job block for this format (replaces free-form modes). */
export function moderatorProgrammeBlock(config: SessionConfig): string {
  const sr = config.structuredRounds!;
  const rounds = sr.rounds
    .map((r, i) => `Round ${i + 1}: ${r.title}${r.brief?.trim() ? ` — ${r.brief.trim()}` : ''}`)
    .join('\n');
  const advocates = config.agents
    .map((a) => `${a.displayName}${forWhom(a)}${a.stance ? ` — ${a.stance}` : ''}`)
    .join('\n');
  return `THE PROGRAMME
${rounds}

THE ADVOCATES
${advocates}

YOUR JOB
You present a structured advocacy programme. The running order is fixed by the programme and you announce it; you never change it. Each time you speak you are told exactly which slot you are filling — do only that.

RULES — EVERY SLOT
- Never ask an advocate a question.
- Never praise, thank or summarise an individual turn.
- Never name a speaking order different from the one you are given.
- Give identical framing to every advocate.
- Never declare a winner or say who argued best.
- Speak plainly, as if being recorded. Spoken prose only, no markdown.
- Always finish your sentence.

Output ONLY your spoken words.`;
}

// --- B8: format-specific validation -------------------------------------------

/** PRESENTATION: must mention the agent's own candidate by name. */
export function presentationMissingCandidate(text: string, agent: AgentConfig): boolean {
  const names = candidateAliases(agent);
  return names.length > 0 && !mentions(text, names);
}

/** REBUTTAL: rivals not referenced by advocate name or candidate alias. */
export function rebuttalMissingRivals(
  text: string,
  agent: AgentConfig,
  config: SessionConfig,
): AgentConfig[] {
  return config.agents.filter((a) => a.id !== agent.id && !mentions(text, agentAliases(a)));
}

/**
 * Moderator rule breaks for a slot: a question addressed to an advocate, a
 * speaking order that differs from the plan, or a speaker intro for the wrong
 * person. Returns human-readable issues (empty = fine).
 */
export function moderatorIssues(text: string, slot: PlanSlot, config: SessionConfig): string[] {
  const issues: string[] = [];
  // A question is "to an advocate" only if it names the PERSON (display name or a
  // configured alias). Candidate names don't count: restating the topic — "London,
  // Tokyo, Berlin or Bogotá?" — is not addressing anyone (false flag in B-2 re-run).
  const people = config.agents.flatMap((a) => [a.displayName, ...(a.aliases ?? [])]);
  const sentences = text.match(/[^.!?…]*[.!?…]+/g) ?? [text];
  if (sentences.some((s) => s.trim().endsWith('?') && mentions(s, people))) {
    issues.push('asked an advocate a question');
  }
  if (slot.order && ['ROUND_INTRO', 'PHASE_SWITCH', 'CLOSINGS_INTRO'].includes(slot.kind)) {
    const found = slot.order
      .map((id) => {
        const a = config.agents.find((x) => x.id === id)!;
        const i = firstIndex(text, [a.displayName]);
        return { id, i: i >= 0 ? i : firstIndex(text, candidateAliases(a)) };
      })
      .filter((x) => x.i >= 0);
    const spoken = [...found].sort((a, b) => a.i - b.i).map((x) => x.id);
    const planned = found.map((x) => x.id); // plan order, restricted to names present
    if (found.length >= 2 && spoken.join() !== planned.join()) {
      issues.push(
        `named the order ${spoken.map((id) => speakerName(config, id)).join(', ')} but the plan is ${orderNames(config, slot.order)}`,
      );
    }
  }
  if (slot.kind === 'SPEAKER_INTRO' && slot.introFor) {
    const a = config.agents.find((x) => x.id === slot.introFor);
    if (a && !mentions(text, [a.displayName])) issues.push(`did not introduce ${a.displayName}`);
    const others = config.agents.filter(
      (x) => x.id !== slot.introFor && mentions(text, [x.displayName]),
    );
    if (others.length) issues.push(`introduced ${others.map((o) => o.displayName).join(', ')} instead`);
  }
  return issues;
}

/** Human label for a slot, e.g. "Round 2 · Rebuttal". */
export function slotLabel(config: SessionConfig, slot: PlanSlot): string {
  const kind = slot.kind
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  if (slot.round !== undefined) return `Round ${slot.round + 1} · ${kind}`;
  return kind;
}
