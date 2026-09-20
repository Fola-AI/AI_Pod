// Client-side API helpers.

import type {
  BlockingWarning,
  Character,
  Claim,
  ClaimConflict,
  ColdOpen,
  Persona,
  Session,
  Turn,
} from '@/lib/types';
import type { SessionSummary } from '@/lib/db/queries';
import type { ProviderId } from '@/lib/types';

export type { Claim, ClaimConflict, BlockingWarning };

export interface ApiError extends Error {
  status?: number;
  code?: string;
  failureClass?: 'fatal' | 'transient' | 'unknown';
  provider?: string;
  agentId?: string;
  agentName?: string;
  modelId?: string;
  model?: string;
  recoverable?: boolean;
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data.error || `Request failed (${res.status})`),
      {
        status: res.status,
        code: data.code,
        failureClass: data.failureClass,
        provider: data.provider,
        agentId: data.agentId,
        agentName: data.agentName,
        modelId: data.modelId,
        model: data.model,
        recoverable: data.recoverable,
      },
    ) as ApiError;
  }
  return data;
}

export interface ModelTestResult {
  ok: boolean;
  message?: string;
  at: number;
}

export async function fetchProviders(): Promise<{
  available: Record<ProviderId, boolean>;
  implemented: Record<ProviderId, boolean>;
  hasKey: Record<ProviderId, boolean>;
  modelTests: Record<string, ModelTestResult>;
}> {
  const res = await fetch('/api/providers', { cache: 'no-store' });
  return jsonOrThrow(res);
}

/** Test one model by id (registry screen / builder roster verify). */
export async function testModel(
  modelId: string,
): Promise<{ ok: boolean; model?: string; message?: string }> {
  const res = await fetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  return jsonOrThrow(res);
}

export async function fetchPersonas(): Promise<Persona[]> {
  const res = await fetch('/api/personas', { cache: 'no-store' });
  const data = await jsonOrThrow(res);
  return data.personas ?? [];
}

export async function createPersona(input: Partial<Persona>): Promise<Persona> {
  const res = await fetch('/api/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).persona;
}

export async function updatePersona(id: string, input: Partial<Persona>): Promise<Persona> {
  const res = await fetch(`/api/personas/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).persona;
}

export async function deletePersona(id: string): Promise<void> {
  const res = await fetch(`/api/personas/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function fetchCharacters(): Promise<Character[]> {
  const res = await fetch('/api/characters', { cache: 'no-store' });
  return (await jsonOrThrow(res)).characters ?? [];
}

export async function createCharacter(input: Partial<Character>): Promise<Character> {
  const res = await fetch('/api/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).character;
}

export async function updateCharacter(
  id: string,
  input: Partial<Character>,
): Promise<Character> {
  const res = await fetch(`/api/characters/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res)).character;
}

export async function deleteCharacter(id: string): Promise<void> {
  const res = await fetch(`/api/characters/${id}`, { method: 'DELETE' });
  await jsonOrThrow(res);
}

export async function runColdOpen(sessionId: string): Promise<ColdOpen | null> {
  const res = await fetch(`/api/sessions/${sessionId}/cold-open`, { method: 'POST' });
  return (await jsonOrThrow(res)).coldOpen ?? null;
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

export interface TurnMutationResponse {
  turns: Turn[];
  totalWords: number;
  totalCostUsd: number;
}

export async function regenerateTurn(
  sessionId: string,
  index: number,
): Promise<TurnMutationResponse> {
  const res = await fetch(
    `/api/sessions/${sessionId}/turns/${index}/regenerate`,
    { method: 'POST' },
  );
  return jsonOrThrow(res);
}

export async function editTurn(
  sessionId: string,
  index: number,
  text: string,
): Promise<{ totalWords: number; totalCostUsd: number }> {
  const res = await fetch(`/api/sessions/${sessionId}/turns/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return jsonOrThrow(res);
}

export async function deleteTurn(
  sessionId: string,
  index: number,
): Promise<TurnMutationResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/turns/${index}`, {
    method: 'DELETE',
  });
  return jsonOrThrow(res);
}

export async function extractClaims(sessionId: string): Promise<{
  claims: Claim[];
  conflicts: ClaimConflict[];
  blockingWarnings: BlockingWarning[];
}> {
  const res = await fetch(`/api/sessions/${sessionId}/claims`, {
    method: 'POST',
  });
  const data = await jsonOrThrow(res);
  return {
    claims: data.claims ?? [],
    conflicts: data.conflicts ?? [],
    blockingWarnings: data.blockingWarnings ?? [],
  };
}

export interface PreflightCheck {
  modelId: string;
  displayName: string;
  ok: boolean;
  message?: string;
}

export async function preflight(
  sessionId: string,
): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const res = await fetch(`/api/sessions/${sessionId}/preflight`, {
    method: 'POST',
  });
  return jsonOrThrow(res);
}

export interface VoicePassResponse {
  verified: number;
  failed: number;
  tagCount: number;
  wordCount: number;
  tagsPerWords: number;
  turns: Turn[];
}

export async function runVoicePass(sessionId: string): Promise<VoicePassResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/voice-pass`, {
    method: 'POST',
  });
  return jsonOrThrow(res);
}

export async function editTaggedText(
  sessionId: string,
  index: number,
  taggedText: string,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/turns/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taggedText }),
  });
  await jsonOrThrow(res);
}

export async function substituteAgentModel(
  sessionId: string,
  agentId: string,
  modelId: string,
): Promise<Session> {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'substitute', agentId, modelId }),
  });
  const data = await jsonOrThrow(res);
  return data.session;
}

export async function removeAgent(
  sessionId: string,
  agentId: string,
): Promise<Session> {
  const res = await fetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', agentId }),
  });
  const data = await jsonOrThrow(res);
  return data.session;
}
