# Product Requirements Document — AI Debate Arena

**Version:** 1.0
**Date:** 14 September 2026
**Owner:** Fola (Afolabi Ajao), Algoscape Innovations Ltd
**Build target:** Claude Code
**Working name:** AI Debate Arena *(placeholder — rename freely)*

---

## 1. Summary

A single-user web app that runs an automated, multi-turn discussion between several AI agents, each powered by a different frontier LLM and each assigned a distinct persona. An AI moderator opens the session, interjects with questions and clarifications, and closes it. The output is a clean, speaker-tagged transcript exported for downstream video production.

The app is a **script generation tool**, not a public product. The audience never touches the app — they watch the resulting YouTube video.

### 1.1 The core loop

1. Operator picks a topic and (optionally) attaches source material.
2. Operator configures 3–4 agents: name + persona + model, plus a moderator model.
3. Operator hits Run. The session executes end to end with no further input.
4. Operator reviews the transcript, optionally regenerates weak turns, and exports.
5. Operator takes the export into video editing (AI-generated character images, lip sync, voice).

### 1.2 Explicit non-goals

- **No judging, scoring, or winner declaration.** Agents make their case; the viewer decides. No rubric, no points, no "Agent B won." This is a product principle, not a feature gap.
- **No automated topic discovery.** The operator sources topics manually. No trend scraping, no Twitter/X monitoring.
- **No multi-user support.** Single operator, no auth beyond a basic access gate.
- **No audio/TTS generation in v1.** Text script only. (See §12 roadmap.)
- **No live streaming or public viewing.** Sessions run privately.

---

## 2. Users

| User | Description | Needs |
|---|---|---|
| Operator (Fola) | Sole user. Configures and runs sessions, exports scripts. | Fast config, reliable long runs, clean export, cost visibility |

---

## 3. Key product decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Web app, not desktop | Free hosting on Vercel, accessible from any machine, simpler build |
| D2 | Agent = Name + Persona + Model, three independent slots | Lets the operator swap any dimension without touching the others; enables A/B runs where the same topic is re-run with personas shuffled |
| D3 | Auto-run, no per-turn approval | Operator wants to start it and walk away |
| D4 | Client-orchestrated turn loop | Vercel serverless functions time out long before a 20-minute session completes. One turn = one API call. See §7.2 |
| D5 | Model registry lives in an editable config file | Frontier models ship monthly; hardcoding IDs guarantees rot |
| D6 | Word budget, not wall-clock time, controls length | "15–20 minutes" is a spoken-audio outcome. Target 2,250–3,000 words at ~150 wpm |
| D7 | Multiple export formats | PDF for reading, JSON/Markdown for the editing workflow |
| D8 | Moderator uses *modes*, not personas | A moderator with a personality competes with the debaters. A moderator with tactical modes drives the conversation |
| D9 | Closing statement round is mandatory | Gives the video a natural ending and forces each agent to concede at least one point |

---

## 4. Session configuration

The operator configures a session before running it. All fields persist as a reusable preset.

### 4.1 Session fields

```typescript
interface SessionConfig {
  id: string;
  title: string;                    // e.g. "Should African countries build their own LLMs?"
  topic: string;                    // The full framing given to all agents
  format: SessionFormat;            // See §4.5
  domain: string;                   // economics | politics | law | physics | technology | culture | ...
  sourceMaterial?: SourceDoc[];     // Optional research pack, see §4.4
  agentCount: number;               // Operator-set. Min 3, max 6. Default 3
  agents: AgentConfig[];            // Length must equal agentCount
  moderator: ModeratorConfig;
  targetWordCount: number;          // Default 2600
  maxTurns: number;                 // Default 24, hard cap 40
  createdAt: string;
}

interface AgentConfig {
  id: string;
  displayName: string;              // "Lara", "Kimi", "Tony" — operator's character name
  personaId: string;                // FK into persona library, §5
  modelId: string;                  // FK into model registry, §6
  stance?: string;                  // Debate format only: "For", "Against", or a specific position
  temperature: number;              // Default 0.85 — higher than typical, these should have voice
  maxWordsPerTurn: number;          // Default 160
}

interface ModeratorConfig {
  displayName: string;              // Default "Moderator"
  modelId: string;                  // Should be a top-tier model, see §8.1
  interjectionFrequency: 'low' | 'medium' | 'high';  // Default medium (~every 3rd turn)
  temperature: number;              // Default 0.7
}
```

### 4.2 The three-slot principle (D2)

Character name, persona, and model are stored separately and are independently swappable in the UI. Concretely:

- Session 1: Lara = The Contrarian = `claude-opus-5`
- Session 2: Lara = The Data Hound = `gpt-6-astra`
- Session 3: Tony = The Contrarian = `gemini-3.8-flash`

The UI must make swapping any single slot a one-click operation. A **"Shuffle personas"** button reassigns the current persona set across the current agents at random, keeping names and models fixed — this is the operator's primary tool for testing whether an argument came from the model or the character.

### 4.3 Session presets

Saved configs the operator can clone. Ship with three built-in presets:

- **Classic Panel** — 3 agents (Pragmatist, Idealist, Data Hound) + moderator, panel format
- **Head to Head** — 3 agents (two opposing stances plus one undecided) + moderator, debate format
- **Full Table** — 5 agents (Pragmatist, Contrarian, Historian, Storyteller, Data Hound) + moderator, panel format

### 4.4 Source material (optional)

The operator may attach 1–5 short documents (pasted text or uploaded `.txt`/`.md`/`.pdf`, max 4,000 words each). If present:

- The full source pack is injected into every agent's context at session start.
- Agents are instructed to cite the source material where relevant and to distinguish clearly between what the sources say and what they are inferring.
- The moderator is instructed to challenge any claim that contradicts the sources.

This is the single highest-leverage feature for output quality. Without it, agents waffle in generalities; with it, they argue about specifics.

### 4.5 Session formats

The format determines the shape of the conversation, the turn sequence, and whether stances are assigned. It is selected per session.

```typescript
type SessionFormat =
  | 'debate'
  | 'panel'
  | 'postmortem'
  | 'scenario'
  | 'hot-seat'
  | 'deliberation';
```

| Format | Shape | Stances assigned? | Best for |
|---|---|---|---|
| **Debate** | Each participant holds an assigned position and defends it. Opposing sides, direct clash | Yes — operator-written | Contested questions with clear sides. "Should X be banned?" |
| **Panel** | Open exploration. No assigned positions; participants arrive at their own view through the persona lens | No | Broad or genuinely uncertain topics. "What does AI mean for African labour markets?" |
| **Post-mortem** | Something already happened. Participants analyse *why*, disagreeing about causes rather than about what should be done | No | Events. A match, an election result, a company collapse, a policy failure |
| **Scenario** | A hypothetical future is posed. Participants argue about what would follow and how likely it is | No | Prediction and speculation. "What happens if Nigeria adopts X by 2030?" |
| **Hot seat** | One participant holds a position; the others question and challenge it in rotation. Roles rotate at the midpoint so a second participant takes the seat | Partial — one seat holder at a time | Testing a single strong claim. Produces the most focused video |
| **Deliberation** | A concrete decision must be reached, but no vote is taken. Participants surface trade-offs, constraints, and what they'd need to know | No | Practical questions. "How should a small African startup approach AI infrastructure?" |

**Implementation:**

- `debate` and `hot-seat` inject the stance block into the agent system prompt (§5.2). All other formats omit it.
- Each format supplies its own `formatFraming` string, injected into both the agent and moderator system prompts immediately after the topic, describing the shape of the conversation in one or two sentences.
- `hot-seat` overrides the turn sequence in §7.1: seat holder speaks, then each challenger in rotation, moderator interjects, repeat. Seat rotates once at ~50% of `targetWordCount`.
- All other formats use the standard sequence.

The no-winner principle (§3, D-non-goals) applies to every format without exception, including `debate` and `deliberation`.

### 4.6 Participant count

The operator sets `agentCount` per session. Minimum 3, maximum 6, default 3.

Enforce in the builder: adding agents beyond 6 is blocked, and dropping below 3 is blocked. When `agentCount` changes, the builder adds or removes agent slots without disturbing the ones already configured.

Practical guidance shown as a hint in the UI: 3 is the cleanest to follow on video, 4 is comfortable, 5–6 works but requires the operator to give each character a visually distinct image and voice or viewers lose track. At 5+ agents, raise `targetWordCount` — otherwise each participant gets too few turns to develop a position.

---

## 5. Persona library

Personas are stored as editable records. Ship with the seven below; the operator can add, edit, and duplicate.

```typescript
interface Persona {
  id: string;
  name: string;
  shortDescription: string;     // Shown in the picker
  systemPromptFragment: string; // Injected into the agent's system prompt
  speakingStyle: string;        // Voice/register guidance
  isBuiltIn: boolean;
}
```

### 5.1 Built-in personas

| Persona | Core drive | Speaking style |
|---|---|---|
| **The Pragmatist** | Only cares what works in practice. Dismisses elegant theory that fails on contact with reality. Asks "and then what happens on Monday morning?" | Plain, concrete, slightly impatient. Short sentences. Real-world examples |
| **The Idealist** | Argues from principle regardless of cost or feasibility. Holds that conceding on principle is how bad outcomes become normal | Measured, morally serious, occasionally soaring. Appeals to what *should* be |
| **The Contrarian** | Attacks whatever consensus forms. If the table agrees, that agreement is the thing to break | Sharp, provocative, enjoys the friction. Opens by disagreeing |
| **The Data Hound** | Demands numbers. Treats unquantified claims as noise. Will name the figure, the source, and the year, and flag when they're uncertain | Precise, slightly clinical. Cites specifics. Says "I don't have a number for that" rather than guessing |
| **The Historian** | Frames everything through precedent. Believes the current question has been asked before and the record is informative | Discursive, contextual. Opens with "this isn't new — in [year]..." |
| **The Storyteller** | Argues through anecdote and human consequence. Insists the abstract argument is missing the person it happens to | Warm, narrative, uses second person. Slows the pace down |
| **The Devil's Advocate** | Deliberately defends the least popular position available, explicitly as an exercise | Cool, precise, openly acknowledges they're stress-testing rather than asserting belief |

### 5.2 Persona prompt template

Each agent's system prompt is assembled from this template:

```
You are {displayName}, a participant in a recorded panel discussion.

YOUR CHARACTER
{persona.systemPromptFragment}

YOUR SPEAKING STYLE
{persona.speakingStyle}

THE TOPIC
{session.topic}

THE FORMAT
{formatFraming}

{if format is stance-bearing ('debate', or 'hot-seat' while you hold the seat)}
YOUR ASSIGNED POSITION
{agent.stance}
You argue this position as well as it can be argued. You may concede
narrow points, but you do not abandon the position.
{/if}

{if sourceMaterial}
SOURCE MATERIAL
The following has been provided to all participants. Ground your
arguments in it where relevant. Distinguish clearly between what
these sources state and what you are inferring.

{sourceMaterial}
{/if}

RULES OF THE ROOM
- Respond to what has actually been said. Name the participant you are
  answering and quote or paraphrase their specific claim before you
  respond to it.
- Do not monologue. {maxWordsPerTurn} words maximum, and shorter is
  often better.
- Do not summarise the discussion so far. The audience has heard it.
- Do not be agreeable for the sake of it. If you think someone is
  wrong, say so and say why.
- If you are uncertain or do not know something, say so plainly. Do not
  manufacture statistics, studies, quotes, or dates.
- Never break character. Never mention that you are an AI model, never
  refer to prompts, tokens, or this system.
- Speak as if being recorded for a podcast. No markdown, no bullet
  points, no headers — spoken prose only.

Output ONLY your spoken words. No name prefix, no stage directions.
```

The running transcript is passed in the user message, not the system prompt, so the character stays fixed while the conversation state changes.

---

## 6. Model registry

Stored in `/config/models.ts` as an editable array. **Model IDs change frequently — this file is expected to be updated by hand.** The UI reads from it at runtime; adding a model must require no code changes beyond this file.

```typescript
interface ModelEntry {
  id: string;              // Internal key
  provider: ProviderId;    // 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'meta' | 'mistral' | 'alibaba'
  apiModelString: string;  // What actually goes in the API call
  displayName: string;     // Shown in the UI
  tier: 'frontier' | 'mid' | 'fast';
  contextWindow: number;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  supportsSystemPrompt: boolean;
  enabled: boolean;
}
```

### 6.1 Seed registry

Accurate as of **8 September 2026**. Verify before first run — prices and IDs move monthly.

| Provider | Display name | API string | Tier | Context | $/MTok in | $/MTok out |
|---|---|---|---|---|---|---|
| Anthropic | Claude Fable 5.1 | `claude-fable-5-1` | frontier | 1M | 10.00 | 50.00 |
| Anthropic | Claude Opus 5 | `claude-opus-5` | frontier | 1M | 5.00 | 25.00 |
| Anthropic | Claude Sonnet 5 | `claude-sonnet-5` | mid | — | — | — |
| Anthropic | Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | fast | — | — | — |
| OpenAI | GPT-6 Astra | `gpt-6-astra` | frontier | 1.05M | 10.00 | 50.00 |
| OpenAI | GPT-5.6 Sol | `gpt-5.6-sol` | frontier | 1.05M | 4.00 | 20.00 |
| OpenAI | GPT-5.6 Terra | `gpt-5.6-terra` | mid | 1.05M | 2.00 | 12.00 |
| OpenAI | GPT-5.6 Luna | `gpt-5.6-luna` | fast | 1.05M | 0.20 | 1.20 |
| Google | Gemini 3.8 Flash | `gemini-3.8-flash` | frontier | 1.05M | 0.75 | 3.75 |
| Google | Gemini 3.1 Pro (Preview) | `gemini-3.1-pro-preview` | frontier | — | — | — |
| xAI | Grok 4.6 | `grok-4.6` | frontier | 500K | 2.00 | 6.00 |
| xAI | Grok 4.5 | `grok-4.5` | mid | — | — | — |
| DeepSeek | DeepSeek-V4-Pro | `deepseek-v4-pro` | frontier | 1M | 0.66 | 1.98 |
| Meta | Muse Spark 1.3 | `muse-spark-1.3` | frontier | 1M | 1.25 | 4.25 |
| Mistral | Mistral Medium 3.5 | `mistral-medium-3-5` | mid | 256K | — | — |
| Alibaba | Qwen3.8-Max | `qwen3.8-max` | frontier | 1M | 2.00 | 6.00 |

> **Note on pricing volatility:** Gemini 3.8 Flash is on introductory pricing until 31 Dec 2026 (rises to $1.50/$7.50). DeepSeek bills peak/off-peak, doubling during weekday peak hours. GPT-5.6 Sol is on promotional pricing through 21 Nov 2026. Treat the cost estimator (§9.3) as indicative.

### 6.2 Provider adapter layer

Every provider is wrapped behind one normalised interface. This is the most important piece of architecture in the app — it is what makes models genuinely swappable.

```typescript
interface ProviderAdapter {
  id: ProviderId;
  generate(params: {
    apiModelString: string;
    systemPrompt: string;
    messages: ChatMessage[];
    temperature: number;
    maxTokens: number;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}
```

Implement one adapter per provider. Several providers expose OpenAI-compatible endpoints — use a shared base adapter for those and specialise only where the API genuinely differs (Anthropic's separate `system` parameter, Google's `contents`/`parts` shape).

**Requirement:** adding a new provider must touch exactly two files — a new adapter and the registry.

---

## 7. Session execution

### 7.1 Turn sequence

```
1.  MODERATOR  — Opening. Introduces the topic and each participant by name.
2.  AGENT 1    — Opening position.
3.  AGENT 2    — Opening position.
4.  AGENT 3    — Opening position.
5.  AGENT n    — Opening position.
6.  ROUND LOOP — Agents speak in rotation. The moderator interjects
                 according to interjectionFrequency.
                 Continue until targetWordCount is approached or
                 maxTurns is reached.
7.  MODERATOR  — Calls for closing statements.
8.  AGENT 1..n — Closing statement. Each must (a) state their position
                 in one or two sentences and (b) name one point from
                 another participant they found genuinely persuasive.
9.  MODERATOR  — Closing. Explicitly declines to pick a winner and
                 hands the question to the audience.
```

**Stop conditions** (whichever fires first):
- Accumulated word count ≥ `targetWordCount`, *and* the current round has completed → proceed to closings
- `maxTurns` reached → proceed to closings
- Operator clicks Stop → proceed to closings
- Three consecutive provider failures on the same agent → abort with a recoverable error (§9.4)

### 7.2 Orchestration architecture (D4)

A 15–20 minute session is 20–30 sequential LLM calls, each taking 5–30 seconds. Total wall-clock: 3–12 minutes. **This exceeds Vercel serverless function limits on every plan tier**, so the loop cannot live inside one request.

**Required approach:**

- The orchestrator loop runs **client-side** (React).
- Each turn is a single `POST /api/turn` call carrying the session config and the transcript so far. The route makes exactly one provider call and returns one turn.
- Session state is persisted server-side after each turn (§10), so a browser refresh resumes rather than restarts.
- The UI streams each turn into view as it lands, so the operator watches the debate build live.

Do **not** attempt to run the full loop inside a single serverless function. Do **not** use `setTimeout` chains inside an API route.

### 7.3 Context construction per turn

For each agent turn, the user message contains:

```
DISCUSSION SO FAR:

Moderator: {text}
Lara: {text}
Tony: {text}
...

---
{turnInstruction}
```

Where `turnInstruction` varies by turn type:

- **Opening:** "Give your opening position on the topic. Do not respond to anyone yet — no one has spoken."
- **Standard:** "Respond. Name who you are answering and what they claimed."
- **Moderator-directed:** "The moderator has put a question directly to you. Answer it."
- **Closing:** "Give your closing statement. State your position in one or two sentences, then name one point another participant made that you found genuinely persuasive, and say why."

Pass the **full transcript**, not a summary. Context windows are large enough and summarising destroys the specificity that makes the debate worth watching.

---

## 8. Moderator design

The moderator is the difference between a good session and a flat one. It must be genuinely smart — assign it a frontier-tier model.

### 8.1 Moderator modes (D8)

Before each interjection, the moderator is asked to select a mode and then execute it. Modes:

| Mode | When to use | What it does |
|---|---|---|
| **Probe** | A claim was made without support | Asks a named participant for the evidence behind a specific claim |
| **Clash** | Two participants disagree but haven't engaged | Puts the disagreement to them directly: "Tony says X, Lara says Y — Tony, respond to Lara's point about Y specifically" |
| **Redirect** | The discussion has drifted | Names the drift and returns to the topic, or opens a deliberate new angle |
| **Steelman** | One position is being ganged up on | Asks the strongest opponent to state the other side's best argument |
| **Ground** | The discussion has gone abstract | Asks for a concrete example, a case, or a number |
| **Draw out** | A participant has been quiet or shallow | Puts a direct question to the least-heard participant |

### 8.2 Moderator system prompt

```
You are the moderator of a recorded panel discussion. You are not a
participant — you do not hold or argue positions of your own, and you
never declare a winner.

THE TOPIC
{session.topic}

THE FORMAT
{formatFraming}

THE PARTICIPANTS
{for each agent: "{displayName} — {persona.shortDescription}"}

{if sourceMaterial}
SOURCE MATERIAL
All participants have been given the following. Challenge any claim
that contradicts it.

{sourceMaterial}
{/if}

YOUR JOB
Keep the discussion sharp. Each time you speak, first choose the mode
that the conversation most needs right now, then execute it:

- PROBE: someone made a claim without support. Ask them for it.
- CLASH: two participants disagree but haven't engaged each other.
  Put it to them directly, by name, on the specific point.
- REDIRECT: the discussion has drifted. Name the drift, return to the
  topic or open a deliberate new angle.
- STEELMAN: one position is being ganged up on. Ask its strongest
  opponent to state that side's best argument.
- GROUND: the discussion has gone abstract. Ask for a concrete
  example, case, or number.
- DRAW OUT: someone has been quiet or shallow. Put a direct question
  to them.

RULES
- Address people by name. Always.
- Be brief. 60 words maximum, usually fewer.
- Never summarise what has been said. Never editorialise. Never
  declare anyone right.
- Do not thank people or praise contributions. You are steering, not
  hosting.
- Speak as if being recorded. No markdown, spoken prose only.
- Never break character or mention being an AI.

Output ONLY your spoken words. Do not name the mode you chose.
```

---

## 9. Application features

### 9.1 Screens

| Screen | Purpose |
|---|---|
| **Dashboard** | List of past sessions with title, date, participants, word count, cost. New Session button |
| **Session Builder** | Configure topic, format, agents (name/persona/model), moderator, source material, length. Shuffle personas. Save as preset |
| **Live Session** | Turn-by-turn transcript streaming in. Speaker tags. Running word count, turn count, elapsed cost. Stop button |
| **Transcript** | Full session. Per-turn regenerate. Inline edit. Export menu |
| **Persona Library** | CRUD on personas |
| **Model Registry** | Read-only view of `/config/models.ts` with an enable/disable toggle per model and an API-key status indicator per provider |
| **Settings** | API keys (env-backed), defaults, access gate |

### 9.2 Transcript editing

- **Regenerate turn** — re-run a single turn with the same context. Subsequent turns are marked stale and can be regenerated in bulk from that point.
- **Inline edit** — the operator can hand-edit any turn's text. Edited turns are flagged in the data model but not visually distinguished in exports.
- **Delete turn** — removes it and re-numbers.

### 9.3 Cost estimator

Before running, show a projected cost based on the configured agents, word count, and registry pricing. During a run, show accumulated actual cost from returned token counts. This matters — a 4-agent session on all-frontier models is not free.

Provide a **Budget cap** field. If accumulated cost exceeds it, the session jumps straight to closing statements.

### 9.4 Error handling

- Per-call retry with exponential backoff: 3 attempts.
- On persistent failure for one agent: offer **Skip turn**, **Retry**, or **Substitute model** without losing session state.
- Rate limit responses (429) are retried with a longer backoff and surfaced in the UI rather than failing silently.
- Every session is saved after every turn. A crash or refresh loses at most one turn.

---

## 10. Data model

```typescript
interface Session {
  id: string;
  config: SessionConfig;
  turns: Turn[];
  status: 'draft' | 'running' | 'complete' | 'aborted';
  totalWords: number;
  totalCostUsd: number;
  createdAt: string;
  completedAt?: string;
}

interface Turn {
  index: number;
  speakerId: string;          // agent.id or 'moderator'
  speakerDisplayName: string;
  turnType: 'opening' | 'standard' | 'moderator' | 'closing';
  text: string;
  modelId: string;            // Which model actually produced this — needed for the registry view
  personaId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  wasEdited: boolean;
  isStale: boolean;
  createdAt: string;
}
```

**Storage:** Postgres (Vercel Postgres or Neon free tier). Sessions must survive browser refresh, so client-only storage is insufficient.

---

## 11. Export

Three formats, all available from the transcript screen.

### 11.1 PDF (reading copy)

Clean, print-friendly. Title page with topic, date, and the agent/persona/model roster. Body is speaker-tagged prose:

```
LARA
[text]

TONY
[text]

MODERATOR
[text]
```

No timestamps (per operator requirement). No page-level metadata clutter.

### 11.2 JSON (editing workflow)

Full `Session` object. This is what feeds the video pipeline.

### 11.3 Markdown / plain text

Same shape as the PDF body, for pasting into any editor or teleprompter.

### 11.4 Speaker manifest

A one-page companion file exported alongside the transcript. It lists, for that session only: each character name, the persona they were given, and the model that powered them.

Purpose is purely practical. Weeks after a session, the transcript says "LARA" but nothing tells you whether Lara was the Contrarian on Grok or the Data Hound on Gemini — which you need in order to give her the right face and the right voice in the edit, and to keep her consistent if she reappears in a later session. It changes nothing about the transcript itself.

Example:

```
Session: "Should African countries build their own LLMs?"
Date: 2026-09-20 · Format: Panel · 4 participants

LARA      The Contrarian    Claude Opus 5
TONY      The Pragmatist    GPT-6 Astra
KIMI      The Data Hound    Gemini 3.8 Flash
ADA       The Historian     Grok 4.6
MODERATOR —                 Claude Fable 5.1
```

---

## 12. Technical stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 14+ (App Router), TypeScript | |
| Styling | Tailwind CSS | |
| UI components | shadcn/ui | |
| Database | Postgres (Vercel Postgres or Neon) | Free tier sufficient |
| ORM | Drizzle or Prisma | |
| PDF generation | `@react-pdf/renderer` or Puppeteer | React-pdf is simpler on Vercel |
| Hosting | Vercel | Free tier |
| Secrets | Vercel environment variables | One key per provider. Never client-side |
| Access gate | Single shared password via middleware, or Vercel password protection | Single-user app, full auth is overkill |

**Environment variables:**

```
ANTHROPIC_API_KEY
OPENAI_API_KEY
GOOGLE_AI_API_KEY
XAI_API_KEY
DEEPSEEK_API_KEY
META_API_KEY
MISTRAL_API_KEY
ALIBABA_API_KEY
DATABASE_URL
APP_ACCESS_PASSWORD
```

The app must degrade gracefully: models whose provider key is absent are shown as unavailable in the picker, not hidden and not crashed on.

---

## 13. Ethical and legal requirements

These are build requirements, not advisory notes.

### 13.1 Provider terms

Several providers restrict using their model's output to benchmark, compare, or train against competing models. Publishing side-by-side model comparisons sits close to that line. **Before publishing:** review each provider's usage policy for the models used, and frame published videos as character-driven discussion rather than model evaluation.

The "no judging, no winner" principle (D2 non-goal) is not only an editorial choice — it materially reduces this exposure.

### 13.2 Disclosure

- Every export includes a footer: *"This transcript was generated by AI language models participating as fictional characters. It is not a record of statements by any person."*
- The published video must carry an on-screen disclaimer at the start and in the description, naming the characters as AI and stating that positions expressed are model outputs, not the operator's views and not factual claims.
- Character names must be clearly fictional. Do not name a character after a real person, and do not name a character after the model powering it in a way that implies the provider endorses the content.

### 13.3 Accuracy

Models state false things confidently. The operator is the publisher and carries that liability.

**Build requirement:** the transcript screen includes a **Claims checklist** panel that extracts every statistic, date, named study, and direct quotation from the transcript into a checkable list, so the operator can verify before publishing. This can be a single post-session call to a frontier model with a extraction prompt — it does not need to be clever.

### 13.4 Subject matter

Add a topic-level warning in the session builder when the topic involves named living individuals, active legal proceedings, elections, or medical claims. The warning is advisory — it does not block the run — but it prompts the operator to consider whether the topic should be published at all.

---

## 14. Build phases

### Phase 1 — Core loop
- Model registry + adapters for Anthropic, OpenAI, Google
- Persona library with the seven built-ins
- Session builder (agents, moderator, topic)
- Client-orchestrated turn loop with server persistence
- Live session view
- Markdown export

**Done when:** a 3-agent, 20-turn session runs end to end and exports a readable script.

### Phase 2 — Quality
- Remaining provider adapters (xAI, DeepSeek, Meta, Mistral, Alibaba)
- Moderator modes
- Closing statement round
- Source material upload and injection
- Shuffle personas
- Per-turn regenerate and inline edit

### Phase 3 — Production
- PDF export + speaker manifest
- Optional `referenceImage` field per agent (a filename or URL the operator types in), carried through to the speaker manifest
- Cost estimator and budget cap
- Claims checklist
- Session presets
- Dashboard and session history

**Done when:** the operator can run, review, export, and file a session without leaving the app. This is the finished product. There is no Phase 4 — anything beyond this point is a response to a problem the operator has actually hit in production, not a planned feature.

---

## 15. Acceptance criteria

1. A session with 3 agents on 3 different providers runs to completion without operator intervention.
2. Changing one agent's model changes nothing else about that agent — name and persona persist.
3. Shuffling personas across agents produces a visibly different discussion on the same topic.
4. A browser refresh mid-session resumes from the last completed turn.
5. Adding a new model to `/config/models.ts` makes it selectable with no other code change.
6. A completed session exports to PDF, JSON, and Markdown, each speaker-tagged and free of markdown artefacts in the spoken text.
7. Output transcript length lands within ±15% of `targetWordCount`.
8. No agent turn contains markdown formatting, stage directions, its own name as a prefix, or any reference to being an AI model.
9. The moderator never declares a winner, in any session, in any format.
10. Accumulated cost is displayed accurately against provider-returned token counts.

---

## 16. Resolved decisions

- **Participant count** — operator-selectable per session, minimum 3, maximum 6, default 3. Specified in §4.6.
- **Stances** — always operator-written. No auto-assignment. Applies to `debate` and `hot-seat` only; all other formats run without assigned positions. Specified in §4.5.
- **Formats** — six available: debate, panel, post-mortem, scenario, hot seat, deliberation. Specified in §4.5.
- **Speaker manifest** — included in v1 as a text export, with an optional per-character reference image field the operator fills in by hand (Phase 3). Voice assignment and audio generation are not part of this app at all; that happens in the video editing tooling.
