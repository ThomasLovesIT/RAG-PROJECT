# IT Helpdesk & Incident-Response Assistant — Full Project Spec

**One-line pitch:** A retrieval-augmented chat assistant that answers IT support questions by retrieving from internal runbooks, knowledge-base articles, and past incident tickets — citing its sources, respecting document access permissions (e.g. restricted runbooks vs. public FAQs), and refusing to answer when it isn't confident — with a built-in evaluation suite proving it actually works.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React | Already known |
| Backend | Node.js + Express | Already known |
| Database | PostgreSQL + `pgvector` extension | Extends IRSS/Prisma experience |
| ORM | Prisma | Supports raw SQL for vector queries |
| Hosting (DB) | Supabase | pgvector supported natively |
| Embeddings | Gemini `gemini-embedding-001` (free tier) | Cheap, simple API |
| LLM | Gemini `gemini-2.5-flash` (free tier) | Cheap + good instruction-following |
| Re-ranker (stretch) | Cohere Rerank API or local cross-encoder | Improves retrieval precision |
| Keyword search (stretch) | Postgres full-text search (`tsvector`) | For hybrid search |
| Deployment | Vercel (frontend) + Render/Railway (backend) | Free tiers, easy CI |

---

## 2. Architecture

```
User query (e.g. "How do I fix a locked AD account?")
   │
   ▼
[Embed query] ──► [Vector search in pgvector] ──► top-20 chunks
   │                                                   │
   │                                          [Re-rank top-20 → top-3]
   │                                                   │
   ▼                                                   ▼
[Access control filter] ◄────────────────────── filtered chunks
   │  (e.g. internal-only runbooks vs public FAQs)
   ▼
[LLM call: "answer using ONLY this context, cite sources, say
 'I don't know' if context is insufficient"]
   │
   ▼
Answer + cited source articles/tickets → React UI
```

---

## 3. Database schema

`KBArticle` (title, category, source RUNBOOK|FAQ|PAST_TICKET, visibility INTERNAL|PUBLIC,
ownerId) → has many `Chunk` (content, embedding vector(1536), chunkIndex).
See [backend/prisma/schema.prisma](backend/prisma/schema.prisma) for the live schema with
design-decision comments.

Similarity search (raw SQL via Prisma, since pgvector isn't natively typed):

```sql
SELECT id, content, "articleId",
       1 - (embedding <=> $1::vector) AS similarity
FROM "Chunk"
ORDER BY embedding <=> $1::vector
LIMIT 20;
```

---

## 4. Build plan (phased — MVP first, then differentiators)

### Phase 1 — MVP (week 1)
- [x] Ingest sample IT docs (runbooks, FAQs, resolved-ticket writeups as PDFs/Markdown) → extract text → chunk (500–800 chars, ~15% overlap)
- [x] Embed each chunk, store in `pgvector`
- [x] On query: embed → top-5 similarity search → send to LLM with context → return answer
- [x] Basic React chat UI (helpdesk-style) with source citations

### Phase 2 — Make it good (week 2)
- [x] **Hybrid search**: vector similarity + Postgres full-text search (`tsvector`), fused with Reciprocal Rank Fusion — see [backend/src/lib/retrieval.js](backend/src/lib/retrieval.js). Helps with exact error codes, ticket numbers, product names that pure vector search blurs.
- [x] **Re-ranking**: take top-20 per search → RRF shortlist → re-rank the shortlist to top-3. Implemented as a **Gemini LLM re-ranker** rather than Cohere/a local cross-encoder, so the project needs no extra API key (the Phase 3 eval measures its lift). Toggle per request with `rerank:false`.
- [x] **Confidence guardrail**: if the best *cosine* similarity < 0.75, respond "escalate to a human agent" instead of guessing (RRF scores aren't comparable across queries; cosine is).
- [x] **Role-based access control**: filter retrieved chunks by `visibility` (INTERNAL vs PUBLIC) inside the search SQL — *before* they ever reach the LLM. The standout differentiator.

### Phase 3 — Prove it works (week 2–3)
- [x] Test set of realistic IT support questions with known correct source articles — [backend/eval/questions.json](backend/eval/questions.json) (24 Qs; small corpus of 4 docs, so fewer than the 25–30 target but 6 per source).
- [x] Script that runs each question through the *real* pipeline and measures — [backend/eval/run-eval.js](backend/eval/run-eval.js):
  - **Retrieval precision@3** — was the correct source article in the top-3 retrieved?
  - **Faithfulness** — does the answer only use retrieved context? (second Gemini call as judge)
- [x] Runs the eval *before and after* re-ranking and records the difference → [backend/eval/results.json](backend/eval/results.json).

### Phase 4 — Ship it (final days)
- [~] Deploy backend + frontend — steps documented in the README; not yet deployed.
- [x] Per-query logging: tokens used, latency, cost estimate (logged server-side + returned in each `/api/chat` response's `meta`).
- [x] README with architecture diagram and eval instructions/results.

---

## 5. Evaluation harness — example questions

```
Q: "How do I unlock a user's Active Directory account after too many failed logins?"
Expected source: AD-Account-Lockout-Runbook.md
Expected answer contains: "unlock-adaccount" or "Active Directory Users and Computers"

Q: "A user's VPN keeps disconnecting every 10 minutes, what should I check first?"
Expected source: VPN-Troubleshooting-FAQ.md
Expected answer contains: "MTU" or "idle timeout"

Q: "What's the escalation path for a P1 outage ticket?"
Expected source: Incident-Response-Runbook.md
Expected answer contains: "on-call" or "escalation tier"
```

Metrics table (fill with real measured numbers in Phase 3):

| Metric | Before re-ranking | After re-ranking |
|---|---|---|
| Retrieval precision@3 | — | — |
| Faithfulness rate | — | — |
| Avg. latency | — | — |

---

## 6. Interview talking points

- **Why RAG instead of fine-tuning?** Fine-tuning bakes in facts at training time (expensive, stale as runbooks change); RAG retrieves live documentation and cites the exact source article.
- **Why re-ranking?** Vector search is fast but approximate; a re-ranker is slower but far more accurate on the shortlist — combining both gets speed and precision.
- **Why the eval harness?** Without it you can't tell whether a change actually helped or just felt like it should.
- **Why access control at retrieval time (not just the UI)?** Filtering only in the UI can still leak restricted content into an LLM's answer; filtering before retrieval is the real secure boundary.

---

## 7. Stretch goals

- Streaming responses (token-by-token)
- Auto-categorize incoming questions by severity/category before retrieval
- Slack/Teams bot integration
- Cost dashboard ($ per day on embeddings + LLM calls)
