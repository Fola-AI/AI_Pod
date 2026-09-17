import { NextResponse } from 'next/server';
import { getSession, setTaggedTexts } from '@/lib/db/queries';
import { runVoicePass } from '@/lib/voice-pass';
import { MissingKeyError, ProviderError } from '@/lib/providers/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Voice pass (B-1): tag a completed transcript for ElevenLabs v3, verify each
// turn preserves its spoken words, and persist taggedText per turn. Re-runnable.
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.turns.length === 0) {
    return NextResponse.json({ error: 'Nothing to tag' }, { status: 400 });
  }

  try {
    const result = await runVoicePass(session);
    await setTaggedTexts(
      id,
      result.turns.map((t) => ({ index: t.index, taggedText: t.taggedText })),
    );
    const updated = await getSession(id);
    return NextResponse.json({
      verified: result.verified,
      failed: result.failed,
      tagCount: result.tagCount,
      wordCount: result.wordCount,
      tagsPerWords: result.tagCount
        ? Math.round(result.wordCount / result.tagCount)
        : 0,
      turns: updated?.turns ?? [],
    });
  } catch (err) {
    if (err instanceof MissingKeyError || err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
