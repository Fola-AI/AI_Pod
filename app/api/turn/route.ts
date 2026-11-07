import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, appendTurn, setSessionError, getSessionStatus } from '@/lib/db/queries';
import { planNextTurn } from '@/lib/orchestrator';
import { executeTurn } from '@/lib/execute-turn';
import { countWords } from '@/lib/cost';
import { providerErrorPayload } from '@/lib/provider-error-response';
import { EmptyContentError, ProviderError } from '@/lib/providers/errors';
import { getModel } from '@/config/models';

export const runtime = 'nodejs';
// A turn can be several model calls (shared-search tool rounds + validation
// retries) on a slow reasoning model. 300s is the Vercel Hobby maximum with Fluid
// Compute; the old 60s cap silently killed Grok turns mid-flight.
export const maxDuration = 300;

// Soft deadline, safely inside maxDuration: if a turn runs this long we stop
// waiting and RECORD the cause, rather than letting the platform kill the
// function (which leaves no trace and just stops the run).
const TURN_SOFT_DEADLINE_MS = 270_000;

function withTurnDeadline<T>(work: Promise<T>, modelId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const model = getModel(modelId);
      reject(
        new ProviderError(
          `${model?.displayName ?? modelId} did not finish the turn within ${Math.round(
            TURN_SOFT_DEADLINE_MS / 1000,
          )}s (model too slow or not responding). Switch this participant's model or press Continue to retry.`,
          { provider: model?.provider ?? 'unknown', failureClass: 'fatal', status: 504 },
        ),
      );
    }, TURN_SOFT_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  // Closed (finished, or Stop & close): never generate another turn.
  if (session.status === 'complete') {
    return NextResponse.json({
      complete: true,
      turn: null,
      totalWords: session.totalWords,
      totalCostUsd: session.totalCostUsd,
    });
  }

  // Budget cap: once actual spend exceeds it, jump straight to closings.
  const budgetExceeded =
    typeof session.config.budgetCapUsd === 'number' &&
    session.totalCostUsd >= session.config.budgetCapUsd;

  const initialPlan = planNextTurn(session.config, session.turns, {
    stopRequested: stopRequested || budgetExceeded,
  });

  // Nothing left to do — the session is already complete.
  if (!initialPlan) {
    return NextResponse.json({
      complete: true,
      turn: null,
      totalWords: session.totalWords,
      totalCostUsd: session.totalCostUsd,
    });
  }

  let activePlan = initialPlan;
  let executed;
  try {
    executed = await withTurnDeadline(
      executeTurn(session.config, session.turns, activePlan),
      activePlan.modelId,
    );
    // Interjection returned [SKIP] (null): fall through to the next full turn
    // in the same request — no empty response, no re-roll loop (A-1).
    if (executed === null) {
      const fallthrough = planNextTurn(session.config, session.turns, {
        stopRequested: stopRequested || budgetExceeded,
        suppressInterjection: true,
      });
      if (!fallthrough) {
        return NextResponse.json({
          complete: true,
          turn: null,
          totalWords: session.totalWords,
          totalCostUsd: session.totalCostUsd,
        });
      }
      activePlan = fallthrough;
      executed = await withTurnDeadline(
        executeTurn(session.config, session.turns, activePlan),
        activePlan.modelId,
      );
    }
  } catch (err) {
    // An error never becomes a turn — nothing is persisted (P0-2 §1). Record the
    // cause on the session so it's tracked across reloads and on the dashboard.
    const { status, body } = providerErrorPayload(err, {
      agentId: activePlan.speakerId,
      agentName: activePlan.speakerDisplayName,
      modelId: activePlan.modelId,
    });
    await setSessionError(sessionId, {
      message: body.error,
      code: body.code,
      failureClass: body.failureClass,
      provider: body.provider,
      agentName: body.agentName,
      model: body.model,
      turnIndex: session.turns.length,
      at: new Date().toISOString(),
    });
    return NextResponse.json(body, { status });
  }

  // A full turn must never be stored empty (P0-2 §6). Interjections are
  // legitimately short, so the floor applies only to full turns; executeTurn
  // already returns null for a [SKIP]/blank interjection.
  if (executed !== null && executed.turnClass === 'full' && executed.text.trim().length < 20) {
    const { status, body } = providerErrorPayload(
      new EmptyContentError(executed.modelId, executed.speakerDisplayName),
      {
        agentId: executed.speakerId,
        agentName: executed.speakerDisplayName,
        modelId: executed.modelId,
      },
    );
    await setSessionError(sessionId, {
      message: body.error,
      code: body.code,
      failureClass: body.failureClass,
      provider: body.provider,
      agentName: body.agentName,
      model: body.model,
      turnIndex: session.turns.length,
      at: new Date().toISOString(),
    });
    return NextResponse.json(body, { status });
  }
  // Both interjection attempt and its fallthrough skipped (very unlikely).
  if (executed === null) {
    return NextResponse.json({
      complete: false,
      turn: null,
      totalWords: session.totalWords,
      totalCostUsd: session.totalCostUsd,
    });
  }

  const index = session.turns.length;
  const words = countWords(executed.text);
  const totalWords = session.totalWords + words;
  const totalCostUsd = session.totalCostUsd + executed.costUsd;

  // Is this the last turn? Re-plan with the new turn included (interjections
  // never end a session, so suppress them for the completion check).
  const provisionalTurn = { ...executed, index };
  const nextPlan = planNextTurn(
    session.config,
    [...session.turns, provisionalTurn],
    { suppressInterjection: true },
  );
  const complete = nextPlan === null;
  const status = complete ? 'complete' : 'running';

  // Stop & close may have landed while this turn was generating. The session is
  // closed as it stood at that moment — discard this turn rather than append it.
  if ((await getSessionStatus(sessionId)) === 'complete') {
    return NextResponse.json({
      complete: true,
      turn: null,
      discarded: true,
      totalWords: session.totalWords,
      totalCostUsd: session.totalCostUsd,
    });
  }

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
