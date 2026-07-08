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
- [ ] **Hybrid search**: combine vector similarity + Postgres full-text search (helps with exact error codes, ticket numbers, product names — vector search alone often misses these)
- [ ] **Re-ranking**: take top-20 from hybrid search, re-rank with a cross-encoder, keep top-3
- [ ] **Confidence guardrail**: if best similarity score < threshold (e.g. 0.75), respond "I don't have enough information — escalate to a human agent" instead of guessing
- [ ] **Role-based access control**: filter retrieved chunks by `visibility` (INTERNAL vs PUBLIC) + `ownerId` *before* they ever reach the LLM — mirrors a real requirement (security runbooks shouldn't be answerable to a general employee query); the standout differentiator

### Phase 3 — Prove it works (week 2–3)
- [ ] Build a test set: 25–30 realistic IT support questions with known correct source articles
- [ ] Script that runs each question through the pipeline and measures:
  - **Retrieval precision** — was the correct runbook/article in the top-3 retrieved?
  - **Faithfulness** — does the answer only use retrieved context? (checked with a second LLM call)
- [ ] Run the eval *before and after* adding re-ranking, record the difference — headline metric

### Phase 4 — Ship it (final days)
- [ ] Deploy backend + frontend
- [ ] Basic per-query logging: tokens used, latency, cost estimate
- [ ] README with architecture diagram and eval results

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
