// Data-access helpers. All session/turn reads and writes go through here.

import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from './index';
import { sessions, turns } from './schema';
import type { SessionRow, TurnRow } from './schema';
import type {
  Claim,
  Session,
  SessionConfig,
  SessionStatus,
  Turn,
  TurnSearch,
} from '@/lib/types';
import { countWords } from '@/lib/cost';

function rowToTurn(r: TurnRow): Turn {
  return {
    index: r.index,
    speakerId: r.speakerId,
    speakerDisplayName: r.speakerDisplayName,
    turnType: r.turnType,
    turnClass: r.turnClass,
    text: r.text,
    taggedText: r.taggedText ?? undefined,
    searches: r.searches ?? undefined,
    searchDegraded: r.searchDegraded || undefined,
    modelId: r.modelId,
    personaId: r.personaId ?? undefined,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    wasEdited: r.wasEdited,
    isStale: r.isStale,
    wasTruncated: r.wasTruncated,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function rowToSession(s: SessionRow, ts: TurnRow[]): Session {
  return {
    id: s.id,
    config: s.config,
    turns: ts.map(rowToTurn),
    status: s.status,
    totalWords: s.totalWords,
    totalCostUsd: s.totalCostUsd,
    claims: s.claims ?? undefined,
    createdAt:
      s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
    completedAt: s.completedAt
      ? s.completedAt instanceof Date
        ? s.completedAt.toISOString()
        : String(s.completedAt)
      : undefined,
  };
}

export async function createSession(config: SessionConfig): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({
      id: config.id,
      title: config.title,
      config,
      status: 'draft',
      totalWords: 0,
      totalCostUsd: 0,
    })
    .returning();
  return rowToSession(row, []);
}

export async function getSession(id: string): Promise<Session | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) return null;
  const ts = await db
    .select()
    .from(turns)
    .where(eq(turns.sessionId, id))
    .orderBy(asc(turns.index));
  return rowToSession(row, ts);
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  format: string;
  participants: string[];
  totalWords: number;
  totalCostUsd: number;
  createdAt: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const rows = await db.select().from(sessions);
  const summaries = rows.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    format: s.config.format,
    participants: s.config.agents.map((a) => a.displayName),
    totalWords: s.totalWords,
    totalCostUsd: s.totalCostUsd,
    createdAt:
      s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
  }));
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return summaries;
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/** Append a turn and update session aggregates atomically-ish (two writes). */
export async function appendTurn(
  sessionId: string,
  turn: Omit<Turn, 'index'>,
  index: number,
  aggregates: {
    totalWords: number;
    totalCostUsd: number;
    status: SessionStatus;
    completedAt?: string | null;
  },
): Promise<Turn> {
  const id = `${sessionId}:${index}`;
  const [row] = await db
    .insert(turns)
    .values({
      id,
      sessionId,
      index,
      speakerId: turn.speakerId,
      speakerDisplayName: turn.speakerDisplayName,
      turnType: turn.turnType,
      turnClass: turn.turnClass,
      text: turn.text,
      searches: turn.searches,
      searchDegraded: turn.searchDegraded ?? false,
      modelId: turn.modelId,
      personaId: turn.personaId,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.costUsd,
      latencyMs: turn.latencyMs,
      wasEdited: turn.wasEdited,
      isStale: turn.isStale,
      wasTruncated: turn.wasTruncated,
    })
    .returning();

  await db
    .update(sessions)
    .set({
      totalWords: aggregates.totalWords,
      totalCostUsd: aggregates.totalCostUsd,
      status: aggregates.status,
      completedAt: aggregates.completedAt
        ? new Date(aggregates.completedAt)
        : null,
    })
    .where(eq(sessions.id, sessionId));

  return rowToTurn(row);
}

export async function setSessionStatus(
  id: string,
  status: SessionStatus,
): Promise<void> {
  await db.update(sessions).set({ status }).where(eq(sessions.id, id));
}

/** Persist the extracted claims checklist for a session. */
export async function setSessionClaims(
  id: string,
  claims: Claim[],
): Promise<void> {
  await db.update(sessions).set({ claims }).where(eq(sessions.id, id));
}

/** Persist voice-pass tagged text for many turns (B-1). */
export async function setTaggedTexts(
  sessionId: string,
  entries: { index: number; taggedText: string | null }[],
): Promise<void> {
  for (const e of entries) {
    await db
      .update(turns)
      .set({ taggedText: e.taggedText })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.index, e.index)));
  }
}

/** Hand-edit a single turn's tagged text. */
export async function updateTurnTaggedText(
  sessionId: string,
  index: number,
  taggedText: string,
): Promise<void> {
  await db
    .update(turns)
    .set({ taggedText })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.index, index)));
}

/** Replace a session's config (mid-session substitute-model / remove-agent). */
export async function updateSessionConfig(
  id: string,
  config: SessionConfig,
): Promise<void> {
  await db
    .update(sessions)
    .set({ config, title: config.title })
    .where(eq(sessions.id, id));
}

/** Inline hand-edit of a single turn's text. */
export async function updateTurnText(
  sessionId: string,
  index: number,
  text: string,
): Promise<void> {
  await db
    .update(turns)
    .set({ text, wasEdited: true, wasTruncated: false })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.index, index)));
}

/** Replace a turn's generated content after a regenerate. */
export async function replaceTurn(
  sessionId: string,
  index: number,
  fields: {
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    wasTruncated?: boolean;
    modelId?: string;
    searches?: TurnSearch[];
    searchDegraded?: boolean;
  },
): Promise<void> {
  await db
    .update(turns)
    .set({
      ...fields,
      searches: fields.searches ?? null,
      searchDegraded: fields.searchDegraded ?? false,
      wasTruncated: fields.wasTruncated ?? false,
      wasEdited: false,
      isStale: false,
    })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.index, index)));
}

/** Mark every turn after `index` as stale (its context changed). */
export async function markTurnsStaleAfter(
  sessionId: string,
  index: number,
): Promise<void> {
  await db
    .update(turns)
    .set({ isStale: true })
    .where(and(eq(turns.sessionId, sessionId), gt(turns.index, index)));
}

/** Delete a turn and renumber the ones after it (indices are contiguous). */
export async function deleteTurnAndRenumber(
  sessionId: string,
  index: number,
): Promise<void> {
  await db
    .delete(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.index, index)));
  const rest = await db
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), gt(turns.index, index)))
    .orderBy(asc(turns.index));
  for (const r of rest) {
    const newIndex = r.index - 1;
    await db
      .update(turns)
      .set({ index: newIndex, id: `${sessionId}:${newIndex}` })
      .where(eq(turns.id, r.id));
  }
}

/** Recompute and persist word/cost totals from the current turns. */
export async function recomputeAggregates(
  sessionId: string,
): Promise<{ totalWords: number; totalCostUsd: number }> {
  const ts = await db
    .select()
    .from(turns)
    .where(eq(turns.sessionId, sessionId));
  const totalWords = ts.reduce((s, t) => s + countWords(t.text), 0);
  const totalCostUsd = ts.reduce((s, t) => s + t.costUsd, 0);
  await db
    .update(sessions)
    .set({ totalWords, totalCostUsd })
    .where(eq(sessions.id, sessionId));
  return { totalWords, totalCostUsd };
}
