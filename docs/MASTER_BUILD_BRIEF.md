# Master build brief — AI Debate Arena: full feature build

Build everything in this document. Cost and session duration are not constraints — I have accepted that sessions will run longer and cost more.

Two companion documents hold the detailed specs. Treat them as the source of truth for their sections and do not re-derive requirements from this file:

- `CLAUDE_CODE_FIX_BRIEF.md` — P0 defects, navigation, web search, prompt rules, registry
- `PODCAST_FEEL_BRIEF.md` — conversational texture, formats, characters, voice pass

This file governs **order, checkpoints, and the decisions made since those were written**.

---

## Working method

Build in the batches below, in order. After each batch:

1. Show me the diff
2. State which acceptance criteria that batch satisfies, and confirm you actually ran them
3. Stop and wait for my approval before starting the next batch

Do not run batches together. If ten changes land at once and the next episode sounds worse, neither of us can tell which one caused it. The point of the checkpoints is attribution, not caution.

Read the code before each batch and flag contradictions with the spec before building, as you did for P0.

---

## Batch 1 — P0 defects *(in progress)*

Per `CLAUDE_CODE_FIX_BRIEF.md` sections P0-1, P0-2, P0-3. Already agreed:

- Word budget tradeoff approved — `max_tokens` decoupled from `maxWordsPerTurn`, ±15% becomes a metric to report rather than a constraint to enforce
- `wasTruncated` migration plan shown before `db:push`
- Remove-agent drops the participant from the moderator roster and rotation only; earlier turns stay in the transcript
- Fatal dialog shows the provider's verbatim message and failure class on screen

---

## Batch 2 — Navigation and prompt rules

Small, low-risk, unblocks everything else.

- In-app Back control on every screen (`FIX_BRIEF` P1-1). Scope agreed: Back → Dashboard on Builder and Session. Drop the persona-editor rule for now; the Personas screen arrives in Batch 6.
- Replace the agent and moderator rules blocks, and the per-turn instructions, with the exact text in `FIX_BRIEF` P1-3.
- Model registry usability: Test connection per provider, key status, disabled-with-reason in the picker, README section on adding models (`FIX_BRIEF` P1-4).

**Checkpoint:** run one session with the new prompt rules and nothing else changed. I want to hear the plain-speech and house-structure rules in isolation before conversational texture is layered on top.

---

## Batch 3 — Conversational texture

Per `PODCAST_FEEL_BRIEF.md` A-1, A-2, A-6.

- Interjection turn class, `[SKIP]` handling, configurable rate (default medium)
- Opening banter round (default on)
- Three non-adversarial formats: shared curiosity, quickfire, story swap, with the agreement rule inverted for shared-curiosity and story-swap

**Orchestrator caution:** interjections are off-rotation turns inserted probabilistically. This touches turn indexing, ordering, and the resume-after-refresh path. Confirm a mid-session browser refresh still resumes correctly with interjections enabled — add that to the batch's acceptance run.

**Checkpoint:** this is the batch that decides whether the show sounds like people or like a panel. Run a full session and give me the transcript before continuing.

---

## Batch 4 — Voice pass

Per `PODCAST_FEEL_BRIEF.md` Part B.

- Voice pass as an explicit post-session step, never during generation
- `taggedText` stored separately from `text`, re-runnable, hand-editable
- ElevenLabs script export shaped for the Create dialogue endpoint
- `voiceId` as an optional text field per speaker

**Verification that matters:** strip tags from `taggedText` and diff against `text`. They must be byte-identical. The tagger must never alter a spoken word.

**Checkpoint:** I will run the output through ElevenLabs before we continue. Tag density will likely need tuning once I've actually heard it — expect to adjust the prompt after this checkpoint, not before.

---

## Batch 5 — Web search grounding

Per `FIX_BRIEF` P1-2. Scoped to **Anthropic, OpenAI and Google only**. Force-off with a visible reason for every other provider — do not build tool-use loops for providers I rarely use.

This is the largest single item in the build. It requires a tool-use round-trip in adapters that currently make a single call. Build it alone.

- Store search queries and source URLs per turn
- Collapsible panel per turn on the transcript screen
- Never present in any export of the spoken script
- Citations voiced naturally in speech, no URLs or reference markers

**Checkpoint:** confirm a session where at least one turn cites a specific, checkable fact, and that the fact is verifiable from the stored URL.

---

## Batch 6 — Characters, personas, and the rest

Per `PODCAST_FEEL_BRIEF.md` A-3, A-4, A-5, A-7.

- Characters CRUD screen with `runningNotes`, `catchphrases`, `defaultPersonaId`, `voiceId`
- Personas CRUD screen — personas currently live in `lib/personas.ts` as code, which means I cannot tune them without a deploy. Move them to the database with the built-in seven seeded on first run
- Character relationships layer with the four preset dynamics
- Callback rule in the agent prompt
- Cold open candidate: one post-session call identifying the best 15–30 seconds, shown on the transcript screen and included in the JSON export

Build the Characters and Personas screens together — they share most of their shape.

**Note on the show bible:** build the `Character` record and screen now, but leave `runningNotes` and `catchphrases` empty. Those fields only earn their content after several episodes, when I've noticed what a character actually does. Don't seed them with invented material.

---

## Batch 7 — Full-podcast preset and polish

- A **Full Podcast** session preset with everything enabled: 4 agents, opening banter on, interjections medium, web search on, shared-curiosity or panel format, `targetWordCount` 2800
- Cost and elapsed time remain **visible** in the live session view — I still want to see them, I just don't want them enforced
- Set the budget cap default to off rather than removing the feature
- Dashboard shows a running session with a Resume control, since sessions will now run 15+ minutes wall clock and I will navigate away from them

---

## Standing rules for every batch

1. Never persist an empty turn, under any condition
2. Never let a turn reach an export ending mid-word
3. Never substitute a model the operator did not select
4. Never let the moderator declare a winner, in any format
5. Never let the moderator become aware of a failed or removed participant
6. Every new config field gets a sensible default so existing saved sessions keep working
7. Any schema change: show me the migration plan before running `db:push`

---

## Final acceptance run

After Batch 7, run one complete session on the Full Podcast preset and report against every criterion in both companion briefs, plus:

1. A mid-session refresh resumes correctly with interjections and search both enabled
2. The transcript contains short reactions, an opening banter round, at least one grounded factual citation, and a cold open candidate
3. Stripped `taggedText` is byte-identical to `text` across every turn
4. The ElevenLabs export is ordered, complete, and carries a voice id per speaker where set
5. Total wall-clock time and total cost for the session are reported to me as figures

Do not mark any criterion passed without having run it.
