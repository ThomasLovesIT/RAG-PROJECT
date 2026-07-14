// Phase 2 retrieval pipeline — the shared core used by BOTH the chat route and
// the Phase 3 eval harness (so the eval measures exactly what users get).
//
//   question
//     ├─ embed ──► vector search (cosine)      ┐
//     └─────────► full-text search (tsvector)  ┘ top-20 each
//                          │
//                 Reciprocal Rank Fusion (RRF)  → ranked shortlist
//                          │
//              (optional) LLM re-rank           → top-3
//
// WHY fuse two searches: vector search captures MEANING ("locked account" ≈
// "account lockout") but blurs exact tokens; full-text nails literal strings
// (error codes, "TICKET-4213", product names) but misses paraphrase. RRF is the
// simplest robust way to combine two ranked lists without tuning score scales:
// a chunk's fused score is the sum of 1/(k + rank) across the lists it appears
// in, so agreeing near the top of both lists wins.

import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { embedQuery, rerankChunks } from "./gemini.js";

// How many candidates each search contributes before fusion. 20 is the spec's
// number: wide enough to catch the right chunk even when one search ranks it
// mid-list, narrow enough that the LLM re-rank stays cheap.
const PER_SEARCH_LIMIT = 20;
// Shortlist size handed to the re-ranker (or returned directly when rerank off).
const CANDIDATE_POOL = 12;
// Final chunks sent to the answer LLM.
const FINAL_K = 3;
// RRF dampening constant. 60 is the value from the original RRF paper; it keeps
// any single list from dominating just because it ranked something #1.
const RRF_K = 60;

/**
 * Retrieve the best chunks for a question.
 *
 * @param {string} question
 * @param {{ role?: "IT_STAFF"|"EMPLOYEE", rerank?: boolean }} opts
 * @returns {Promise<{ chunks: object[], maxSimilarity: number, candidateCount: number, usage: object }>}
 *   `maxSimilarity` is the best cosine similarity in the pool — the honest
 *   signal for the confidence guardrail (RRF scores aren't comparable across
 *   queries, cosine similarity is).
 */
export async function retrieve(question, { role = "EMPLOYEE", rerank = false } = {}) {
  const queryVector = await embedQuery(question);
  const vec = JSON.stringify(queryVector);

  // Access control lives HERE, in the WHERE clause, so INTERNAL chunks never
  // enter the candidate pool for an EMPLOYEE — not hidden later in the UI.
  const visFilter =
    role === "IT_STAFF" ? Prisma.empty : Prisma.sql`AND a."visibility" = 'PUBLIC'`;

  const candidates = await hybridSearch(vec, question, visFilter);

  // Best cosine similarity across the whole pool (computed for every candidate
  // in the SQL below), used by the caller's confidence guardrail.
  const maxSimilarity = candidates.reduce(
    (m, r) => Math.max(m, Number(r.similarity) || 0),
    0
  );

  let chunks;
  let usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (rerank && candidates.length > 1) {
    const res = await rerankChunks(question, candidates, FINAL_K);
    chunks = res.chunks;
    usage = res.usage;
  } else {
    chunks = candidates.slice(0, FINAL_K);
  }

  return { chunks, maxSimilarity, candidateCount: candidates.length, usage };
}

// One round-trip that runs both searches and fuses them in SQL.
//   vec CTE  — top-20 by cosine distance (most similar first)
//   fts CTE  — top-20 by ts_rank on the generated tsvector
//   fused    — FULL OUTER JOIN so a chunk in either list survives; RRF score
//   final    — re-computes cosine similarity for EVERY surviving chunk (so
//              full-text-only hits still get an honest similarity for the UI
//              and the confidence guardrail), ordered by fused score.
async function hybridSearch(vec, question, visFilter) {
  return prisma.$queryRaw(Prisma.sql`
    WITH vec AS (
      SELECT c."id",
             row_number() OVER (ORDER BY c."embedding" <=> ${vec}::vector) AS rank
      FROM "Chunk" c
      JOIN "KBArticle" a ON a."id" = c."articleId"
      WHERE c."embedding" IS NOT NULL
      ${visFilter}
      ORDER BY c."embedding" <=> ${vec}::vector
      LIMIT ${PER_SEARCH_LIMIT}
    ),
    fts AS (
      SELECT c."id",
             row_number() OVER (
               ORDER BY ts_rank(c."contentTsv", plainto_tsquery('english', ${question})) DESC
             ) AS rank
      FROM "Chunk" c
      JOIN "KBArticle" a ON a."id" = c."articleId"
      WHERE c."contentTsv" @@ plainto_tsquery('english', ${question})
      ${visFilter}
      ORDER BY ts_rank(c."contentTsv", plainto_tsquery('english', ${question})) DESC
      LIMIT ${PER_SEARCH_LIMIT}
    ),
    fused AS (
      SELECT COALESCE(vec."id", fts."id") AS id,
             COALESCE(1.0 / (${RRF_K} + vec.rank), 0)
               + COALESCE(1.0 / (${RRF_K} + fts.rank), 0) AS rrf
      FROM vec
      FULL OUTER JOIN fts ON vec."id" = fts."id"
    )
    SELECT c."id",
           c."content",
           c."chunkIndex",
           a."id"       AS "articleId",
           a."title"    AS "articleTitle",
           a."category" AS "category",
           a."source"   AS "source",
           fused.rrf    AS "rrf",
           1 - (c."embedding" <=> ${vec}::vector) AS "similarity"
    FROM fused
    JOIN "Chunk" c ON c."id" = fused.id
    JOIN "KBArticle" a ON a."id" = c."articleId"
    ORDER BY fused.rrf DESC
    LIMIT ${CANDIDATE_POOL}
  `);
}

export { FINAL_K };
