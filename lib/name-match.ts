/** Escape a string for literal use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive match for a name. JS `\b` is ASCII-only, so a
 * name that starts or ends with an accented letter ("Zoë", "Bogotá", "Ọlá")
 * would never match with it. Letters and digits from any script count as part
 * of a word here.
 */
export function nameRegex(name: string, flags = 'iu'): RegExp {
  const f = flags.includes('u') ? flags : `${flags}u`;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name)}(?![\\p{L}\\p{N}])`, f);
}
