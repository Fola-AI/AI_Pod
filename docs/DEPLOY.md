# Deploying AI Pod to Vercel + Neon

The app is a standard Next.js 16 app and deploys to Vercel with no special config.
It needs a Postgres database (Neon) and provider API keys as environment
variables.

## 0. Prerequisites

- A Vercel account (free "Hobby" plan is enough), signed in with GitHub so it
  can see `Fola-AI/AI_Pod`.
- The repo is already pushed to `git@github.com:Fola-AI/AI_Pod.git` (`main`).

## 1. Import the project

1. Go to https://vercel.com/new
2. Pick **Fola-AI/AI_Pod** → **Import**.
3. Framework preset auto-detects **Next.js**. Leave build/output settings at
   their defaults (build `next build`, output `.next`).
4. **Don't deploy yet** — set the database and env vars first (below).

## 2. Database — pick ONE path

### Path A — Vercel–Neon native integration (recommended, free-tier eligible)

Lets Vercel manage the database and inject the connection env vars for you, and
gives you a separate database per preview branch.

1. In the project, open the **Storage** tab → **Create Database** → **Neon**
   (Marketplace, "Serverless Postgres").
2. Accept the free plan and create it. Vercel injects `DATABASE_URL` (and some
   `PG*` / `DATABASE_URL_UNPOOLED` vars we don't use) into all environments.
3. This is a **fresh, empty** database — push the schema to it once (step 4).

### Path B — reuse the existing Neon database (fastest)

You already have a working Neon database with the schema pushed. Just reuse it:

- Add `DATABASE_URL` = your existing Neon connection string as an env var
  (step 3). Nothing else to do — the tables already exist.

> Either driver path works because the app talks to Neon over HTTP
> (`@neondatabase/serverless`), which is ideal for Vercel's serverless functions.

## 3. Environment variables

Project → **Settings → Environment Variables**. Add these for
**Production** (and Preview if you want previews to work):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (skip if Path A injected it) |
| `ANTHROPIC_API_KEY` | your key |
| `OPENAI_API_KEY` | your key |
| `GOOGLE_AI_API_KEY` | your key |
| `DEEPSEEK_API_KEY` | your key |
| `GROQ_API_KEY` | your key |
| `XAI_API_KEY` / `META_API_KEY` / `MISTRAL_API_KEY` / `ALIBABA_API_KEY` | optional |
| `APP_ACCESS_PASSWORD` | **set this** — the single shared password that gates the app |

A model whose provider key is absent simply shows as unavailable — it never
crashes the app.

## 4. Push the database schema (Path A only, or any fresh DB)

From your machine, with the production `DATABASE_URL` in `.env.local`:

```bash
npm run db:push
```

(If you used Path B, the schema is already there — skip this.)

## 5. Deploy

Back in Vercel, click **Deploy**. The build runs `next build` (already passing
locally). First deploy takes ~1–2 minutes.

## 6. Verify

1. Open the deployment URL → you should hit the **password gate** (because
   `APP_ACCESS_PASSWORD` is set). Enter the password.
2. **New session** → create a 3-agent panel → **Run**. Turns should stream in.
3. When complete, try **Export → PDF** and **Extract claims**.

## Notes

- **Function duration:** turn/regenerate/claims/PDF routes declare
  `maxDuration = 60` (Hobby max). If a slow frontier model ever times out, the
  turn simply isn't saved and **Continue**/**Retry** re-runs it. Pro raises the
  cap to 300s.
- **The gate** runs in `proxy.ts` (Next 16's renamed middleware, Node runtime).
  Leaving `APP_ACCESS_PASSWORD` unset disables the gate.
- **Redeploys:** every push to `main` auto-deploys. Pull requests get preview
  URLs.
- **Model registry:** edit `config/models.ts` and push — no other change needed
  to add/enable models.
