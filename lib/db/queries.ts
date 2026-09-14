// Data-access helpers. All session/turn reads and writes go through here.

import { and, asc, eq } from 'drizzle-orm';
import { db } from './index';
import { sessions, turns } from './schema';
import type { SessionRow, TurnRow } from './schema';
import type {
  Session,
  SessionConfig,
  SessionStatus,
  Turn,
} from '@/lib/types';

function rowToTurn(r: TurnRow): Turn {
  return {
    index: r.index,
    speakerId: r.speakerId,
    speakerDisplayName: r.speakerDisplayName,
    turnType: r.turnType,
    text: r.text,
    modelId: r.modelId,
    personaId: r.personaId ?? undefined,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    wasEdited: r.wasEdited,
    isStale: r.isStale,
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
      text: turn.text,
      modelId: turn.modelId,
      personaId: turn.personaId,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.costUsd,
      latencyMs: turn.latencyMs,
      wasEdited: turn.wasEdited,
      isStale: turn.isStale,
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

/** Edit a single turn's text (Phase 2 inline edit; used by the API). */
export async function updateTurnText(
  sessionId: string,
  index: number,
  text: string,
): Promise<void> {
  await db
    .update(turns)
    .set({ text, wasEdited: true })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.index, index)));
}
