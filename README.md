# IT Helpdesk & Incident-Response Assistant

A retrieval-augmented chat assistant that answers IT support questions from internal
runbooks, KB articles, and past incident tickets — citing its sources, respecting
document access permissions, and refusing to answer when it isn't confident.
Full spec in [SPEC.md](SPEC.md).

**Stack:** Node/Express · PostgreSQL + pgvector (Supabase) · Prisma · React (Vite) · Google Gemini (free tier)

## Architecture

```
Ingest:  runbook/FAQ/ticket (.pdf/.md/.txt) → extract text → chunk (700 chars, ~15% overlap)
         → Gemini embeddings → pgvector (+ generated tsvector for full-text)
Query:   question
           ├─ Gemini embedding → vector search (cosine)      ┐ top-20 each
           └────────────────── → full-text search (tsvector) ┘
                                      │
              access-control filter (INTERNAL vs PUBLIC) applied IN the SQL
                                      │
                        Reciprocal Rank Fusion (RRF)
                                      │
                         Gemini LLM re-rank → top-3
                                      │
              confidence guardrail (cosine < 0.75 → escalate to human)
                                      │
                 Gemini answer (context-only, cited) + per-query telemetry
```

**Retrieval code:** [backend/src/lib/retrieval.js](backend/src/lib/retrieval.js) — shared by the
chat route and the eval harness, so the eval measures exactly what users get.

## Setup

1. **Gemini key (free):** https://aistudio.google.com/apikey

2. **Supabase:** create a project (or use an existing empty one). You do NOT need
   to enable pgvector manually — the Prisma migration does it.

3. **Backend:**
   ```sh
   cd backend
   copy .env.example .env    # then fill in DATABASE_URL, DIRECT_URL, GEMINI_API_KEY
   npm install
   npx prisma migrate dev --name init   # creates tables + enables pgvector
   npm run dev                          # http://localhost:3001
   ```

4. **Frontend (second terminal):**
   ```sh
   cd frontend
   npm install
   npm run dev                          # http://localhost:5173
   ```

5. Open http://localhost:5173, upload the docs in [sample-docs/](sample-docs/)
   (set category/source/visibility in the sidebar first), then ask e.g.
   *"How do I unlock a user's Active Directory account?"*

## Evaluation (Phase 3)

Proves the pipeline works, and measures the re-ranking lift. Against a known corpus
(the 4 [sample-docs/](sample-docs/)) and 24 realistic questions:

```sh
cd backend
npm run eval:seed     # reset KB to the known corpus (destructive)
npm run eval          # full run: precision@3 + faithfulness, before vs after re-ranking
# node eval/run-eval.js --fast        # retrieval only (no LLM answers/judge)
# node eval/run-eval.js --limit=6     # first 6 questions (conserve free-tier quota)
```

> **Free-tier note:** `gemini-2.5-flash` is capped at ~5 requests/min on the free tier.
> The eval self-throttles to that (`GEMINI_RPM=5` by default), so a full run takes a few
> minutes. With a paid key, run `GEMINI_RPM=60 npm run eval`. Production is not throttled.

| Metric | Before re-ranking | After re-ranking |
|---|---|---|
| Retrieval precision@3 | _see eval/results.json_ | _see eval/results.json_ |
| Faithfulness rate | _see eval/results.json_ | _see eval/results.json_ |

## Roadmap

- [x] **Phase 1 — MVP:** ingest runbooks/FAQs/tickets → chunk → embed → retrieve → cited answer
- [x] **Phase 2:** hybrid search (tsvector), re-ranking, confidence guardrail, retrieval-time access control (INTERNAL vs PUBLIC)
- [x] **Phase 3:** evaluation harness (retrieval precision@3, faithfulness)
- [x] **Phase 4:** per-query logging (tokens, latency, cost) — deploy steps below

## Deploy (Phase 4)

- **DB:** already on Supabase. Run `npx prisma migrate deploy` against the prod DB.
- **Backend:** Render/Railway — set `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`; start `npm start`.
- **Frontend:** Vercel — set the API base to the deployed backend and `npm run build`.
- Each `/api/chat` response includes a `meta` block (latency, tokens, cost estimate); the
  backend also logs one line per query. Swap the free key for a paid one to lift the 5 RPM cap.
