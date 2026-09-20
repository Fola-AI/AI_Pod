# AI Pod

A single-operator web app that runs an automated, multi-turn discussion between
several AI agents — each powered by a different frontier LLM and given a distinct
persona — with an AI moderator steering. The output is a clean, speaker-tagged
transcript exported for downstream video production.

It is a **script generation tool**, not a public product. See
[`docs/AI_DEBATE_ARENA_PRD.md`](docs/AI_DEBATE_ARENA_PRD.md) for the full spec.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui (Base UI)
- Postgres (Neon) via Drizzle ORM
- Client-orchestrated turn loop — one turn = one `POST /api/turn` call, persisted
  server-side after every turn so a browser refresh resumes rather than restarts.
- Provider adapter layer: a shared OpenAI-compatible base plus Anthropic and
  Google specialisations. Adding a provider touches two files (an adapter + the
  registry).

## Setup

1. Install deps:

   ```bash
   npm install
   ```

2. Create `.env.local` from the template and fill in your secrets:

   ```bash
   cp .env.example .env.local
   ```

   - `DATABASE_URL` — a Neon (or any Postgres) connection string.
   - Direct provider keys — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
     `GOOGLE_AI_API_KEY`, and `GROQ_API_KEY` (Groq is a deliberate direct
     exception — see below). Models whose key is missing show as unavailable.
   - `OPENROUTER_API_KEY` — one key for every non-direct vendor (xAI, DeepSeek,
     Meta, Mistral, Alibaba). See **Model routing** below.
   - `APP_URL` — your production URL (e.g. the Vercel URL). Sent as OpenRouter's
     `HTTP-Referer` for dashboard attribution; falls back to `http://localhost:3000`.
   - `APP_ACCESS_PASSWORD` — optional single-password gate. Leave blank in dev.

3. Push the schema to your database:

   ```bash
   npm run db:push
   ```

4. Run:

   ```bash
   npm run dev
   ```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | Push Drizzle schema to the database |
| `npm run db:studio` | Drizzle Studio |

## Model registry

Models live in [`config/models.ts`](config/models.ts) and are expected to be
edited by hand — IDs and prices move monthly. Adding a model needs no code change
beyond that file (as long as an adapter exists for its route). The in-app
**Models** screen (`/registry`) shows the registry with per-provider key status
and a Test-connection button.

### Model routing (direct vs OpenRouter)

Each model entry has a `route`: `'direct'` (default) or `'openrouter'`.

- **Direct** — Anthropic, OpenAI, Google each hit their own endpoint (they carry
  the native web-search paths). **Groq is a deliberate direct exception:** its
  whole value is latency, and routing it through OpenRouter could land the call on
  a slower host. It works and is funded, so it stays direct — this is settled, not
  an oversight.
- **OpenRouter** — every other vendor (xAI, DeepSeek, Meta, Mistral, Alibaba, and
  anything new) routes through OpenRouter's OpenAI-compatible gateway with the
  single `OPENROUTER_API_KEY`. The `provider` field still names the vendor for
  grouping and pricing; only the transport changes.

**Set a provider allowlist in your OpenRouter account.** Open-weight models can be
served by many hosts of varying quality and privacy posture; the allowlist lets
you control who actually runs your calls. The app can't enforce this — it's an
account setting on openrouter.ai.

### Tiering rule and its consequences

Every model is tiered by the **vendor's own positioning**, not price or
generation (the rule is documented in `config/models.ts`): a model still sold as
flagship-class is `frontier` even if superseded; a workhorse or open-weight line
is `professional`; small-and-cheap is `fast`.

Applying it honestly leaves some tiers thin — **this is correct, not a bug:**

| Vendor | frontier | professional | fast |
|---|---|---|---|
| Meta | — (open-weight line) | Llama 4 Maverick | Llama 3.1 8B |
| Mistral | — (Large has no live endpoint) | Mistral Medium 3.5 | Ministral 8B |
| Alibaba | Qwen3.8 Max, Qwen3.7 Max | — | Qwen3.8 Flash |
| xAI | Grok 4.6, Grok 4.5 | Grok 4.3 | — |

So **"one agent per provider at this tier"** (the Tier Match preset) produces
different roster sizes per tier. The preset fills what exists and names the
vendors unavailable at the chosen tier — it never silently substitutes a
mis-tiered model, because an unfair matchup is the exact thing tiering prevents.

## Sessions run in the browser (resume on return)

The turn loop is **client-orchestrated** (one turn = one `POST /api/turn`),
persisted server-side after every turn. There is deliberately **no background
runner**: as a single-user app on Vercel's free tier, a queue or cron just to
keep generating while a tab is closed isn't worth the complexity. Navigating away
does not abort a session — its state is saved and its status stays `running`; the
Dashboard shows it with a **Resume** control that reopens it and continues from
the last saved turn. Generation simply pauses while no tab is driving it.

## Voice pass (ElevenLabs v3)

After a session completes, **Voice pass** tags the transcript with ElevenLabs v3
performance cues. Tags are stored per turn as `taggedText`, never overwriting
`text`; every tagged turn is verified so the spoken words are never altered. Run
it on a frontier tagger (e.g. Claude Opus) — a smaller model collapses the tag
vocabulary to `[pauses]`.

**Recommended ElevenLabs stability: `Natural`.** Natural sounds the most
realistic; **Creative overacts**, and **Robust ignores** the tags entirely. This
was confirmed by synthesis and should not be re-litigated. The **ElevenLabs
script** export carries this note, and v3 does not support SSML `<break>` tags —
use `[pauses]` instead.

## Build status

Phase 1 (core loop) is implemented: registry + Anthropic/OpenAI/Google adapters,
seven built-in personas, the session builder, the client-orchestrated turn loop
with server persistence, the live session view, and Markdown/JSON export. Phases
2 (quality) and 3 (production) are next — see the PRD §14.
