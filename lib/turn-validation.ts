// Turn validator (P0-1 §4). Runs before a turn is accepted: rejects empty
// content and content the provider cut off (either a max_tokens stop reason or
// text that doesn't end on sentence-final punctuation).

export type TurnValidation =
  | { valid: true }
  | { valid: false; reason: 'truncated' | 'empty' };

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
  return { valid: true };
}
