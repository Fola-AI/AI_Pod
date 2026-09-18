import { describe, it, expect } from 'vitest';
import { parseColdOpen } from '@/lib/cold-open';

describe('parseColdOpen', () => {
  it('parses a well-formed object', () => {
    const o = parseColdOpen(
      '{"turnIndex":6,"speaker":"Gretchen","text":"Count the electricity, not the panels.","reason":"sharp reframe"}',
    );
    expect(o).toEqual({
      turnIndex: 6,
      speaker: 'Gretchen',
      text: 'Count the electricity, not the panels.',
      reason: 'sharp reframe',
    });
  });
  it('tolerates code fences and missing optional fields', () => {
    const o = parseColdOpen('```json\n{"speaker":"Sol","text":"452 gigawatts."}\n```');
    expect(o?.text).toBe('452 gigawatts.');
    expect(o?.turnIndex).toBeUndefined();
  });
  it('returns null on empty text or garbage', () => {
    expect(parseColdOpen('{"speaker":"X","text":""}')).toBeNull();
    expect(parseColdOpen('not json')).toBeNull();
  });
});
