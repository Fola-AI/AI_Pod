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
    expect(parseExtraction('not json')).toEqual({
      claims: [],
      conflicts: [],
      blockingWarnings: [],
    });
  });
});

describe('parseExtraction unit errors + blocking warnings (B-6)', () => {
  it('maps unitErrors into conflicts with kind "unit" and a note', () => {
    const text = JSON.stringify({
      claims: [],
      conflicts: [],
      unitErrors: [
        {
          quantity: 'India solar generation 2025',
          values: [
            { value: '164 TWh (spoken)', speaker: 'Gwen', turnIndex: 14 },
            { value: '164.5 GWh (correct)', turnIndex: 14 },
          ],
          note: '164,542 MWh = 164.5 GWh, not 164 TWh',
        },
      ],
      blockingWarnings: [],
    });
    const { conflicts } = parseExtraction(text);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('unit');
    expect(conflicts[0].note).toMatch(/164.5 GWh/);
  });

  it('parses blocking warnings', () => {
    const text = JSON.stringify({
      claims: [],
      conflicts: [],
      unitErrors: [],
      blockingWarnings: [
        {
          message: 'The 1.4% curtailment figure the episode rests on was retracted in the closing.',
          figure: '1.4% curtailment',
          turnIndex: 22,
          citedBy: ['Otis', 'Lara', 'Deepa'],
        },
      ],
    });
    const { blockingWarnings } = parseExtraction(text);
    expect(blockingWarnings).toHaveLength(1);
    expect(blockingWarnings[0].citedBy).toEqual(['Otis', 'Lara', 'Deepa']);
    expect(blockingWarnings[0].turnIndex).toBe(22);
  });

  it('value conflicts get kind "value"', () => {
    const text = JSON.stringify({
      claims: [],
      conflicts: [
        { quantity: 'x', values: [{ value: '452 GW' }, { value: '582 GW' }] },
      ],
    });
    const { conflicts } = parseExtraction(text);
    expect(conflicts[0].kind).toBe('value');
  });
});
