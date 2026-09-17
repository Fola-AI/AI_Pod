// Claims checklist (PRD §13.3). A single post-session call to a frontier model
// that extracts every statistic, date, named study, and quotation so the
// operator can verify before publishing. Deliberately simple.

import type { Claim, ClaimConflict, Session } from '@/lib/types';
import { MODELS, getModel } from '@/config/models';
import { getAdapter, isProviderAvailable, withRetry } from '@/lib/providers';

export type { Claim, ClaimConflict };

const CLAIM_TYPES = ['statistic', 'date', 'study', 'person', 'quote'] as const;

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

const EXTRACTION_SYSTEM = `You extract checkable factual claims from a discussion transcript so a human can fact-check them before publishing, and you flag claims that contradict each other.

CLAIMS. Extract every: statistic or number presented as fact; specific date or year; named study, report, book, or source; named individual (a real person referenced by name); and direct quotation attributed to a real person or organisation. Do NOT extract opinions, predictions, rhetorical questions, or general statements — only concrete, verifiable claims.

CONFLICTS. Then find every case where DIFFERENT values are given for the SAME quantity — the same metric over the same period or scope (e.g. "452 GW" and "593 GW" both for global solar capacity added in 2024). Check across two sources of numbers: (1) different speakers' spoken claims, and (2) a speaker's spoken figure versus a value in the sources that same turn retrieved (lines labelled "[Turn N sources]"). The second is the important one: a speaker citing 452 GW while their own retrieved source says 593 GW is a conflict worth flagging.

Only flag GENUINE disagreements: the values must actually differ. If every value for a quantity is the same number, that is agreement, not a conflict — do NOT flag it. Do not flag different quantities that merely appear near each other. For each conflict, describe the quantity plainly and list every differing value with its speaker and turnIndex (use the turn the number appeared in; for a source value, the turn whose sources contained it).

Each turn is labelled "[Turn N] Speaker:"; its retrieved sources, if any, follow as "[Turn N sources]". Extract CLAIMS only from spoken turns, never from the source lines. Record the turn number as turnIndex and the speaker's name.

Respond with ONLY a JSON object, no prose, no code fences:
{"claims":[{"type":"statistic|date|study|person|quote|other","claim":"the exact claim, quoted or closely paraphrased","speaker":"name","turnIndex":N}],
"conflicts":[{"quantity":"what the values measure","values":[{"value":"452 GW","speaker":"name","turnIndex":N},{"value":"593 GW","speaker":"name","turnIndex":N}]}]}
Use empty arrays where there is nothing to report.`;

/**
 * Transcript with explicit turn indices so the model can attribute each claim.
 * A turn's retrieved search snippets are appended as "[Turn N sources]" so the
 * model can flag a spoken figure that conflicts with a source that turn actually
 * pulled (B-5.5, e.g. a speaker says 452 GW while their own source says 593 GW).
 */
function renderIndexedTranscript(session: Session): string {
  if (session.turns.length === 0) return '(No turns.)';
  return session.turns
    // Banter is small talk before the topic — no checkable claims live there.
    .filter((t) => t.turnType !== 'banter' && t.turnType !== 'moderator-banter')
    .map((t) => {
      let block = `[Turn ${t.index}] ${t.speakerDisplayName}: ${t.text}`;
      const snippets = (t.searches ?? [])
        .flatMap((s) => s.results.map((r) => r.snippet))
        .filter((s) => s && s.trim())
        .slice(0, 6);
      if (snippets.length) {
        block += `\n[Turn ${t.index} sources] ${snippets.join(' | ')}`;
      }
      return block;
    })
    .join('\n\n');
}

function mapClaim(c: any): Claim | null {
  if (!c || typeof c.claim !== 'string') return null;
  return {
    type: (CLAIM_TYPES as readonly string[]).includes(c.type)
      ? (c.type as Claim['type'])
      : 'other',
    claim: String(c.claim),
    speaker: c.speaker ? String(c.speaker) : undefined,
    turnIndex:
      typeof c.turnIndex === 'number' && Number.isFinite(c.turnIndex)
        ? c.turnIndex
        : undefined,
  };
}

function mapConflict(c: any): ClaimConflict | null {
  if (!c || !Array.isArray(c.values)) return null;
  const values = c.values
    .filter((v: any) => v && (v.value !== undefined))
    .map((v: any) => ({
      value: String(v.value),
      speaker: v.speaker ? String(v.speaker) : undefined,
      turnIndex:
        typeof v.turnIndex === 'number' && Number.isFinite(v.turnIndex)
          ? v.turnIndex
          : undefined,
    }));
  if (values.length < 2) return null; // a conflict needs at least two values
  // Guard against the model flagging repeated identical values as a "conflict":
  // require at least two genuinely different values (ignoring case/spacing).
  const norm = (v: string) => v.toLowerCase().replace(/[\s,]/g, '');
  const distinct = new Set(values.map((v: { value: string }) => norm(v.value)));
  if (distinct.size < 2) return null;
  return { quantity: c.quantity ? String(c.quantity) : '(unspecified quantity)', values };
}

// Scan out every top-level {...} object from a string, respecting quotes and
// escapes. Tolerant of a truncated tail (an unclosed final object is dropped),
// so we can salvage claims from output that hit the token cap.
function scanObjects(s: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          /* skip a malformed object */
        }
        start = -1;
      }
    }
  }
  return out;
}

export function parseExtraction(text: string): {
  claims: Claim[];
  conflicts: ClaimConflict[];
} {
  let t = text.trim();
  // Strip code fences if the model added them despite instructions.
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const objStart = t.indexOf('{');
  const arrStart = t.indexOf('[');
  const useObject = objStart !== -1 && (arrStart === -1 || objStart < arrStart);

  // Fast path: parse the whole structure when it's well-formed.
  try {
    if (useObject) {
      const obj = JSON.parse(t.slice(objStart, t.lastIndexOf('}') + 1));
      if (Array.isArray(obj?.claims)) {
        return {
          claims: obj.claims.map(mapClaim).filter(Boolean) as Claim[],
          conflicts: Array.isArray(obj?.conflicts)
            ? (obj.conflicts.map(mapConflict).filter(Boolean) as ClaimConflict[])
            : [],
        };
      }
    } else if (arrStart !== -1) {
      const arr = JSON.parse(t.slice(arrStart, t.lastIndexOf(']') + 1));
      if (Array.isArray(arr)) {
        return { claims: arr.map(mapClaim).filter(Boolean) as Claim[], conflicts: [] };
      }
    }
  } catch {
    /* fall through to salvage */
  }

  // Salvage path (e.g. output truncated at the token cap): pull complete objects
  // from the claims section and the conflicts section separately.
  const claimsKey = t.search(/"claims"\s*:\s*\[/);
  const conflictsKey = t.search(/"conflicts"\s*:\s*\[/);
  const claimsRegion =
    claimsKey === -1
      ? t
      : t.slice(claimsKey, conflictsKey > claimsKey ? conflictsKey : undefined);
  const conflictsRegion = conflictsKey === -1 ? '' : t.slice(conflictsKey);
  const claims = scanObjects(claimsRegion).map(mapClaim).filter(Boolean) as Claim[];
  const conflicts = scanObjects(conflictsRegion)
    .map(mapConflict)
    .filter(Boolean) as ClaimConflict[];
  return { claims, conflicts };
}

export async function extractClaims(
  session: Session,
): Promise<{ claims: Claim[]; conflicts: ClaimConflict[] }> {
  const modelId = pickExtractionModel(session);
  if (!modelId) {
    throw new Error('No available model to extract claims. Add a provider key.');
  }
  const model = getModel(modelId)!;
  const adapter = getAdapter(model.provider);

  const transcript = renderIndexedTranscript(session);
  const result = await withRetry(() =>
    adapter.generate({
      apiModelString: model.apiModelString,
      systemPrompt: EXTRACTION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Extract the checkable claims and flag any conflicting values from this transcript:\n\n${transcript}`,
        },
      ],
      temperature: 0,
      maxTokens: 6000,
    }),
  );

  return parseExtraction(result.text);
}
