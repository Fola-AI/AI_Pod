# Task brief — AI Debate Arena: defect fixes and improvements

The app is built and has run one production session. That session produced an unusable transcript. Below are three defects to fix first, then four improvements.

Before writing any code, read the existing codebase and tell me which files own each concern: the provider adapters, the turn orchestration loop, the prompt assembly, the model registry, and the page layout/navigation. Do not assume file paths from this brief — it describes behaviour, not structure. If anything here contradicts what you find in the code, say so before proceeding.

Work in priority order. P0 first, and show me the diff for P0 before moving to P1.

---

## Evidence from the failed session

The exported transcript showed:

- Almost every turn ending mid-word: `"that's cheap, it's doable, and nobody"`, `"can raise the rent, change the terms"`, `"the question goes out of this room unsett"`
- One agent ("Kimi") returning an empty string on all four of its turns, with the session continuing to completion regardless
- All four participants running on `claude-opus-5` despite being configured as different models

**Operator follow-up since then — read this before diagnosing:**

- The identical-models issue was **my configuration mistake**, not a bug. I did not change the model on each agent. Changing it since works correctly. Treat P0-3 below as verification plus guardrails, not as a hunt for a known bug.
- Kimi's blank turns were almost certainly **depleted credits on that provider account**. That means the provider returned an API error — a billing or quota failure — and the app turned that error into an empty turn and continued. The bug is not "the model sometimes returns nothing." The bug is that **a provider error became silent empty output**. P0-2 is rewritten around this.

---

## P0-1 — Turns are truncated mid-sentence

**Diagnosis to confirm:** the per-agent `maxWordsPerTurn` value (default 160) is being used to compute a hard `max_tokens` cap on the provider call. That cuts the model off mid-generation rather than making it write concisely.

**Required changes:**

1. `maxWordsPerTurn` must be used **only** as an instruction inside the prompt text. It must never be used to derive `max_tokens`. Find every place it feeds into a provider call and remove that path.

2. Set `max_tokens` generously and independently: at minimum `maxWordsPerTurn * 4` tokens, with a floor of 600. For moderator turns, a floor of 400.

3. After every provider call, inspect the stop/finish reason. Each adapter must normalise this into the shared response type, e.g.:

```typescript
interface ProviderResponse {
  text: string;
  stopReason: 'complete' | 'max_tokens' | 'refusal' | 'other';
  rawStopReason: string;      // Provider's original value, for logging
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}
```

Map each provider's value: Anthropic `end_turn` vs `max_tokens`, OpenAI `stop` vs `length`, Google `STOP` vs `MAX_TOKENS`, and so on.

4. Add a turn validator that runs before a turn is accepted:

```typescript
function validateTurn(text: string, stopReason: string): 
  { valid: true } | { valid: false; reason: 'truncated' | 'empty' } {
  const trimmed = text.trim();
  if (trimmed.length < 20) return { valid: false, reason: 'empty' };
  if (stopReason === 'max_tokens') return { valid: false, reason: 'truncated' };
  if (!/["'')\]]*[.!?…]["'')\]]*$/.test(trimmed)) {
    return { valid: false, reason: 'truncated' };
  }
  return { valid: true };
}
```

5. On `truncated`: retry once with `max_tokens` doubled and an appended instruction — `"Keep this turn under {maxWordsPerTurn} words and finish your final sentence completely."` If the retry also fails validation, store the turn with a `wasTruncated: true` flag and show a visible warning badge on that turn in the transcript UI. Never let a truncated turn reach an export silently.

6. Add a `wasTruncated` boolean to the `Turn` record and to the database schema.

**Done when:** a full session runs and no turn in the exported transcript ends without sentence-final punctuation.

---

## P0-2 — Provider errors are being swallowed into empty turns

An agent produced four consecutive blank turns and the session ran to completion regardless. The likely cause was depleted credits on that provider account, meaning the API returned a billing or quota error that the app converted into an empty turn.

**First task — find the swallow.** Trace the path from the provider call to the stored turn and find where a thrown error, a non-2xx response, or an error-shaped response body becomes an empty string. Look for `catch` blocks that return `''` or a default object, optional chaining that resolves to `undefined` on an error payload (`data.content?.[0]?.text`), and any place a failed call still results in a `Turn` being persisted. Report what you find before changing it.

**Required changes:**

1. **An error must never become a turn.** A failed provider call throws or returns an error result. It never produces a stored `Turn`, empty or otherwise.

2. Classify every provider failure into one of three classes, normalised across adapters:

```typescript
type FailureClass =
  | 'fatal'       // Do not retry. Operator must act.
  | 'transient'   // Retry with backoff.
  | 'empty';      // Call succeeded, content was empty.
```

**Fatal — halt immediately, do not retry:**
- 401 / 403 — invalid or missing API key
- 402, or any response indicating insufficient credits, exhausted quota, billing failure, or a suspended account
- 404 or "model not found" — bad `apiModelString`
- 400 on a malformed request

Retrying these wastes time and money and hides the real problem. The failed session burned a full run on a fatal error retried as if transient.

**Transient — retry with exponential backoff, 3 attempts:**
- 429 rate limit (longer backoff)
- 5xx
- Network timeout

**Empty — the call succeeded but content was blank.** Retry twice, then treat as fatal.

3. **Surface the provider's actual message.** On any fatal failure, halt the session and show me a dialog containing: the agent name, the model, the failure class, and the provider's verbatim error message. If a provider says the account is out of credits, I need to read those words — not "an error occurred". Log the full raw response body server-side for every fatal and every empty.

4. On fatal failure, preserve all session state and offer:
   - **Retry** — try again, for when I've just topped up the account
   - **Substitute model** — pick a different model for this agent and continue from this turn
   - **Remove agent** — drop the participant and continue with the rest, adjusting the rotation

5. The moderator must never be given awareness of a failing participant. It should not end up improvising around a silent chair as it did in the failed session.

6. Keep the empty-content validation from P0-1's `validateTurn` as the backstop, for the case where a provider genuinely returns a successful but blank completion.

**Done when:** pointing an agent at a provider with an invalid key halts the session before or at turn 1 and shows me that provider's own error text — and no blank turn is ever persisted.

---

## P0-3 — Model selection guardrails (verification, not a known bug)

All four participants ran on `claude-opus-5`, but this was my configuration mistake — I did not change the model per agent, and doing so since works. So this section is about verifying no fallback exists and adding the guardrails that would have caught my error.

**Required changes:**

1. **Verify there is no silent fallback.** Search for any `||`, `??`, or `catch` that resolves to a default model string or a default provider. If none exists, say so and move on — do not invent a fix. If one does exist, remove it: a configured model that cannot be used must throw, never substitute.

2. Add a **pre-flight check** when I click Run, before turn 1. This is the highest-value item in this section, because it would have caught the depleted-credits failure too:
   - For every distinct model in the session, confirm the provider's API key is present
   - Make one cheap test call per distinct model (max 10 tokens)
   - If any fail, block the session and show which model failed and the provider's own error message
   - Never start a partial session

3. Persist `modelId` on every `Turn` as the model that **actually produced it**, read from the response path rather than copied from config. This makes the mistake visible in the speaker manifest afterwards.

4. In the session builder, show a non-blocking amber warning when two or more agents share a model, and a stronger one when all agents share a model: *"All participants are using the same model. The discussion will not show variation between models."* This is the specific guardrail for the mistake I made.

5. Make the model shown on each agent card in the builder unmissable — model name visible without opening a dropdown, so an unchanged default is obvious at a glance.

**Done when:** configuring three agents on one model shows the warning, and the speaker manifest reflects whatever was actually used.

---

## P1-1 — In-app navigation

There is currently no Back control; the browser back button is the only way to move between screens.

1. Add a **Back** control in the top-left of the page header on every screen except the Dashboard. Always visible without scrolling.

2. It navigates to the **logical parent**, not browser history:
   - Transcript → Dashboard
   - Session Builder → Dashboard
   - Live Session → Dashboard
   - Persona editor → Persona Library

3. Label with destination: `← Dashboard`, `← Personas`.

4. On Live Session, Back must **not** stop the run. The session continues; the Dashboard shows it as running with a **Resume** control.

5. Keep the top bar on every screen and highlight the active one.

6. `Escape` triggers Back on every screen except Live Session.

---

## P1-2 — Web search grounding

Agents currently assert without evidence. In the failed session the moderator asked three separate times for a cost figure and never got one.

1. Use each provider's **native** web search tool, not a pre-fetch step. Native tool use lets the model search mid-reasoning.
   - Anthropic: `web_search` server tool
   - OpenAI: built-in web search tool
   - Google: search grounding
   - Providers with no native search: force search off for that agent and show why in the UI. Do not silently degrade.

2. Config:

```typescript
interface WebSearchConfig {
  enabled: boolean;               // Session master switch, default true
  maxSearchesPerTurn: number;     // Default 2, hard cap 3
  maxSearchesPerSession: number;  // Default 20
}
```

Plus `webSearchEnabled: boolean` per agent, defaulting true where supported. Default it on permanently for the Data Hound persona.

3. Store the search queries issued and URLs returned on each `Turn`. Show them in a collapsible panel per turn on the transcript screen — this is how I verify claims before publishing. They must not appear in any export of the spoken script.

4. Instruct agents to voice citations naturally in speech (`"Reuters reported last month that..."`). No URLs, no bracketed references, no footnote markers in spoken text.

5. Show added latency and cost in the live session view.

---

## P1-3 — Rewrite the spoken-output rules

The transcript reads as literary prose. It needs to work for a general YouTube audience listening at speed.

Replace the rules block in the **agent** system prompt with exactly this:

```
RULES OF THE ROOM

Responding
- Respond to what has actually been said. Name the participant you are
  answering and restate their specific claim before you respond to it.
- Do not summarise the discussion so far. The audience has heard it.
- Do not be agreeable for the sake of it. If you think someone is
  wrong, say so and say why.

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
- Aim for about {maxWordsPerTurn} words. Shorter is usually better.
- Never break character. Never mention that you are an AI model, never
  refer to prompts, tokens, or this system.
- Speak as if being recorded for a podcast. No markdown, no bullet
  points, no headers — spoken prose only.

Output ONLY your spoken words. No name prefix, no stage directions.
```

Replace the rules block in the **moderator** system prompt with exactly this:

```
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
```

Also update the per-turn instructions so the arc carries through the session:

- **Opening turns:** "State your position in plain language and give the single strongest reason for it. Do not rebut anyone — nobody has spoken yet."
- **Middle rounds:** "Respond. Name who you are answering and what they claimed. Attack the load-bearing part of their argument, not the decoration. Bring evidence where you can."
- **Closing turns:** "Give your closing statement. Your position in two sentences. Then one point another participant made that genuinely changed your thinking, and why. End on one line a listener could repeat to someone else."

---

## P1-4 — Model registry usability

1. Add a **Test connection** button per provider on the Model Registry screen. One cheap call, reports pass/fail with the error message on failure.

2. Show per-provider key status (present / absent) read from the server, never exposing key values to the client.

3. Models whose provider key is absent appear in the picker as disabled with the reason shown — not hidden, not silently selectable.

4. Add a short `README` section documenting how I add models myself:
   - **Existing provider, new model:** add an entry to `/config/models.ts`, redeploy. No code.
   - **New provider:** add the env var, write an adapter implementing the `ProviderAdapter` interface, add registry entries. Note which existing adapter to copy for OpenAI-compatible endpoints.

---

## Acceptance criteria

Run a full 3-agent session on 3 different providers with search enabled and confirm all of the following:

1. No turn in the export ends without sentence-final punctuation
2. No blank turn is ever persisted, under any failure condition
3. An agent pointed at a provider with an invalid or unfunded key halts the session and shows that provider's verbatim error message — it does not produce blank turns and does not retry a fatal error
4. A session with a missing API key is blocked at pre-flight, naming the model
5. Configuring all agents on the same model shows a warning in the builder
6. Every screen is reachable and exitable without the browser back button
7. At least one turn cites a specific, checkable fact, with the query and source URL visible on the transcript screen and absent from the exported script
8. Average sentence length in the spoken output is under 20 words
9. No undefined jargon appears in the spoken output
10. The moderator does not declare a winner

Report against each numbered criterion when done. Do not mark one passed without having actually run it.
