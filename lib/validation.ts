// Zod validation + normalisation for session creation.

import { z } from 'zod';
import type { SessionConfig } from '@/lib/types';
import { getModel } from '@/config/models';
import { isStanceBearing } from '@/lib/formats';

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
});

const moderatorSchema = z.object({
  displayName: z.string().default('Moderator'),
  modelId: z.string().min(1),
  interjectionFrequency: z.enum(['low', 'medium', 'high']).default('medium'),
  temperature: z.number().min(0).max(2).default(0.7),
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
    ]),
    domain: z.string().default('general'),
    sourceMaterial: z.array(sourceDocSchema).optional(),
    agentCount: z.number().int().min(MIN_AGENTS).max(MAX_AGENTS),
    agents: z.array(agentSchema).min(MIN_AGENTS).max(MAX_AGENTS),
    moderator: moderatorSchema,
    targetWordCount: z.number().int().min(300).max(20000).default(2600),
    maxTurns: z.number().int().min(4).max(MAX_TURNS_CAP).default(24),
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
    createdAt: new Date().toISOString(),
  };
}
