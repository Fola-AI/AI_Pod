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
   - Provider keys — Phase 1 uses `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
     `GOOGLE_AI_API_KEY`. Models whose key is missing show as unavailable.
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
beyond that file (as long as an adapter exists for its provider).

## Build status

Phase 1 (core loop) is implemented: registry + Anthropic/OpenAI/Google adapters,
seven built-in personas, the session builder, the client-orchestrated turn loop
with server persistence, the live session view, and Markdown/JSON export. Phases
2 (quality) and 3 (production) are next — see the PRD §14.
