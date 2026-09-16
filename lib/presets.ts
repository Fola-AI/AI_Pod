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

import type { SessionFormat, InterjectionFrequency } from '@/lib/types';

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
  targetWordCount: number;
  interjectionFrequency: InterjectionFrequency;
  agents: PresetAgent[];
}

export const PRESETS: Preset[] = [
  {
    id: 'classic-panel',
    label: 'Classic Panel',
    description: '3 voices — Pragmatist, Idealist, Data Hound — in open panel.',
    format: 'panel',
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
];
