// Session formats (PRD §4.5). Each supplies a one/two-sentence framing string
// injected into agent and moderator system prompts right after the topic.

import type { SessionFormat } from '@/lib/types';

export interface FormatMeta {
  id: SessionFormat;
  label: string;
  stancesAssigned: boolean; // Whether the operator writes per-agent stances
  bestFor: string;
  shape: string; // Short description shown in the builder
  formatFraming: string; // Injected into system prompts
}

export const FORMATS: Record<SessionFormat, FormatMeta> = {
  debate: {
    id: 'debate',
    label: 'Debate',
    stancesAssigned: true,
    bestFor: 'Contested questions with clear sides. "Should X be banned?"',
    shape: 'Each participant holds an assigned position and defends it. Opposing sides, direct clash.',
    formatFraming:
      'This is a debate. Each participant has been assigned a position and defends it directly against the others. Engage the opposing arguments head-on.',
  },
  panel: {
    id: 'panel',
    label: 'Panel',
    stancesAssigned: false,
    bestFor: 'Broad or genuinely uncertain topics. "What does AI mean for African labour markets?"',
    shape: 'Open exploration. No assigned positions; each participant arrives at their own view through their character.',
    formatFraming:
      'This is an open panel discussion. No one has been assigned a position. Arrive at your own view through the lens of your character, and engage honestly with where others land.',
  },
  postmortem: {
    id: 'postmortem',
    label: 'Post-mortem',
    stancesAssigned: false,
    bestFor: 'Events. A match, an election result, a company collapse, a policy failure.',
    shape: 'Something already happened. Participants analyse why, disagreeing about causes rather than about what should be done.',
    formatFraming:
      'This is a post-mortem. The event in question has already happened. Analyse why it happened. Disagreement here is about causes, not about what should be done next.',
  },
  scenario: {
    id: 'scenario',
    label: 'Scenario',
    stancesAssigned: false,
    bestFor: 'Prediction and speculation. "What happens if Nigeria adopts X by 2030?"',
    shape: 'A hypothetical future is posed. Participants argue about what would follow and how likely it is.',
    formatFraming:
      'This is a scenario discussion. A hypothetical future has been posed. Argue about what would actually follow from it and how likely each consequence is. Be concrete about mechanisms and probabilities.',
  },
  'hot-seat': {
    id: 'hot-seat',
    label: 'Hot seat',
    stancesAssigned: true, // one seat holder at a time
    bestFor: 'Testing a single strong claim. Produces the most focused video.',
    shape: 'One participant holds a position; the others question and challenge it in rotation. The seat rotates once at the midpoint.',
    formatFraming:
      'This is a hot-seat session. One participant holds a position and the others question and challenge it in rotation. If you are in the seat, defend your position under pressure. If you are not, press the seat holder on the weakest part of their case.',
  },
  deliberation: {
    id: 'deliberation',
    label: 'Deliberation',
    stancesAssigned: false,
    bestFor: 'Practical questions. "How should a small African startup approach AI infrastructure?"',
    shape: 'A concrete decision must be reached, but no vote is taken. Participants surface trade-offs, constraints, and what they\'d need to know.',
    formatFraming:
      'This is a deliberation. A concrete decision is on the table, but no vote will be taken. Surface the real trade-offs and constraints, and be explicit about what you would need to know to decide.',
  },
};

export const FORMAT_LIST: FormatMeta[] = Object.values(FORMATS);

export function isStanceBearing(format: SessionFormat): boolean {
  return format === 'debate' || format === 'hot-seat';
}

export function getFormatFraming(format: SessionFormat): string {
  return FORMATS[format].formatFraming;
}
