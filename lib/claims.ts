// Claims checklist (PRD §13.3). A single post-session call to a frontier model
// that extracts every statistic, date, named study, and quotation so the
// operator can verify before publishing. Deliberately simple.

import type { Session } from '@/lib/types';
import { MODELS, getModel } from '@/config/models';
import { getAdapter, isProviderAvailable, withRetry } from '@/lib/providers';
import { renderTranscript } from '@/lib/prompts';

export interface Claim {
  type: 'statistic' | 'date' | 'study' | 'quote' | 'other';
  claim: string;
  speaker?: string;
}

/** Pick a capable, available model to run extraction with. */
function pickExtractionModel(session: Session): string | null {
  // Prefer the moderator's model if usable, else the best available frontier.
  const preferred = getModel(session.config.moderator.modelId);
  if (preferred && isProviderAvailable(preferred.provider)) return preferred.id;

  const frontier = MODELS.find(
    (m) => m.tier === 'frontier' && m.enabled && isProviderAvailable(m.provider),
  );
  if (frontier) return frontier.id;

  const any = MODELS.find((m) => m.enabled && isProviderAvailable(m.provider));
  return any?.id ?? null;
}

const EXTRACTION_SYSTEM = `You extract checkable factual claims from a discussion transcript so a human can fact-check them before publishing.

Extract every: statistic or number presented as fact; specific date or year; named study, report, book, or source; and direct quotation attributed to a real person or organisation.

Do NOT extract opinions, predictions, rhetorical questions, or general statements. Only concrete, verifiable claims.

Respond with ONLY a JSON array, no prose, no code fences. Each item:
{"type":"statistic|date|study|quote|other","claim":"the exact claim, quoted or closely paraphrased","speaker":"the speaker name"}
If there are no checkable claims, return [].`;

function parseClaims(text: string): Claim[] {
  let t = text.trim();
  // Strip code fences if the model added them despite instructions.
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.claim === 'string')
      .map((c) => ({
        type: ['statistic', 'date', 'study', 'quote'].includes(c.type)
          ? c.type
          : 'other',
        claim: String(c.claim),
        speaker: c.speaker ? String(c.speaker) : undefined,
      }));
  } catch {
    return [];
  }
}

export async function extractClaims(session: Session): Promise<Claim[]> {
  const modelId = pickExtractionModel(session);
  if (!modelId) {
    throw new Error('No available model to extract claims. Add a provider key.');
  }
  const model = getModel(modelId)!;
  const adapter = getAdapter(model.provider);

  const transcript = renderTranscript(session.turns);
  const result = await withRetry(() =>
    adapter.generate({
      apiModelString: model.apiModelString,
      systemPrompt: EXTRACTION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Extract the checkable claims from this transcript:\n\n${transcript}`,
        },
      ],
      temperature: 0,
      maxTokens: 2000,
    }),
  );

  return parseClaims(result.text);
}
