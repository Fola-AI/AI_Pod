import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, appendTurn } from '@/lib/db/queries';
import { planNextTurn } from '@/lib/orchestrator';
import { executeTurn } from '@/lib/execute-turn';
import { countWords } from '@/lib/cost';
import { MissingKeyError, ProviderError } from '@/lib/providers/errors';

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
    if (err instanceof MissingKeyError) {
      return NextResponse.json(
        {
          error: err.message,
          code: 'missing_key',
          provider: err.provider,
          recoverable: true,
        },
        { status: 400 },
      );
    }
    if (err instanceof ProviderError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.isRateLimit ? 'rate_limit' : 'provider_error',
          provider: err.provider,
          recoverable: true,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, code: 'unknown', recoverable: true },
      { status: 500 },
    );
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
