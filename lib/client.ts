// Client-side API helpers.

import type { Session, Turn } from '@/lib/types';
import type { SessionSummary } from '@/lib/db/queries';
import type { ProviderId } from '@/lib/types';

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
      status: res.status,
      code: data.code,
      provider: data.provider,
      recoverable: data.recoverable,
    });
  }
  return data;
}

export async function fetchProviders(): Promise<{
  available: Record<ProviderId, boolean>;
  implemented: Record<ProviderId, boolean>;
}> {
  const res = await fetch('/api/providers', { cache: 'no-store' });
  return jsonOrThrow(res);
}

export async function createSession(payload: unknown): Promise<Session> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await jsonOrThrow(res);
  return data.session;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/sessions', { cache: 'no-store' });
  const data = await jsonOrThrow(res);
  return data.sessions;
}

export async function getSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}`, { cache: 'no-store' });
  const data = await jsonOrThrow(res);
  return data.session;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export interface TurnResponse {
  turn: Turn | null;
  complete: boolean;
  totalWords: number;
  totalCostUsd: number;
}

export async function postTurn(
  sessionId: string,
  stopRequested = false,
): Promise<TurnResponse> {
  const res = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, stopRequested }),
  });
  return jsonOrThrow(res);
}
