import { describe, it, expect } from 'vitest';
import {
  stripAudioTags,
  isFaithfullyTagged,
  countTags,
} from './voice-pass';

describe('voice pass tag verification', () => {
  const original = 'I timed mine last Tuesday. Forty-one minutes door to door.';

  it('strips tags and reproduces the spoken words exactly', () => {
    const tagged =
      '[thoughtful] I timed mine last Tuesday. [pauses] Forty-one minutes door to door.';
    expect(stripAudioTags(tagged)).toBe(original);
    expect(isFaithfullyTagged(original, tagged)).toBe(true);
  });

  it('accepts a tag at the very start and inline', () => {
    const tagged = 'I timed mine [dryly] last Tuesday. Forty-one minutes door to door.';
    // "dryly" is not a real tag word but bracketed content is stripped regardless.
    expect(isFaithfullyTagged(original, tagged)).toBe(true);
  });

  it('rejects tagged text that adds a spoken word', () => {
    const tagged = 'I timed mine last Tuesday, honestly. Forty-one minutes door to door.';
    expect(isFaithfullyTagged(original, tagged)).toBe(false);
  });

  it('rejects tagged text that drops a spoken word', () => {
    const tagged = 'I timed mine Tuesday. Forty-one minutes door to door.';
    expect(isFaithfullyTagged(original, tagged)).toBe(false);
  });

  it('rejects tagged text that rewords', () => {
    const tagged = 'I measured mine last Tuesday. Forty-one minutes door to door.';
    expect(isFaithfullyTagged(original, tagged)).toBe(false);
  });

  it('counts bracketed tags', () => {
    expect(countTags('[laughs] hello [pauses] world')).toBe(2);
    expect(countTags('no tags here')).toBe(0);
  });
});
