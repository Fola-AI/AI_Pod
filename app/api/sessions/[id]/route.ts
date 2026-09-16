import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deleteSession,
  getSession,
  updateSessionConfig,
} from '@/lib/db/queries';
import { getModel } from '@/config/models';

export const runtime = 'nodejs';

const patchSchema = z.union([
  z.object({
    action: z.literal('substitute'),
    agentId: z.string(),
    modelId: z.string(),
  }),
  z.object({ action: z.literal('remove'), agentId: z.string() }),
]);

// Mid-session recovery (P0-2 §4): substitute a failing agent's model, or remove
// the agent. Earlier turns stay in the transcript; only the moderator roster and
// the rotation change (P0 addition #2).
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const config = session.config;

  if (parsed.data.action === 'substitute') {
    if (!getModel(parsed.data.modelId)) {
      return NextResponse.json({ error: 'Unknown model' }, { status: 400 });
    }
    if (parsed.data.agentId === 'moderator') {
      config.moderator.modelId = parsed.data.modelId;
    } else {
      const agent = config.agents.find((a) => a.id === parsed.data.agentId);
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      agent.modelId = parsed.data.modelId;
    }
  } else {
    if (parsed.data.agentId === 'moderator') {
      return NextResponse.json(
        { error: 'The moderator cannot be removed.' },
        { status: 400 },
      );
    }
    const remaining = config.agents.filter(
      (a) => a.id !== parsed.data.agentId,
    );
    if (remaining.length < 1) {
      return NextResponse.json(
        { error: 'Cannot remove the last participant.' },
        { status: 400 },
      );
    }
    config.agents = remaining;
    config.agentCount = remaining.length;
  }

  await updateSessionConfig(id, config);
  const updated = await getSession(id);
  return NextResponse.json({ session: updated });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    await deleteSession(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
