# IT Helpdesk & Incident-Response Assistant

A retrieval-augmented chat assistant that answers IT support questions from internal
runbooks, KB articles, and past incident tickets — citing its sources, respecting
document access permissions, and refusing to answer when it isn't confident.
Full spec in [SPEC.md](SPEC.md).

**Stack:** Node/Express · PostgreSQL + pgvector (Supabase) · Prisma · React (Vite) · Google Gemini (free tier)

## Architecture (Phase 1)

```
Ingest:  runbook/FAQ/ticket (.pdf/.md/.txt) → extract text → chunk (700 chars, ~15% overlap)
         → Gemini embeddings → pgvector
Query:   question → Gemini embedding → top-5 cosine similarity → Gemini answer (context-only, cited)
```

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

## Roadmap

- [x] **Phase 1 — MVP:** ingest runbooks/FAQs/tickets → chunk → embed → retrieve → cited answer
- [ ] **Phase 2:** hybrid search (tsvector), re-ranking, confidence guardrail, retrieval-time access control (INTERNAL vs PUBLIC)
- [ ] **Phase 3:** evaluation harness (retrieval precision@3, faithfulness)
- [ ] **Phase 4:** deploy + per-query logging (tokens, latency, cost)
