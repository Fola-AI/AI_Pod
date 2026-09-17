import { describe, it, expect } from 'vitest';
import { parseExtraction } from '@/lib/claims';

describe('parseExtraction', () => {
  it('parses claims and conflicts from the object form', () => {
    const text = JSON.stringify({
      claims: [
        { type: 'statistic', claim: '452 GW added in 2024', speaker: 'Sol', turnIndex: 1 },
        { type: 'statistic', claim: '593 GW added in 2024', speaker: 'Deepa', turnIndex: 3 },
      ],
      conflicts: [
        {
          quantity: 'global solar capacity added in 2024',
          values: [
            { value: '452 GW', speaker: 'Sol', turnIndex: 1 },
            { value: '593 GW', speaker: 'Deepa', turnIndex: 3 },
          ],
        },
      ],
    });
    const { claims, conflicts } = parseExtraction(text);
    expect(claims).toHaveLength(2);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].quantity).toMatch(/solar capacity added in 2024/);
    expect(conflicts[0].values.map((v) => v.turnIndex)).toEqual([1, 3]);
  });

  it('tolerates code fences', () => {
    const text = '```json\n{"claims":[{"type":"date","claim":"2025"}],"conflicts":[]}\n```';
    const { claims, conflicts } = parseExtraction(text);
    expect(claims).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  it('falls back to a bare claims array (no conflicts)', () => {
    const text = '[{"type":"statistic","claim":"8%","turnIndex":2}]';
    const { claims, conflicts } = parseExtraction(text);
    expect(claims).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  it('drops a conflict with fewer than two values', () => {
    const text = JSON.stringify({
      claims: [],
      conflicts: [{ quantity: 'x', values: [{ value: '1 GW', turnIndex: 1 }] }],
    });
    expect(parseExtraction(text).conflicts).toEqual([]);
  });

  it('salvages complete claims from output truncated at the token cap', () => {
    // Array never closes; last object is cut off mid-string.
    const truncated =
      '{"claims":[{"type":"statistic","claim":"452 GW in 2024","speaker":"Sol","turnIndex":1},' +
      '{"type":"date","claim":"2025","speaker":"Deepa","turnIndex":3},' +
      '{"type":"statistic","claim":"this one is cut off mid str';
    const { claims } = parseExtraction(truncated);
    expect(claims).toHaveLength(2); // two complete objects recovered, partial dropped
    expect(claims[1].turnIndex).toBe(3);
  });

  it('returns empty on garbage', () => {
    expect(parseExtraction('not json')).toEqual({ claims: [], conflicts: [] });
  });
});
