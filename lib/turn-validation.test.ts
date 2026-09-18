import { describe, it, expect } from 'vitest';
import { validateTurn, hasMetaCommentary } from '@/lib/turn-validation';

describe('validateTurn meta-commentary detection', () => {
  const leaks = [
    'The search results show some variation in figures. The bottleneck is us.',
    "I'll work with the Ember figure that was already established. Solar is winning.",
    'I can use that established figure. The gap is the moral question.',
    'The growth rate varies (28-30 percent depending on source). It is real.',
    'The IEA says 7 percent, and one source mentions over 10 percent. Fine.',
    'Now I will compose my closing statement. Solar has grown fast.',
    'Let me structure my response. The wires decide how much counts.',
  ];
  for (const t of leaks) {
    it(`flags: "${t.slice(0, 40)}…"`, () => {
      expect(hasMetaCommentary(t)).toBe(true);
      expect(validateTurn(t, 'complete')).toEqual({ valid: false, reason: 'meta' });
    });
  }

  const clean = [
    'Solar has grown 29 percent year after year and still powers barely one day in fourteen.',
    "I'll grant you that a queue is unbuilt projects, not stranded ones.",
    'Now I want to push back on the framing. Curtailment is the real story.',
    'The World Bank put that figure at about 400 gigawatts last year, and it matters.',
    "Ember reported last month that solar overtook coal. That's the headline.",
  ];
  for (const t of clean) {
    it(`passes: "${t.slice(0, 40)}…"`, () => {
      expect(hasMetaCommentary(t)).toBe(false);
      expect(validateTurn(t, 'complete')).toEqual({ valid: true });
    });
  }

  it('still catches empty and truncated first', () => {
    expect(validateTurn('short', 'complete').valid).toBe(false);
    expect(validateTurn('A full sentence that got cut', 'max_tokens')).toEqual({
      valid: false,
      reason: 'truncated',
    });
  });
});

describe('validateTurn meta-commentary — broadened (B-6)', () => {
  const leaks = [
    'I need to reckon with what I found. The Wikipedia source says solar was 8 percent.',
    'Let me recalculate and speak honestly about what changed.',
    'The IEA source says the figure is higher than I thought.',
    'My sources point the other way, so hold on.',
    'Let me recheck that number before I commit to it.',
  ];
  for (const t of leaks) {
    it(`flags: "${t.slice(0, 42)}…"`, () => {
      expect(validateTurn(t, 'complete')).toEqual({ valid: false, reason: 'meta' });
    });
  }
  const clean = [
    'According to Reuters, solar hit a record last year.',
    'The primary source of new demand is data centres, plainly.',
    'Let me be clear about what is at stake here.',
    'I need to push back on that framing, hard.',
  ];
  for (const t of clean) {
    it(`passes: "${t.slice(0, 42)}…"`, () => {
      expect(validateTurn(t, 'complete')).toEqual({ valid: true });
    });
  }
});
