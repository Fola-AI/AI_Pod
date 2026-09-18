// Drizzle schema. Sessions hold the full config as JSONB; turns are appended
// one row at a time so a crash or refresh loses at most one turn (PRD §9.4, §10).

import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type {
  BlockingWarning,
  Claim,
  ClaimConflict,
  ColdOpen,
  SessionConfig,
  SessionStatus,
  TurnClass,
  TurnSearch,
  TurnType,
} from '@/lib/types';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  config: jsonb('config').$type<SessionConfig>().notNull(),
  status: text('status').$type<SessionStatus>().notNull().default('draft'),
  totalWords: integer('total_words').notNull().default(0),
  totalCostUsd: doublePrecision('total_cost_usd').notNull().default(0),
  claims: jsonb('claims').$type<Claim[]>(),
  claimConflicts: jsonb('claim_conflicts').$type<ClaimConflict[]>(),
  blockingWarnings: jsonb('blocking_warnings').$type<BlockingWarning[]>(),
  coldOpen: jsonb('cold_open').$type<ColdOpen>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    speakerId: text('speaker_id').notNull(),
    speakerDisplayName: text('speaker_display_name').notNull(),
    turnType: text('turn_type').$type<TurnType>().notNull(),
    turnClass: text('turn_class')
      .$type<TurnClass>()
      .notNull()
      .default('full'),
    text: text('text').notNull(),
    taggedText: text('tagged_text'),
    searches: jsonb('searches').$type<TurnSearch[]>(),
    searchDegraded: boolean('search_degraded').notNull().default(false),
    modelId: text('model_id').notNull(),
    personaId: text('persona_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    wasEdited: boolean('was_edited').notNull().default(false),
    isStale: boolean('is_stale').notNull().default(false),
    wasTruncated: boolean('was_truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('turns_session_idx').on(t.sessionId, t.index)],
);

// Persona library (B-6). Previously code-only in lib/personas.ts; moved here so
// personas can be tuned without a deploy. The built-in seven are seeded on first
// run (idempotent, only when empty) with isBuiltIn = true; edits are never
// overwritten. Sessions snapshot a persona's text at creation, so editing a row
// here never changes a past session.
export const personas = pgTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  shortDescription: text('short_description').notNull().default(''),
  systemPromptFragment: text('system_prompt_fragment').notNull().default(''),
  speakingStyle: text('speaking_style').notNull().default(''),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Show-bible characters (B-6, A-4). Reusable across sessions; runningNotes and
// catchphrases ship empty and earn content over episodes.
export const characters = pgTable('characters', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  defaultPersonaId: text('default_persona_id').notNull().default(''),
  voiceId: text('voice_id'),
  runningNotes: text('running_notes').notNull().default(''),
  catchphrases: jsonb('catchphrases').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type PersonaRow = typeof personas.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
