# Task brief — AI Debate Arena: podcast feel and voice pass

**Do not start this until P0 is merged and I've approved the diff.** This is the next phase after the defect fixes.

Goal: sessions currently produce a panel that argues. Real podcasts work because people *enjoy* each other — they interrupt, laugh, agree, go off on tangents, and come back. The transcript needs to carry that, and then needs to be tagged for ElevenLabs v3 voice synthesis.

As before: read the code first, tell me which files own each concern, and flag anything here that contradicts the actual structure before building.

---

## Part A — Conversational texture

### A-1. Interjection turns (highest impact)

Every turn is currently a 160-word block. Real conversation isn't. It's full of three-word reactions — "Ha, exactly", "Wait, say that again", "No, no, no" — and a transcript without them reads like a UN panel no matter how good the content is.

Add a second turn class:

```typescript
type TurnClass = 'full' | 'interjection';
```

- **Interjection:** 3–15 words. A reaction, an agreement, a laugh line, a one-word challenge, a request to repeat something. Never a new argument.
- The orchestrator inserts them probabilistically. Default: roughly 1 interjection per 2 full turns, from an agent who is *not* the next full speaker. Make the rate configurable (`interjectionRate: 'off' | 'low' | 'medium' | 'high'`, default medium).
- Interjections cost almost nothing — they should use the agent's configured model but with a low `max_tokens` (100 is fine here, since brevity is the whole point and truncation risk is low at that length; still run `validateTurn`).
- Prompt for an interjection turn:

```
The discussion is mid-flow. React to what was just said in one short
line — the kind of thing someone actually says out loud while another
person is talking. Agreement, surprise, a laugh, a small objection, or
asking them to repeat something.

3 to 15 words. Do not make a new argument. Do not start a new topic.
If nothing warrants a reaction right now, output exactly: [SKIP]
```

- If an agent returns `[SKIP]`, no turn is persisted and the rotation continues. This matters — forced reactions are worse than none.

### A-2. Opening banter

Real conversational podcasts open with light chat that establishes chemistry before the topic arrives. Add an optional **banter round** before the moderator's topic introduction.

- Config: `openingBanter: boolean`, default true.
- The moderator greets the participants by name and asks something light and unrelated or tangentially related to the topic.
- Each agent gives one short reply (40 words max) in character, warm rather than combative.
- Then the moderator transitions into the topic.

This costs ~200 words of your budget and is the single cheapest thing that makes the episode sound like people rather than position papers.

### A-3. Character relationships

Chemistry comes from history. Add an optional relationship layer to the session config:

```typescript
interface Relationship {
  agentA: string;      // agent id
  agentB: string;      // agent id
  dynamic: string;     // free text, e.g. "Old friends who disagree about everything and enjoy it"
}
```

Injected into both agents' system prompts. Examples to ship as presets: *"Old friends who disagree about everything and enjoy it"*, *"Respect each other but find the other exhausting"*, *"One is always trying to make the other laugh"*, *"Recently changed their mind because of something the other said"*.

### A-4. Show bible — recurring characters across episodes

If Lara appears in ten episodes, she should feel like the same person. Add a persistent character layer:

```typescript
interface Character {
  id: string;
  displayName: string;
  defaultPersonaId: string;
  runningNotes: string;   // "Always brings up her time in Lagos. Hates the phrase 'at scale'."
  catchphrases: string[];
  createdAt: string;
}
```

- Characters are reusable across sessions and independent of both persona and model (the three-slot principle still holds — this is a fourth, optional slot that supplies continuity).
- `runningNotes` and `catchphrases` are injected into the system prompt.
- Add a **Characters** screen for CRUD. This also solves the personas-are-code-only problem you flagged: build both screens together.

### A-5. Callbacks

Add to the agent prompt rules:

```
- If something earlier in this conversation was funny, surprising, or
  badly phrased, you may refer back to it later. A callback to a line
  from twenty minutes ago is one of the most enjoyable things in a
  conversation. Do not force one.
```

### A-6. Non-adversarial formats

Add three formats alongside the existing six. These are for episodes where nobody needs to be against anyone.

| Format | Shape |
|---|---|
| **Shared curiosity** | Nobody holds a position. All participants are genuinely trying to work out an answer together, thinking aloud, allowed to change their minds mid-sentence. The moderator asks rather than challenges |
| **Quickfire** | The moderator poses a rapid series of short questions. Each participant answers in 40 words maximum. Fast, light, high turn count. Good for a mid-episode segment or a whole short episode |
| **Story swap** | Each participant relates the topic to a specific, concrete situation. Narrative rather than argument. The moderator's job is to draw out detail |

For `shared-curiosity` and `story-swap`, override the "do not be agreeable" rule in the agent prompt. Agreement is the point in those formats. Replace it with:

```
- You may agree, and you may build on what someone else said rather
  than countering it. If someone changes your mind, say so out loud.
```

The no-winner principle still holds everywhere.

### A-7. Cold open candidate

After a session completes, make one call to a frontier model over the full transcript with this instruction: identify the single most compelling 15–30 seconds — a surprising claim, a sharp exchange, or a funny moment — and return the exact speaker and text span.

Show it at the top of the transcript screen as **Cold open candidate**, and include it in the JSON export. This is the clip that goes before the intro in the edit.

---

## Part B — Voice pass for ElevenLabs v3

A separate, explicit step that runs **after** the transcript is final. Do not have the debating agents write their own performance directions — a model writing its own line places laughter badly, and mixing performance direction into the argument degrades both.

### B-1. How it works

1. The operator clicks **Voice pass** on a completed transcript.
2. One frontier model receives the full transcript and returns the same transcript with ElevenLabs v3 audio tags inserted.
3. The result is stored as a *separate field* on each turn (`taggedText`), never overwriting `text`. The operator can re-run the pass, edit tags by hand, or export untagged.

### B-2. Tag reference

ElevenLabs v3 reads bracketed inline cues as performance direction rather than words to speak. Categories:

- **Emotions:** `[excited]` `[curious]` `[nervous]` `[frustrated]` `[calm]` `[sad]` `[happily]` `[sarcastic]` `[mischievously]`
- **Human reactions:** `[laughs]` `[laughs harder]` `[giggles]` `[sighs]` `[gasps]` `[clears throat]`
- **Delivery direction:** `[whispers]` `[shouts]` `[dramatically]` `[deadpan]` `[flatly]` `[playfully]`
- **Cognitive beats:** `[pauses]` `[hesitates]` `[stammers]`

Constraints to encode:

- **v3 does not support SSML `<break>` tags.** Use `[pauses]` and punctuation instead.
- Tag effectiveness depends on the chosen voice. A calm voice will not convincingly `[shout]`.
- ElevenLabs' stability setting must be **Creative** or **Natural** for tags to register. **Robust ignores directional prompts.** Note this in the export.

### B-3. Voice pass prompt

```
You are preparing a podcast transcript for text-to-speech synthesis
with ElevenLabs v3. Insert audio tags that direct vocal performance.

Available tags:
Emotions: [excited] [curious] [nervous] [frustrated] [calm] [sad]
          [happily] [sarcastic] [mischievously] [thoughtful]
Reactions: [laughs] [laughs harder] [giggles] [sighs] [gasps]
           [clears throat]
Delivery: [whispers] [dramatically] [deadpan] [flatly] [playfully]
Beats: [pauses] [hesitates]

RULES
- Tag sparingly. Most sentences need no tag at all. Over-tagging makes
  speech sound theatrical and fake. Aim for roughly one tag per 40-60
  words, fewer in serious passages.
- Place a tag immediately before the words it governs.
- Only tag a laugh where something was actually funny. A laugh on a
  flat line is the single most obvious tell that audio was generated.
- Match tags to character. A dry, precise speaker does not giggle.
  A warm speaker does not stay deadpan throughout.
- Use [pauses] before a genuinely weighty line, not as decoration.
- Never use SSML break tags. They are not supported.
- Never add, remove, or reword any spoken text. Tags only.
- Return the transcript in exactly the same speaker-tagged structure
  you received.

Serious subject matter takes fewer tags, not more. If a passage
concerns harm, loss, or anything a listener might be personally
affected by, leave it plain.
```

### B-4. Export for synthesis

Add a fourth export format: **ElevenLabs script**.

- Speaker-tagged, tagged text, one block per turn, ready to paste or feed to the API.
- ElevenLabs offers **Create dialogue / Stream dialogue** endpoints that weave multiple speakers into one natural-sounding conversation, which is a better fit here than synthesising each turn separately and stitching. Structure the export to suit that: an ordered array of `{ speaker, voiceId, text }`.
- Add an optional `voiceId` field to the `Character` record (A-4) so voices stay consistent across episodes. It's a text field the operator fills in from their ElevenLabs library — the app does not need to call ElevenLabs.

---

## Acceptance criteria

1. A session with interjections enabled produces a transcript containing short reactions between full turns, and `[SKIP]` responses produce no stored turn
2. Opening banter appears before the topic introduction and reads as warm rather than combative
3. `shared-curiosity` format produces a transcript in which participants agree with and build on each other
4. A cold open candidate is identified and appears on the transcript screen
5. Voice pass produces tagged text without altering any spoken word — diff `text` against `taggedText` with tags stripped and confirm they are identical
6. Tag density averages roughly one per 40–60 words, and no `[laughs]` appears on a line that isn't funny
7. ElevenLabs export is valid, ordered, and carries a voice id per speaker where one is set
8. Characters and Personas both have working CRUD screens
