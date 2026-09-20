import { describe, it, expect } from 'vitest';
import { trimToLastSentence } from './execute-turn';

describe('trimToLastSentence (rule 2 — never export mid-sentence)', () => {
  it('cuts a trailing comma-ended fragment back to the last complete sentence (the Zoe case)', () => {
    const cut = trimToLastSentence(
      "Ada says the drop is friction. Linux went public in 1991. IBM didn't buy Red Hat until 2019,",
    );
    expect(cut.endsWith('.')).toBe(true);
    expect(cut.endsWith('2019,')).toBe(false);
    expect(cut).toContain('1991.');
    expect(cut).not.toContain('2019');
  });

  it('keeps a clean sentence unchanged', () => {
    const s = 'This is a complete, finished thought.';
    expect(trimToLastSentence(s)).toBe(s);
  });

  it('preserves a closing quote after the punctuation', () => {
    const s = 'She said "we are done."';
    expect(trimToLastSentence(s)).toBe(s);
  });

  it('returns empty when there is no complete sentence to salvage', () => {
    expect(trimToLastSentence('just a dangling fragment with no ending')).toBe('');
  });

  it('returns empty when the only sentence is too short to be usable', () => {
    expect(trimToLastSentence('Yes.')).toBe('');
  });
});
