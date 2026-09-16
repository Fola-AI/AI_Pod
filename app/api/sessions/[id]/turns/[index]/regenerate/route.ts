import { NextResponse } from 'next/server';
import {
  getSession,
  replaceTurn,
  markTurnsStaleAfter,
  recomputeAggregates,
} from '@/lib/db/queries';
import { planFromStoredTurn } from '@/lib/orchestrator';
import { executeTurn } from '@/lib/execute-turn';
import { providerErrorPayload } from '@/lib/provider-error-response';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Re-run a single turn with the same context and role. Subsequent turns become
// stale (their context has changed) and can be regenerated in turn.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const idx = Number(index);

  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const existing = session.turns.find((t) => t.index === idx);
  if (!existing) {
    return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
  }

  const plan = planFromStoredTurn(session.config, existing);
  const priorTurns = session.turns.filter((t) => t.index < idx);

  let executed;
  try {
    executed = await executeTurn(session.config, priorTurns, plan);
  } catch (err) {
    const { status, body } = providerErrorPayload(err, {
      agentId: plan.speakerId,
      agentName: plan.speakerDisplayName,
      modelId: plan.modelId,
    });
    return NextResponse.json(body, { status });
  }

  try {
    await replaceTurn(id, idx, {
      text: executed.text,
      inputTokens: executed.inputTokens,
      outputTokens: executed.outputTokens,
      costUsd: executed.costUsd,
      latencyMs: executed.latencyMs,
      wasTruncated: executed.wasTruncated,
      modelId: executed.modelId,
    });
    await markTurnsStaleAfter(id, idx);
    const totals = await recomputeAggregates(id);
    const updated = await getSession(id);
    return NextResponse.json({
      ok: true,
      ...totals,
      turns: updated?.turns ?? [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
