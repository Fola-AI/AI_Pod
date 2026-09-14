// Built-in session presets (PRD §4.3). Applied in the builder to prefill
// format, participants (persona + optional stance), and length. Character names
// and models keep the builder defaults so the operator tweaks from there.

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
    targetWordCount: 2600,
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
    targetWordCount: 2600,
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
    targetWordCount: 3400,
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
