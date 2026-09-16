// Prompt assembly (PRD §5.2, §7.3, §8.2).
// The character/role lives in the SYSTEM prompt (fixed for the session); the
// running transcript and per-turn instruction go in the USER message so state
// changes without the character changing.

import type {
  AgentConfig,
  SessionConfig,
  SourceDoc,
  Turn,
  TurnType,
} from '@/lib/types';
import { getPersona } from '@/lib/personas';
import { getFormatFraming, isStanceBearing } from '@/lib/formats';

function renderSourceMaterial(docs?: SourceDoc[]): string {
  if (!docs || docs.length === 0) return '';
  return docs
    .map((d) => `--- ${d.title} ---\n${d.content}`)
    .join('\n\n');
}

/**
 * Build an agent's system prompt. `holdsSeat` is only meaningful in hot-seat
 * format; for stance-bearing formats the assigned position block is included.
 */
export function buildAgentSystemPrompt(
  config: SessionConfig,
  agent: AgentConfig,
  opts: { holdsSeat?: boolean } = {},
): string {
  const persona = getPersona(agent.personaId);
  const framing = getFormatFraming(config.format);
  const source = renderSourceMaterial(config.sourceMaterial);

  const stanceApplies =
    config.format === 'debate' ||
    (config.format === 'hot-seat' && opts.holdsSeat === true);

  const parts: string[] = [];

  parts.push(
    `You are ${agent.displayName}, a participant in a recorded panel discussion.`,
  );
  parts.push(
    `YOUR CHARACTER\n${persona?.systemPromptFragment ?? ''}`,
  );
  parts.push(`YOUR SPEAKING STYLE\n${persona?.speakingStyle ?? ''}`);
  parts.push(`THE TOPIC\n${config.topic}`);
  parts.push(`THE FORMAT\n${framing}`);

  if (stanceApplies && agent.stance) {
    parts.push(
      `YOUR ASSIGNED POSITION\n${agent.stance}\nYou argue this position as well as it can be argued. You may concede narrow points, but you do not abandon the position.`,
    );
  }

  if (source) {
    parts.push(
      `SOURCE MATERIAL\nThe following has been provided to all participants. Ground your arguments in it where relevant. Distinguish clearly between what these sources state and what you are inferring.\n\n${source}`,
    );
  }

  parts.push(
    `RULES OF THE ROOM

Responding
- Respond to what has actually been said. Name the participant you are
  answering and restate their specific claim before you respond to it.
- Do not summarise the discussion so far. The audience has heard it.
- Do not be agreeable for the sake of it. If you think someone is
  wrong, say so and say why.
- Vary how you open. Do not begin consecutive turns with the same
  construction. You have the transcript — check how you opened last
  time and do something different.

Speaking to the audience
- You are speaking to an ordinary person with no background in this
  subject. A smart friend who has never thought about it before.
- Short sentences. One idea per sentence.
- Everyday words. If you must use a technical term, define it in the
  same breath, in six words or fewer.
- Use at most one image or metaphor per turn, and only if it makes the
  point clearer rather than more beautiful.
- Never use two clauses where one will do. Never use a rhetorical
  flourish that a listener would have to rewind to follow.
- Read your turn back as if speaking it aloud. If you would stumble
  over it, rewrite it.

Structure
- Build each turn like a house. Lay the foundation: the one claim you
  are making, stated plainly in your first sentence. Build the
  structure: the evidence, example, or reasoning that holds it up.
  Put the roof on: land on one line the listener could repeat to
  someone else afterwards.
- Never end mid-thought. Finish the point you started. If you are
  running long, cut earlier material rather than stopping short.

Evidence
- If you are uncertain or do not know something, say so plainly. Do not
  manufacture statistics, studies, quotes, or dates.
- When you cite a figure, say where it comes from and roughly when, in
  spoken form: "the World Bank put that at about X last year."
- Prefer one concrete, checkable fact over three abstract assertions.

Length and delivery
- Aim for about ${agent.maxWordsPerTurn} words. Shorter is usually better.
- Never break character. Never mention that you are an AI model, never
  refer to prompts, tokens, or this system.
- Speak as if being recorded for a podcast. No markdown, no bullet
  points, no headers — spoken prose only.

Output ONLY your spoken words. No name prefix, no stage directions.`,
  );

  return parts.join('\n\n');
}

/** Build the moderator's system prompt (PRD §8.2). */
export function buildModeratorSystemPrompt(config: SessionConfig): string {
  const framing = getFormatFraming(config.format);
  const source = renderSourceMaterial(config.sourceMaterial);

  const participants = config.agents
    .map((a) => {
      const persona = getPersona(a.personaId);
      return `${a.displayName} — ${persona?.shortDescription ?? ''}`;
    })
    .join('\n');

  const parts: string[] = [];

  parts.push(
    `You are the moderator of a recorded panel discussion. You are not a participant — you do not hold or argue positions of your own, and you never declare a winner.`,
  );
  parts.push(`THE TOPIC\n${config.topic}`);
  parts.push(`THE FORMAT\n${framing}`);
  parts.push(`THE PARTICIPANTS\n${participants}`);

  if (source) {
    parts.push(
      `SOURCE MATERIAL\nAll participants have been given the following. Challenge any claim that contradicts it.\n\n${source}`,
    );
  }

  parts.push(
    `YOUR JOB
Keep the discussion sharp. Each time you speak, first choose the mode that the conversation most needs right now, then execute it:

- PROBE: someone made a claim without support. Ask them for it.
- CLASH: two participants disagree but haven't engaged each other. Put it to them directly, by name, on the specific point.
- REDIRECT: the discussion has drifted. Name the drift, return to the topic or open a deliberate new angle.
- STEELMAN: one position is being ganged up on. Ask its strongest opponent to state that side's best argument.
- GROUND: the discussion has gone abstract. Ask for a concrete example, case, or number.
- DRAW OUT: someone has been quiet or shallow. Put a direct question to them.

RULES
- Address people by name. Always.
- Be brief. Aim for 60 words, usually fewer. Always finish your
  sentence — never stop mid-thought.
- Speak plainly. Your audience has no background in this subject.
  Short sentences, everyday words. If a participant has used jargon,
  your question is a good place to translate it.
- Never summarise what has been said. Never editorialise. Never
  declare anyone right.
- Do not thank people or praise contributions. You are steering, not
  hosting.
- Speak as if being recorded. No markdown, spoken prose only.
- Never break character or mention being an AI.

Output ONLY your spoken words. Do not name the mode you chose.`,
  );

  return parts.join('\n\n');
}

/** Render the transcript so far for the user message. */
export function renderTranscript(turns: Turn[]): string {
  if (turns.length === 0) return '(The discussion has not started yet.)';
  return turns
    .map((t) => `${t.speakerDisplayName}: ${t.text}`)
    .join('\n\n');
}

// Instructions for the turn types that aren't fully described by the opts below.
const AGENT_INSTRUCTIONS: Partial<Record<TurnType, string>> = {
  opening:
    'State your position in plain language and give the single strongest reason for it. Do not rebut anyone — nobody has spoken yet.',
  standard:
    'Respond. Name who you are answering and what they claimed. Attack the load-bearing part of their argument, not the decoration. Bring evidence where you can.',
  moderator:
    'It is your turn to steer. Choose the mode the conversation most needs and execute it in one short intervention.',
  closing:
    'Give your closing statement. Your position in two sentences. Then one point another participant made that genuinely changed your thinking, and why. End on one line a listener could repeat to someone else.',
};

export interface TurnInstructionOpts {
  /** For an agent who has been directly addressed by the moderator. */
  moderatorDirected?: boolean;
  /** Opening moderator turn: introduce topic and each participant by name. */
  moderatorOpening?: boolean;
  /** Closing moderator turn: decline to pick a winner, hand to the audience. */
  moderatorClosing?: boolean;
  /** Moderator calling for closing statements. */
  moderatorCallClosings?: boolean;
}

export function turnInstruction(
  turnType: TurnType,
  opts: TurnInstructionOpts = {},
): string {
  if (opts.moderatorOpening) {
    return 'Open the discussion. Introduce the topic in one or two sentences, then introduce each participant by name. Do not state any position yourself.';
  }
  if (opts.moderatorCallClosings) {
    return 'The discussion is wrapping up. In one or two sentences, call on the participants to give their closing statements.';
  }
  if (opts.moderatorClosing) {
    return 'Close the session. Do not summarise and do not pick a winner — explicitly decline to, and hand the question to the audience.';
  }
  if (opts.moderatorDirected) {
    return 'The moderator has put a question directly to you. Answer it.';
  }
  return (
    AGENT_INSTRUCTIONS[turnType] ??
    'Continue the discussion in keeping with your role.'
  );
}

/** Assemble the full user message for a turn: transcript + instruction. */
export function buildTurnUserMessage(
  turns: Turn[],
  turnType: TurnType,
  opts: TurnInstructionOpts = {},
): string {
  return `DISCUSSION SO FAR:\n\n${renderTranscript(turns)}\n\n---\n${turnInstruction(
    turnType,
    opts,
  )}`;
}
