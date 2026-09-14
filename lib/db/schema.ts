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
  SessionConfig,
  SessionStatus,
  TurnType,
} from '@/lib/types';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  config: jsonb('config').$type<SessionConfig>().notNull(),
  status: text('status').$type<SessionStatus>().notNull().default('draft'),
  totalWords: integer('total_words').notNull().default(0),
  totalCostUsd: doublePrecision('total_cost_usd').notNull().default(0),
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
    text: text('text').notNull(),
    modelId: text('model_id').notNull(),
    personaId: text('persona_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    wasEdited: boolean('was_edited').notNull().default(false),
    isStale: boolean('is_stale').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('turns_session_idx').on(t.sessionId, t.index)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
