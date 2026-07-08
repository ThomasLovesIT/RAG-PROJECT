# RAG Study Assistant

A retrieval-augmented chat assistant that answers questions from your own lecture
notes/PDFs and cites its sources. Full spec in [.claude/CLAUDE.md](.claude/CLAUDE.md).

**Stack:** Node/Express · PostgreSQL + pgvector (Supabase) · Prisma · React (Vite) · Google Gemini (free tier)

## Architecture (Phase 1)

```
Upload:  PDF → pdf-parse → chunk (700 chars, ~15% overlap) → Gemini embeddings → pgvector
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

5. Open http://localhost:5173, upload a PDF, ask a question.

## Roadmap

- [x] **Phase 1 — MVP:** upload → chunk → embed → retrieve → cited answer
- [ ] **Phase 2:** hybrid search, re-ranking, confidence guardrail, access control
- [ ] **Phase 3:** evaluation harness (retrieval precision, faithfulness)
- [ ] **Phase 4:** deploy + logging
