import { NextResponse } from 'next/server';
import { createSession, listSessions } from '@/lib/db/queries';
import {
  createSessionSchema,
  toSessionConfig,
  validateReferences,
} from '@/lib/validation';
import { hasSearchKey, preflightSearch } from '@/lib/search';
import { attachPersonaSnapshots } from '@/lib/db/personas';
import { buildResearchPack } from '@/lib/search/research-pack';
import { modelSupportsFunctionCalling } from '@/config/models';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const sessions = await listSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const refErrors = validateReferences(parsed.data);
  if (refErrors.length > 0) {
    return NextResponse.json(
      { error: refErrors.join(' ') },
      { status: 400 },
    );
  }

  const ws = parsed.data.webSearch;
  const mode = ws?.mode ?? 'shared';
  const wantsResearchPack =
    mode !== 'none' &&
    (ws?.researchPack === true ||
      (mode === 'shared' &&
        parsed.data.agents.some((a) => !modelSupportsFunctionCalling(a.modelId))));

  // Pre-flight: shared search (and any research pack) needs the Brave key.
  if (mode === 'shared' || wantsResearchPack) {
    if (!hasSearchKey()) {
      const pf = await preflightSearch();
      return NextResponse.json({ error: pf.message }, { status: 400 });
    }
    const pf = await preflightSearch();
    if (!pf.ok) {
      return NextResponse.json({ error: pf.message }, { status: 400 });
    }
  }

  try {
    const config = toSessionConfig(parsed.data);
    // Snapshot each agent's persona text now, so the session replays from what
    // it was given and later persona edits never rewrite this transcript (B-6).
    await attachPersonaSnapshots(config);
    // Build the research brief before turn 1 when the session needs it.
    if (wantsResearchPack) {
      const pack = await buildResearchPack(config.topic, {
        title: config.title,
        resultsPerSearch: config.webSearch?.resultsPerSearch ?? 3,
      });
      if (pack.brief) config.researchPack = pack.brief;
    }
    const session = await createSession(config);
    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
