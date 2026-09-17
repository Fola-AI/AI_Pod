// Voice pass (Part B). A post-session step: one frontier model receives the full
// transcript and returns it with ElevenLabs v3 audio tags inserted. The result
// is stored per turn as `taggedText`, never overwriting `text`. Every turn is
// verified: stripping the tags must reproduce the original spoken words exactly,
// or the tags are discarded for that turn (the tagger must never alter a word).

import type { Session } from '@/lib/types';
import { MODELS, getModel } from '@/config/models';
import { getAdapter, isProviderAvailable, withRetry } from '@/lib/providers';

export interface TaggedTurn {
  index: number;
  taggedText: string; // tags applied if verified; otherwise the plain text
  verified: boolean; // whether stripping tags reproduced the original words
}

export interface VoicePassResult {
  turns: TaggedTurn[];
  verified: number;
  failed: number;
  tagCount: number;
  wordCount: number;
}

// B-3 voice pass prompt (verbatim), plus a JSON output contract so each turn maps
// back cleanly and can be verified.
const VOICE_PASS_SYSTEM = `You are preparing a podcast transcript for text-to-speech synthesis with ElevenLabs v3. Insert audio tags that direct vocal performance.

Available tags:
Emotions: [excited] [curious] [nervous] [frustrated] [calm] [sad]
          [happily] [sarcastic] [mischievously] [thoughtful]
Reactions: [laughs] [laughs harder] [giggles] [sighs] [gasps]
           [clears throat]
Delivery: [whispers] [dramatically] [deadpan] [flatly] [playfully]
Beats: [pauses] [hesitates]

RULES
- Tag sparingly. Most sentences need no tag at all. Over-tagging makes
  speech sound theatrical and fake. Aim for roughly one tag per 40-60
  words, fewer in serious passages.
- Place a tag immediately before the words it governs.
- Only tag a laugh where something was actually funny. A laugh on a
  flat line is the single most obvious tell that audio was generated.
- Match tags to character. A dry, precise speaker does not giggle.
  A warm speaker does not stay deadpan throughout.
- Use [pauses] before a genuinely weighty line, not as decoration.
- Never use SSML break tags. They are not supported.
- Never add, remove, or reword any spoken text. Tags only.
- Return the transcript in exactly the same speaker-tagged structure
  you received.

Serious subject matter takes fewer tags, not more. If a passage
concerns harm, loss, or anything a listener might be personally
affected by, leave it plain.

OUTPUT FORMAT
Respond with ONLY a JSON array, no prose, no code fences. One object per input
turn, in order: {"turnIndex": N, "taggedText": "the same words, with tags"}.
The taggedText must contain every original word unchanged and in order — only
bracketed [tags] may be added.`;

const TAG_RE = /\[[^\]]+\]/g;

/** Remove [tags] and normalise whitespace, for comparison and counting. */
export function stripAudioTags(s: string): string {
  return s.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** True when the tagged text is the original words plus only bracketed tags. */
export function isFaithfullyTagged(original: string, tagged: string): boolean {
  return stripAudioTags(tagged) === normalise(original);
}

export function countTags(s: string): number {
  return (s.match(TAG_RE) || []).length;
}

function pickTaggerModel(session: Session): string | null {
  const preferred = getModel(session.config.moderator.modelId);
  if (preferred && isProviderAvailable(preferred.provider)) return preferred.id;
  const frontier = MODELS.find(
    (m) => m.tier === 'frontier' && m.enabled && isProviderAvailable(m.provider),
  );
  if (frontier) return frontier.id;
  return MODELS.find((m) => m.enabled && isProviderAvailable(m.provider))?.id ?? null;
}

function parseTagged(text: string): { turnIndex: number; taggedText: string }[] {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o) => o && typeof o.taggedText === 'string' && Number.isFinite(o.turnIndex))
      .map((o) => ({ turnIndex: Number(o.turnIndex), taggedText: String(o.taggedText) }));
  } catch {
    return [];
  }
}

export async function runVoicePass(session: Session): Promise<VoicePassResult> {
  const modelId = pickTaggerModel(session);
  if (!modelId) throw new Error('No available model for the voice pass. Add a provider key.');
  const model = getModel(modelId)!;
  const adapter = getAdapter(model.provider);

  const input = session.turns.map((t) => ({
    turnIndex: t.index,
    speaker: t.speakerDisplayName,
    text: t.text,
  }));

  const result = await withRetry(() =>
    adapter.generate({
      apiModelString: model.apiModelString,
      systemPrompt: VOICE_PASS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Tag this transcript for ElevenLabs v3:\n\n${JSON.stringify(input, null, 2)}`,
        },
      ],
      temperature: 0.3,
      maxTokens: Math.max(2000, session.totalWords * 3),
    }),
  );

  const byIndex = new Map(parseTagged(result.text).map((o) => [o.turnIndex, o.taggedText]));

  let verified = 0;
  let failed = 0;
  let tagCount = 0;
  const wordCount = session.totalWords;

  const turns: TaggedTurn[] = session.turns.map((t) => {
    const candidate = byIndex.get(t.index);
    // Only keep tags that provably preserve every spoken word; else store plain.
    if (candidate && isFaithfullyTagged(t.text, candidate)) {
      verified++;
      tagCount += countTags(candidate);
      return { index: t.index, taggedText: candidate, verified: true };
    }
    failed++;
    return { index: t.index, taggedText: t.text, verified: false };
  });

  return { turns, verified, failed, tagCount, wordCount };
}
