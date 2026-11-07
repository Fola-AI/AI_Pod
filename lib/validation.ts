// Zod validation + normalisation for session creation.

import { z } from 'zod';
import type { SessionConfig } from '@/lib/types';
import { getModel, providerSupportsWebSearch } from '@/config/models';
import { isStanceBearing } from '@/lib/formats';
import { buildPlan, SR_MAX_ROUNDS, SR_MIN_ROUNDS } from '@/lib/structured-rounds';

export const MIN_AGENTS = 3;
export const MAX_AGENTS = 6;
export const MAX_TURNS_CAP = 40;

const agentSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1, 'Character name is required'),
  personaId: z.string().min(1),
  modelId: z.string().min(1),
  stance: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.85),
  maxWordsPerTurn: z.number().int().min(40).max(600).default(160),
  referenceImage: z.string().optional(),
  voiceId: z.string().optional(),
  webSearchEnabled: z.boolean().optional(),
  forceFirstSearch: z.boolean().optional(),
  characterId: z.string().optional(),
  // Structured Rounds: the candidate this advocate argues for + name aliases.
  candidate: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});

const structuredRoundsSchema = z.object({
  rounds: z
    .array(z.object({ id: z.string().min(1), title: z.string(), brief: z.string().optional() }))
    .min(SR_MIN_ROUNDS)
    .max(SR_MAX_ROUNDS),
  presentationWords: z.number().int().min(50).max(2000).default(450),
  rebuttalWords: z.number().int().min(50).max(2000).default(300),
  speakerIntros: z.boolean().default(true),
  advocateClosings: z.boolean().default(false),
  closingWords: z.number().int().min(30).max(1000).default(150),
  baseOrder: z.array(z.string()).default([]),
});

const relationshipSchema = z.object({
  agentA: z.string().min(1),
  agentB: z.string().min(1),
  dynamic: z.string().min(1),
});

const moderatorSchema = z.object({
  displayName: z.string().default('Moderator'),
  modelId: z.string().min(1),
  interjectionFrequency: z.enum(['low', 'medium', 'high']).default('medium'),
  temperature: z.number().min(0).max(2).default(0.7),
  voiceId: z.string().optional(),
});

const sourceDocSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
});

export const createSessionSchema = z
  .object({
    title: z.string().min(1, 'Title is required'),
    topic: z.string().min(1, 'Topic is required'),
    format: z.enum([
      'debate',
      'panel',
      'postmortem',
      'scenario',
      'hot-seat',
      'deliberation',
      'shared-curiosity',
      'quickfire',
      'story-swap',
      'structured-rounds',
    ]),
    domain: z.string().default('general'),
    sourceMaterial: z.array(sourceDocSchema).optional(),
    agentCount: z.number().int().min(MIN_AGENTS).max(MAX_AGENTS),
    agents: z.array(agentSchema).min(MIN_AGENTS).max(MAX_AGENTS),
    moderator: moderatorSchema,
    targetWordCount: z.number().int().min(300).max(20000).default(2600),
    maxTurns: z.number().int().min(4).max(MAX_TURNS_CAP).default(24),
    budgetCapUsd: z.number().positive().optional(),
    interjectionRate: z
      .enum(['off', 'low', 'medium', 'high'])
      .default('medium'),
    openingBanter: z.boolean().default(true),
    relationships: z.array(relationshipSchema).optional(),
    structuredRounds: structuredRoundsSchema.optional(),
    webSearch: z
      .object({
        mode: z.enum(['none', 'shared', 'native']).default('shared'),
        maxSearchesPerTurn: z.number().int().min(0).max(3).default(2),
        maxSearchesPerSession: z.number().int().min(0).max(100).default(25),
        resultsPerSearch: z.number().int().min(1).max(5).default(5),
        // Optional global override; when unset, forcing is decided per agent by
        // model tool-propensity (B-5.5).
        forceFirstSearch: z.boolean().optional(),
        researchPack: z.boolean().optional(),
      })
      .default({
        mode: 'shared',
        maxSearchesPerTurn: 2,
        maxSearchesPerSession: 25,
        resultsPerSearch: 5,
      }),
  })
  .refine((d) => d.agents.length === d.agentCount, {
    message: 'agents length must equal agentCount',
    path: ['agents'],
  });

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Validate model references and stance requirements beyond the shape. */
export function validateReferences(input: CreateSessionInput): string[] {
  const errors: string[] = [];
  for (const a of input.agents) {
    if (!getModel(a.modelId)) errors.push(`Unknown model: ${a.modelId}`);
    if (isStanceBearing(input.format) && input.format === 'debate' && !a.stance) {
      errors.push(`${a.displayName} needs a stance for a debate.`);
    }
  }
  if (!getModel(input.moderator.modelId)) {
    errors.push(`Unknown moderator model: ${input.moderator.modelId}`);
  }
  // Structured Rounds (B1/B2): stances and candidates are mandatory, every round
  // needs a theme, and the advocate order must cover exactly the agents. Only
  // enforced at Create session — drafts may be incomplete.
  if (input.format === 'structured-rounds') {
    const sr = input.structuredRounds;
    if (!sr) {
      errors.push('Structured Rounds needs its rounds configuration.');
    } else {
      sr.rounds.forEach((r, i) => {
        if (!r.title.trim()) errors.push(`Round ${i + 1} needs a theme.`);
      });
      const ids = new Set(input.agents.map((a) => a.id));
      const order = sr.baseOrder.length ? sr.baseOrder : input.agents.map((a) => a.id);
      if (order.length !== ids.size || !order.every((id) => ids.has(id))) {
        errors.push('The advocate order must list every advocate exactly once.');
      }
    }
    for (const a of input.agents) {
      if (!a.stance?.trim()) errors.push(`${a.displayName} needs a stance.`);
      if (!a.candidate?.trim()) errors.push(`${a.displayName} needs a candidate.`);
    }
  }
  // Native mode requires every agent on a provider with native search — the
  // session may not mix native and unsupported providers (B-5.5, criterion 8).
  if (input.webSearch?.mode === 'native') {
    for (const a of input.agents) {
      const model = getModel(a.modelId);
      if (model && !providerSupportsWebSearch(model.provider)) {
        errors.push(
          `${a.displayName} is on a provider without native search; use shared mode or change the model.`,
        );
      }
    }
  }
  return errors;
}

export function toSessionConfig(input: CreateSessionInput): SessionConfig {
  return {
    id: crypto.randomUUID(),
    title: input.title,
    topic: input.topic,
    format: input.format,
    domain: input.domain,
    sourceMaterial: input.sourceMaterial,
    agentCount: input.agentCount,
    agents: input.agents,
    moderator: input.moderator,
    targetWordCount: input.targetWordCount,
    maxTurns: input.maxTurns,
    budgetCapUsd: input.budgetCapUsd,
    interjectionRate: input.interjectionRate,
    openingBanter: input.openingBanter,
    relationships: input.relationships,
    webSearch: input.webSearch,
    // Structured Rounds: compute the full turn plan now and persist it with the
    // session — from here on it is fixed and executed slot by slot (B4).
    structuredRounds:
      input.format === 'structured-rounds' && input.structuredRounds
        ? (() => {
            const sr = input.structuredRounds!;
            const baseOrder = sr.baseOrder.length ? sr.baseOrder : input.agents.map((a) => a.id);
            const cfg = { ...sr, baseOrder };
            return { ...cfg, plan: buildPlan(cfg) };
          })()
        : undefined,
    createdAt: new Date().toISOString(),
  };
}
