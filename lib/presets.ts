// Built-in session presets (PRD §4.3). Applied in the builder to prefill
// format, participants (persona + optional stance), and length. Character names
// and models keep the builder defaults so the operator tweaks from there.
//
// targetWordCount governs the discussion body (openings + rounds + closings).
// With opening banter and interjections on (the builder defaults), the finished
// episode = body + banter + interjections. To land the *finished* episode near
// the intended length, presets set targetWordCount below it by the extras:
//   finished ≈ target·1.05 + (50 + 38·N)     [banter = host greeting + N replies]
//   target   ≈ (desiredFinished − 50 − 38·N) / 1.05
// Classic/Head-to-Head (N=3, want ~2600): (2600−164)/1.05 ≈ 2320 → 2300
// Full Table          (N=5, want ~3400): (3400−240)/1.05 ≈ 3010 → 3000
// (Calibrated for the defaults: banter on, interjections medium.)

import type {
  SessionFormat,
  InterjectionFrequency,
  InterjectionRate,
  SearchMode,
} from '@/lib/types';

export interface PresetAgent {
  displayName: string;
  personaId: string;
  stance?: string;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  format: SessionFormat;
  // CALIBRATED INPUT, not the expected output. targetWordCount governs the
  // discussion body; the finished episode = body + banter + interjections. To
  // land the finished episode near a desired length D with N agents:
  //   targetWordCount ≈ (D − 50 − 38·N) / 1.05
  // Set this from that formula, not to the desired finished length directly.
  targetWordCount: number;
  interjectionFrequency: InterjectionFrequency; // moderator cadence
  agents: PresetAgent[];
  // B-7: presets may also prefill the conversational-texture switches.
  interjectionRate?: InterjectionRate; // agent reactions
  openingBanter?: boolean;
  webSearchMode?: SearchMode;
}

export const PRESETS: Preset[] = [
  {
    id: 'classic-panel',
    label: 'Classic Panel',
    description: '3 voices — Pragmatist, Idealist, Data Hound — in open panel.',
    format: 'panel',
    // Calibrated for a ~2,600-word finished episode, N=3: (2600−50−38·3)/1.05 ≈ 2320.
    targetWordCount: 2300,
    interjectionFrequency: 'medium',
    agents: [
      { displayName: 'Lara', personaId: 'pragmatist' },
      { displayName: 'Tony', personaId: 'idealist' },
      { displayName: 'Kimi', personaId: 'data-hound' },
    ],
  },
  {
    id: 'head-to-head',
    label: 'Head to Head',
    description: 'Debate — two opposing stances plus one undecided.',
    format: 'debate',
    // Calibrated for a ~2,600-word finished episode, N=3: (2600−50−38·3)/1.05 ≈ 2320.
    targetWordCount: 2300,
    interjectionFrequency: 'high',
    agents: [
      { displayName: 'Lara', personaId: 'pragmatist', stance: 'For' },
      { displayName: 'Tony', personaId: 'idealist', stance: 'Against' },
      {
        displayName: 'Kimi',
        personaId: 'historian',
        stance: 'Undecided — weighing both sides',
      },
    ],
  },
  {
    id: 'full-table',
    label: 'Full Table',
    description: '5 voices — Pragmatist, Contrarian, Historian, Storyteller, Data Hound.',
    format: 'panel',
    // Calibrated for a ~3,400-word finished episode, N=5: (3400−50−38·5)/1.05 ≈ 3010.
    targetWordCount: 3000,
    interjectionFrequency: 'medium',
    agents: [
      { displayName: 'Lara', personaId: 'pragmatist' },
      { displayName: 'Tony', personaId: 'contrarian' },
      { displayName: 'Kimi', personaId: 'historian' },
      { displayName: 'Ada', personaId: 'storyteller' },
      { displayName: 'Zoe', personaId: 'data-hound' },
    ],
  },
  {
    id: 'full-podcast',
    label: 'Full Podcast',
    description:
      'The works — 4 voices, opening banter, interjections, and web search on. Panel format.',
    format: 'panel',
    // Calibrated for a ~2,800-word finished episode, N=4: (2800−50−38·4)/1.05 ≈ 2474.
    targetWordCount: 2500,
    interjectionFrequency: 'medium',
    interjectionRate: 'medium',
    openingBanter: true,
    webSearchMode: 'shared',
    agents: [
      { displayName: 'Lara', personaId: 'pragmatist' },
      { displayName: 'Tony', personaId: 'idealist' },
      { displayName: 'Kimi', personaId: 'contrarian' },
      { displayName: 'Ada', personaId: 'data-hound' },
    ],
  },
];
