// Persona data access (B-6). The built-in seven are seeded on first run —
// idempotently, and only when the table is empty, so operator edits are never
// overwritten. Personas are snapshotted into a session at creation, so nothing
// here ever mutates a past transcript.

import { asc, desc, eq } from 'drizzle-orm';
import { db } from './index';
import { personas } from './schema';
import type { PersonaRow } from './schema';
import type { Persona } from '@/lib/types';
import { BUILT_IN_PERSONAS } from '@/lib/personas';

function rowToPersona(r: PersonaRow): Persona {
  return {
    id: r.id,
    name: r.name,
    shortDescription: r.shortDescription,
    systemPromptFragment: r.systemPromptFragment,
    speakingStyle: r.speakingStyle,
    isBuiltIn: r.isBuiltIn,
  };
}

let seeded = false;

/** Insert the built-in personas once, only if the table is empty. Idempotent. */
export async function seedPersonasIfEmpty(): Promise<void> {
  if (seeded) return;
  const existing = await db.select({ id: personas.id }).from(personas).limit(1);
  if (existing.length === 0) {
    await db.insert(personas).values(
      BUILT_IN_PERSONAS.map((p) => ({
        id: p.id,
        name: p.name,
        shortDescription: p.shortDescription,
        systemPromptFragment: p.systemPromptFragment,
        speakingStyle: p.speakingStyle,
        isBuiltIn: true,
      })),
    );
  }
  seeded = true;
}

/** All personas, built-ins first, then by name. Seeds on first call. */
export async function listPersonas(): Promise<Persona[]> {
  await seedPersonasIfEmpty();
  const rows = await db
    .select()
    .from(personas)
    .orderBy(desc(personas.isBuiltIn), asc(personas.name));
  return rows.map(rowToPersona);
}

/** One persona by id, or undefined. Seeds on first call. */
export async function getPersonaById(id: string): Promise<Persona | undefined> {
  await seedPersonasIfEmpty();
  const rows = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
  return rows[0] ? rowToPersona(rows[0]) : undefined;
}

/**
 * Capture each agent's persona text into `personaSnapshot` at session creation
 * (B-6). The session then replays from this snapshot regardless of later edits,
 * and `personaId` is kept so the operator can see which persona was used and how
 * it has since drifted. Mutates and returns the config's agents in place.
 */
export async function attachPersonaSnapshots<
  T extends { agents: { personaId: string; personaSnapshot?: unknown }[] },
>(config: T): Promise<T> {
  await seedPersonasIfEmpty();
  for (const agent of config.agents) {
    const p = await getPersonaById(agent.personaId);
    if (p) {
      agent.personaSnapshot = {
        name: p.name,
        shortDescription: p.shortDescription,
        systemPromptFragment: p.systemPromptFragment,
        speakingStyle: p.speakingStyle,
      };
    }
  }
  return config;
}
