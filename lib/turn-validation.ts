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
  // Referring to a source/research artifact as something the speaker consulted.
  /\bsearch results?\b/i,
  /\bthe results\b[^.?!]*\b(show|showed|indicate|suggest|vary|variation)\b/i,
  /\bdepending on (the |which )?sources?\b/i,
  /\bone source\b[^.?!]*\b(mention|say|put|note|claim|list|give|suggest|indicate)s?\b/i,
  /\bmy sources?\b/i,
  // Naming a source TYPE as consulted, e.g. "the Wikipedia source says…".
  /\bthe (wikipedia|encycloped\w*|internet|online|web) sources?\b/i,
  /\bthe \w+ source\s+(say|says|said|shows?|showed|puts?|gave|gives|lists?|mentions?|indicates?)\b/i,
  /\bwhich (figure|number|source|statistic|data ?point) to (use|cite|pick|choose|go with|report)\b/i,
  // Announcing what the speaker is about to say/compose.
  /\b(compose|draft|formulate|structure|frame) (my|the|a) (closing|opening|statement|response|answer|argument|point)\b/i,
  /\bnow I('?ll| will|'m going to| am going to)\b[^.?!]*\b(compose|write|draft|give|state|make|deliver|structure|frame|say|share)\b/i,
  /\bI('?ll| will| can|'d| would) (use|work with|go with|stick with|anchor to|rely on) (that|the|this)\b[^.?!]*\b(figure|number|statistic|source|estimate|data ?point)\b/i,
  /\blet me (compose|draft|write|structure|frame|think about how)\b/i,
  // Announcing an action the speaker is about to perform (recompute, recheck…).
  /\blet me (recalculate|recompute|recheck|re-?check|redo|rework|revise|correct|verify|double-?check|reconsider|reckon|work (this |it )?out|go back)\b/i,
  /\bI need to (reckon|recalculate|recompute|recheck|re-?check|correct|revise|verify|redo|go back|double-?check)\b/i,
  /\breckon with what I (found|got|have)\b/i,
  /\bspeak honestly about what (changed|i found|happened)\b/i,
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
