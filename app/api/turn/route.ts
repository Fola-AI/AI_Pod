import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, appendTurn } from '@/lib/db/queries';
import { planNextTurn } from '@/lib/orchestrator';
import { executeTurn } from '@/lib/execute-turn';
import { countWords } from '@/lib/cost';
import { providerErrorPayload } from '@/lib/provider-error-response';
import { EmptyContentError } from '@/lib/providers/errors';

export const runtime = 'nodejs';
// One turn = one provider call. Give the function room for a slow model.
export const maxDuration = 60;

const bodySchema = z.object({
  sessionId: z.string().min(1),
  stopRequested: z.boolean().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { sessionId, stopRequested } = parsed.data;

  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Budget cap: once actual spend exceeds it, jump straight to closings.
  const budgetExceeded =
    typeof session.config.budgetCapUsd === 'number' &&
    session.totalCostUsd >= session.config.budgetCapUsd;

  const plan = planNextTurn(session.config, session.turns, {
    stopRequested: stopRequested || budgetExceeded,
  });

  // Nothing left to do — the session is already complete.
  if (!plan) {
    return NextResponse.json({
      complete: true,
      turn: null,
      totalWords: session.totalWords,
      totalCostUsd: session.totalCostUsd,
    });
  }

  let executed;
  try {
    executed = await executeTurn(session.config, session.turns, plan);
  } catch (err) {
    // An error never becomes a turn — nothing is persisted (P0-2 §1).
    const { status, body } = providerErrorPayload(err, {
      agentId: plan.speakerId,
      agentName: plan.speakerDisplayName,
      modelId: plan.modelId,
    });
    return NextResponse.json(body, { status });
  }

  // Backstop: a genuinely empty successful completion must never be stored
  // (P0-2 §6). executeTurn already fails these fatally, but guard here too.
  if (executed.text.trim().length < 20) {
    const { status, body } = providerErrorPayload(
      new EmptyContentError(plan.modelId, plan.speakerDisplayName),
      {
        agentId: plan.speakerId,
        agentName: plan.speakerDisplayName,
        modelId: plan.modelId,
      },
    );
    return NextResponse.json(body, { status });
  }

  const index = session.turns.length;
  const words = countWords(executed.text);
  const totalWords = session.totalWords + words;
  const totalCostUsd = session.totalCostUsd + executed.costUsd;

  // Is this the last turn? Re-plan with the new turn included.
  const provisionalTurn = { ...executed, index };
  const nextPlan = planNextTurn(
    session.config,
    [...session.turns, provisionalTurn],
    {},
  );
  const complete = nextPlan === null;
  const status = complete ? 'complete' : 'running';

  const savedTurn = await appendTurn(sessionId, executed, index, {
    totalWords,
    totalCostUsd,
    status,
    completedAt: complete ? new Date().toISOString() : null,
  });

  return NextResponse.json({
    turn: savedTurn,
    complete,
    totalWords,
    totalCostUsd,
  });
}
