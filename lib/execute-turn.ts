// Executes a single planned turn: assembles prompts, calls the provider (with
// retry), and returns a Turn object ready to persist. Used by /api/turn.

import type { SessionConfig, Turn } from '@/lib/types';
import { getModel } from '@/config/models';
import { getAdapter, withRetry } from '@/lib/providers';
import {
  buildAgentSystemPrompt,
  buildModeratorSystemPrompt,
  buildTurnUserMessage,
} from '@/lib/prompts';
import type { TurnPlan } from '@/lib/orchestrator';
import { MODERATOR_ID } from '@/lib/orchestrator';
import { countWords, turnCostUsd } from '@/lib/cost';

export async function executeTurn(
  config: SessionConfig,
  priorTurns: Turn[],
  plan: TurnPlan,
): Promise<Omit<Turn, 'index'>> {
  const model = getModel(plan.modelId);
  if (!model) {
    throw new Error(`Unknown model "${plan.modelId}".`);
  }

  const adapter = getAdapter(model.provider); // throws MissingKeyError if no key

  const isModerator = plan.speakerId === MODERATOR_ID;
  const systemPrompt = isModerator
    ? buildModeratorSystemPrompt(config)
    : buildAgentSystemPrompt(config, plan.agent!, {
        holdsSeat: plan.holdsSeat,
      });

  // The transcript so far goes in the user message; the character is fixed in
  // the system prompt. Everything is a single 'user' message per turn.
  const userMessage = buildTurnUserMessage(
    priorTurns,
    plan.turnType,
    plan.instructionOpts,
  );

  // Give the model a little headroom over the word budget (words -> tokens).
  const maxTokens = Math.max(256, Math.ceil(plan.maxWords * 2.2));

  const result = await withRetry(() =>
    adapter.generate({
      apiModelString: model.apiModelString,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature: plan.temperature,
      maxTokens,
    }),
  );

  const costUsd = turnCostUsd(
    plan.modelId,
    result.inputTokens,
    result.outputTokens,
  );

  return {
    speakerId: plan.speakerId,
    speakerDisplayName: plan.speakerDisplayName,
    turnType: plan.turnType,
    text: result.text,
    modelId: plan.modelId,
    personaId: plan.personaId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
    latencyMs: result.latencyMs,
    wasEdited: false,
    isStale: false,
    createdAt: new Date().toISOString(),
    // For convenience downstream:
    // (word count is derived, not stored separately)
  };
}

export function turnWordCount(t: { text: string }): number {
  return countWords(t.text);
}
