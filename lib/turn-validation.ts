// Turn validator (P0-1 §4). Runs before a turn is accepted: rejects empty
// content, content the provider cut off (a max_tokens stop reason or text that
// doesn't end on sentence-final punctuation), and process narration that leaked
// the model's reasoning into spoken dialogue (B-5.5).

export type TurnValidation =
  | { valid: true }
  | { valid: false; reason: 'truncated' | 'empty' | 'meta' };

// High-precision markers of a model narrating its own process instead of
// speaking. These would go straight into a video edit, so we reject and retry.
// Kept deliberately specific to avoid catching legitimate first-person speech.
const META_PATTERNS: RegExp[] = [
  /\bsearch results?\b/i,
  /\bthe results\b[^.?!]*\b(show|showed|indicate|suggest|vary|variation)\b/i,
  /\bdepending on (the |which )?sources?\b/i,
  /\bone source\b[^.?!]*\b(mention|say|put|note|claim|list|give|suggest|indicate)s?\b/i,
  /\bwhich (figure|number|source|statistic|data ?point) to (use|cite|pick|choose|go with|report)\b/i,
  /\b(compose|draft|formulate|structure|frame) (my|the|a) (closing|opening|statement|response|answer|argument|point)\b/i,
  /\bnow I('?ll| will|'m going to| am going to)\b[^.?!]*\b(compose|write|draft|give|state|make|deliver|structure|frame|say|share)\b/i,
  /\bI('?ll| will| can|'d| would) (use|work with|go with|stick with|anchor to|rely on) (that|the|this)\b[^.?!]*\b(figure|number|statistic|source|estimate|data ?point)\b/i,
  /\blet me (compose|draft|write|structure|frame|think about how)\b/i,
];

export function hasMetaCommentary(text: string): boolean {
  return META_PATTERNS.some((re) => re.test(text));
}

export function validateTurn(
  text: string,
  stopReason: string,
): TurnValidation {
  const trimmed = text.trim();
  if (trimmed.length < 20) return { valid: false, reason: 'empty' };
  if (stopReason === 'max_tokens') return { valid: false, reason: 'truncated' };
  // Must end on . ! ? or … possibly wrapped in a closing quote/bracket.
  if (!/["'')\]]*[.!?…]["'')\]]*$/.test(trimmed)) {
    return { valid: false, reason: 'truncated' };
  }
  if (hasMetaCommentary(trimmed)) return { valid: false, reason: 'meta' };
  return { valid: true };
}
