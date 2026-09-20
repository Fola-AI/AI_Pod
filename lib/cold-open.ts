// Cold-open candidate pass (B-6, A-7). One post-session frontier call over the
// full transcript: find the single most compelling 15-30 seconds — a surprising
// claim, a sharp exchange, or a funny moment — and return the exact speaker and
// text span. Shown at the top of the transcript and included in the JSON export.

import type { ColdOpen, Session } from '@/lib/types';
import { MODELS, getModel } from '@/config/models';
import { getAdapter, isModelAvailable, withRetry } from '@/lib/providers';

function pickModel(session: Session): string | null {
  const preferred = getModel(session.config.moderator.modelId);
  if (preferred && isModelAvailable(preferred)) return preferred.id;
  const frontier = MODELS.find(
    (m) => m.tier === 'frontier' && m.enabled && isModelAvailable(m),
  );
  if (frontier) return frontier.id;
  return MODELS.find((m) => m.enabled && isModelAvailable(m))?.id ?? null;
}

const SYSTEM = `You choose the cold open for a podcast episode — the single clip that plays before the intro to make someone want to listen.

From the transcript, pick the most compelling 15 to 30 seconds (roughly 35-80 spoken words): a surprising claim, a sharp exchange, a vivid line, or a genuinely funny moment. It should stand on its own out of context and create a question the listener wants answered. Do NOT default to the opening line or the moderator's introduction — those are the worst cold opens. Prefer a moment from the body of the discussion.

Each turn is labelled "[Turn N] Speaker:". Return the span exactly as spoken (you may trim to a clean sentence boundary, but do not paraphrase or add words).

Respond with ONLY a JSON object, no prose, no code fences:
{"turnIndex": N, "speaker": "the speaker name", "text": "the exact span", "reason": "one short clause on why it works"}`;

function renderTranscript(session: Session): string {
  return session.turns
    .filter((t) => t.turnType !== 'moderator-banter' && t.turnType !== 'banter')
    .map((t) => `[Turn ${t.index}] ${t.speakerDisplayName}: ${t.text}`)
    .join('\n\n');
}

export function parseColdOpen(text: string): ColdOpen | null {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const o = JSON.parse(t.slice(start, end + 1));
    if (!o || typeof o.text !== 'string' || !o.text.trim()) return null;
    return {
      speaker: o.speaker ? String(o.speaker) : '',
      text: String(o.text).trim(),
      turnIndex:
        typeof o.turnIndex === 'number' && Number.isFinite(o.turnIndex)
          ? o.turnIndex
          : undefined,
      reason: o.reason ? String(o.reason) : undefined,
    };
  } catch {
    return null;
  }
}

export async function findColdOpen(session: Session): Promise<ColdOpen | null> {
  const modelId = pickModel(session);
  if (!modelId) throw new Error('No available model for the cold-open pass. Add a provider key.');
  const model = getModel(modelId)!;
  const adapter = getAdapter(model.provider, model.route);
  const transcript = renderTranscript(session);
  const ask = (reminder: string) =>
    withRetry(() =>
      adapter.generate({
        apiModelString: model.apiModelString,
        systemPrompt: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Pick the cold open from this transcript:\n\n${transcript}${reminder}`,
          },
        ],
        temperature: 0,
        maxTokens: 600,
      }),
    );
  // withRetry covers thrown errors; a successful-but-unparseable response (the
  // model returned prose, not the JSON object) is not an error, so retry once
  // more here with a firmer reminder before giving up.
  let parsed = parseColdOpen((await ask('')).text);
  if (!parsed) {
    parsed = parseColdOpen(
      (await ask('\n\nRespond with ONLY the JSON object described above.')).text,
    );
  }
  return parsed;
}
