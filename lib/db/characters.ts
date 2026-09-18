// Character (show-bible) data access (B-6, A-4). Reusable across sessions.
// runningNotes/catchphrases start empty and are filled in over episodes.

import { asc, eq } from 'drizzle-orm';
import { db } from './index';
import { characters } from './schema';
import type { CharacterRow } from './schema';
import type { Character } from '@/lib/types';

function rowToCharacter(r: CharacterRow): Character {
  return {
    id: r.id,
    displayName: r.displayName,
    defaultPersonaId: r.defaultPersonaId,
    voiceId: r.voiceId ?? undefined,
    runningNotes: r.runningNotes,
    catchphrases: r.catchphrases ?? [],
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

export async function listCharacters(): Promise<Character[]> {
  const rows = await db.select().from(characters).orderBy(asc(characters.displayName));
  return rows.map(rowToCharacter);
}

export async function getCharacterById(id: string): Promise<Character | undefined> {
  const rows = await db.select().from(characters).where(eq(characters.id, id)).limit(1);
  return rows[0] ? rowToCharacter(rows[0]) : undefined;
}

export interface CharacterInput {
  displayName: string;
  defaultPersonaId: string;
  voiceId?: string;
  runningNotes?: string;
  catchphrases?: string[];
}

export async function createCharacter(input: CharacterInput): Promise<Character> {
  const id = crypto.randomUUID();
  await db.insert(characters).values({
    id,
    displayName: input.displayName,
    defaultPersonaId: input.defaultPersonaId,
    voiceId: input.voiceId,
    runningNotes: input.runningNotes ?? '',
    catchphrases: input.catchphrases ?? [],
  });
  return (await getCharacterById(id))!;
}

export async function updateCharacter(
  id: string,
  input: Partial<CharacterInput>,
): Promise<Character | undefined> {
  await db
    .update(characters)
    .set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.defaultPersonaId !== undefined
        ? { defaultPersonaId: input.defaultPersonaId }
        : {}),
      ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
      ...(input.runningNotes !== undefined ? { runningNotes: input.runningNotes } : {}),
      ...(input.catchphrases !== undefined ? { catchphrases: input.catchphrases } : {}),
    })
    .where(eq(characters.id, id));
  return getCharacterById(id);
}

export async function deleteCharacter(id: string): Promise<void> {
  await db.delete(characters).where(eq(characters.id, id));
}

/**
 * Capture each agent's character content (runningNotes/catchphrases) at session
 * creation, alongside the persona snapshot — same provenance/replay reasoning.
 */
export async function attachCharacterSnapshots<
  T extends { agents: { characterId?: string; characterSnapshot?: unknown }[] },
>(config: T): Promise<T> {
  for (const agent of config.agents) {
    if (!agent.characterId) continue;
    const c = await getCharacterById(agent.characterId);
    if (c) {
      agent.characterSnapshot = {
        runningNotes: c.runningNotes,
        catchphrases: c.catchphrases,
      };
    }
  }
  return config;
}
