// Query pipeline: question → embed → vector search → LLM answer with citations.
//
// Step by step, when a query comes in:
//   1. Embed the question with the SAME model (and dims) used for documents —
//      vectors from different models live in different spaces and can't be
//      compared.
//   2. Ask Postgres for the 5 stored chunks whose vectors are closest to the
//      question vector (cosine distance, `<=>`).
//   3. Hand ONLY those 5 chunks to the LLM with strict "answer from context,
//      cite sources" instructions.
//   4. Return the answer plus the chunks themselves, so the UI can show the
//      user exactly what the answer was based on.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { embedQuery, generateAnswer } from "../lib/gemini.js";

const router = Router();

// WHY top-5 (not 1, not 50): too few and the answer's supporting facts might
// be spread across chunks you didn't fetch; too many and you stuff the prompt
// with noise the model may cite incorrectly (plus you pay for every token).
// Phase 2 changes this to top-20 → re-rank → top-3.
const TOP_K = 5;

// POST /api/chat  { "question": "..." }
router.post("/", async (req, res) => {
  try {
    const question = (req.body?.question ?? "").trim();
    if (!question) {
      return res.status(400).json({ error: "Missing 'question' in request body" });
    }

    // Role drives the visibility filter. In production this comes from a
    // verified JWT/session — here the client sends it so we can demo both paths.
    const role = (req.body?.role ?? "EMPLOYEE").toUpperCase();
    if (!["IT_STAFF", "EMPLOYEE"].includes(role)) {
      return res.status(400).json({ error: "role must be IT_STAFF or EMPLOYEE" });
    }

    // IT staff can retrieve INTERNAL docs; employees see PUBLIC docs only.
    // The filter lives in SQL so restricted content never reaches the LLM,
    // not just hidden in the UI after retrieval.
    const visFilter =
      role === "IT_STAFF"
        ? Prisma.sql``
        : Prisma.sql`AND a."visibility" = 'PUBLIC'`;

    // 1. Embed the question (RETRIEVAL_QUERY role — see gemini.js)
    const queryVector = await embedQuery(question);

    // 2. Similarity search — raw SQL because Prisma can't type vector ops.
    //    `<=>` is pgvector's cosine DISTANCE operator (0 = identical,
    //    2 = opposite), so `1 - distance` gives the familiar cosine
    //    similarity where higher = better.
    //    ORDER BY embedding <=> query scans/indexes by distance ascending,
    //    i.e. most similar first.
    //    visFilter adds `AND a."visibility" = 'PUBLIC'` here for EMPLOYEE role —
    //    access control lives in this WHERE clause, BEFORE chunks reach the LLM.
    const vec = JSON.stringify(queryVector);
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT c."id",
             c."content",
             c."chunkIndex",
             a."id"       AS "articleId",
             a."title"    AS "articleTitle",
             a."category" AS "category",
             a."source"   AS "source",
             1 - (c."embedding" <=> ${vec}::vector) AS "similarity"
      FROM "Chunk" c
      JOIN "KBArticle" a ON a."id" = c."articleId"
      WHERE c."embedding" IS NOT NULL
      ${visFilter}
      ORDER BY c."embedding" <=> ${vec}::vector
      LIMIT ${TOP_K}
    `);

    if (rows.length === 0) {
      return res.json({
        answer: "The knowledge base is empty. Upload a runbook, FAQ, or ticket writeup first.",
        sources: [],
      });
    }

    // 3. Confidence guardrail — if even the best chunk isn't similar enough,
    //    the KB doesn't cover this topic. Better to escalate than to hallucinate.
    //    0.75 is the threshold: below it, retrieval is unreliable.
    const CONFIDENCE_THRESHOLD = 0.75;
    const topScore = Number(rows[0].similarity);
    if (topScore < CONFIDENCE_THRESHOLD) {
      return res.json({
        answer:
          "I don't have enough information in the knowledge base to answer this confidently. Please escalate to a human IT agent.",
        sources: rows.map((r, i) => ({
          ref: i + 1,
          articleTitle: r.articleTitle,
          similarity: Number(r.similarity.toFixed(4)),
          excerpt: r.content.slice(0, 150) + "…",
        })),
        escalated: true,
      });
    }

    // 4. Generate the grounded answer
    const answer = await generateAnswer(question, rows);

    // 5. Return answer + sources. Exposing similarity scores now builds the
    //    intuition you'll need for Phase 2's confidence threshold ("below
    //    what score do results stop being relevant?").
    res.json({
      answer,
      sources: rows.map((r, i) => ({
        ref: i + 1, // matches the [n] citations in the answer text
        articleId: r.articleId,
        articleTitle: r.articleTitle,
        category: r.category,
        source: r.source,
        chunkIndex: r.chunkIndex,
        similarity: Number(r.similarity.toFixed(4)),
        // Preview only — the full chunk is often 700 chars of context the
        // user doesn't need to read to trust the citation.
        excerpt: r.content.length > 300 ? r.content.slice(0, 300) + "…" : r.content,
      })),
    });
  } catch (err) {
    console.error("Chat failed:", err);
    res.status(500).json({ error: err.message ?? "Chat failed" });
  }
});

export default router;
