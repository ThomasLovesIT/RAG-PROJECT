// Query pipeline: question → hybrid retrieve → (re-rank) → guardrail → cited answer.
//
// Step by step, when a query comes in:
//   1. Embed the question and run HYBRID search (vector + full-text), fused with
//      RRF — see lib/retrieval.js. Access control (INTERNAL vs PUBLIC) is applied
//      inside that SQL, so restricted chunks never enter the candidate pool.
//   2. Optionally LLM re-rank the shortlist down to the top-3.
//   3. Confidence guardrail: if the best cosine similarity is too low, the KB
//      doesn't cover this topic — escalate instead of hallucinating.
//   4. Hand ONLY the final chunks to the LLM with strict "answer from context,
//      cite sources" instructions, and return the chunks so the UI can show the
//      user exactly what the answer was based on.

import { Router } from "express";
import { retrieve } from "../lib/retrieval.js";
import { generateAnswer } from "../lib/gemini.js";

const router = Router();

// Below this cosine similarity, even the best-matching chunk isn't really about
// the question — retrieval is unreliable, so escalate. 0.75 is a deliberately
// conservative bar for a helpdesk (a wrong troubleshooting step is worse than
// "ask a human"). Tuned against real scores in the Phase 3 eval.
const CONFIDENCE_THRESHOLD = 0.75;

// Re-ranking is on by default; a request can turn it off (rerank:false) so the
// Phase 3 eval can measure the exact before/after lift.
const DEFAULT_RERANK = true;

// Rough Gemini 2.5 Flash pricing (USD per 1M tokens) for the per-query cost
// estimate. Free tier bills $0, but showing the would-be cost is the point.
const PRICE_IN_PER_M = 0.3;
const PRICE_OUT_PER_M = 2.5;

// POST /api/chat  { "question": "...", "role": "EMPLOYEE"|"IT_STAFF", "rerank": bool }
router.post("/", async (req, res) => {
  const started = Date.now();
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
    const rerank = req.body?.rerank ?? DEFAULT_RERANK;

    // 1–2. Hybrid retrieve (+ optional re-rank). All access control happens here.
    const { chunks, maxSimilarity, usage: rerankUsage } = await retrieve(question, {
      role,
      rerank,
    });

    if (chunks.length === 0) {
      logQuery({ question, role, rerank, escalated: true, started, note: "empty-kb" });
      return res.json({
        answer:
          "No matching documents found. The knowledge base may be empty, or nothing is visible to your role.",
        sources: [],
      });
    }

    // 3. Confidence guardrail — measured on cosine similarity, not the fused
    //    score (RRF scores aren't comparable across queries; cosine is).
    if (maxSimilarity < CONFIDENCE_THRESHOLD) {
      logQuery({ question, role, rerank, escalated: true, started, topScore: maxSimilarity });
      return res.json({
        answer:
          "I don't have enough information in the knowledge base to answer this confidently. Please escalate to a human IT agent.",
        sources: chunks.map((r, i) => ({
          ref: i + 1,
          articleTitle: r.articleTitle,
          similarity: round4(r.similarity),
          excerpt: r.content.slice(0, 150) + "…",
        })),
        escalated: true,
      });
    }

    // 4. Generate the grounded answer.
    const { text: answer, usage: answerUsage } = await generateAnswer(question, chunks);

    const usage = sumUsage(rerankUsage, answerUsage);
    const meta = logQuery({
      question,
      role,
      rerank,
      escalated: false,
      started,
      topScore: maxSimilarity,
      usage,
    });

    res.json({
      answer,
      sources: chunks.map((r, i) => ({
        ref: i + 1, // matches the [n] citations in the answer text
        articleId: r.articleId,
        articleTitle: r.articleTitle,
        category: r.category,
        source: r.source,
        chunkIndex: r.chunkIndex,
        similarity: round4(r.similarity),
        // Preview only — the full chunk is often 700 chars of context the
        // user doesn't need to read to trust the citation.
        excerpt: r.content.length > 300 ? r.content.slice(0, 300) + "…" : r.content,
      })),
      // Phase 4 per-query telemetry, surfaced to the UI too.
      meta,
    });
  } catch (err) {
    console.error("Chat failed:", err);
    // Don't leak the provider's raw error blob to the UI. Map the common,
    // expected failure (Gemini free-tier rate/quota limit) to a clean 429 with
    // a human message; everything else is a generic 500.
    if (isRateLimited(err)) {
      return res.status(429).json({
        error:
          "The AI service is rate-limited right now (Gemini free-tier quota reached). Please wait a minute and try again.",
      });
    }
    res.status(500).json({ error: "Something went wrong answering that. Please try again." });
  }
});

// Gemini's SDK throws with status 429 and a RESOURCE_EXHAUSTED / quota message
// for both the per-minute and per-day free-tier caps.
function isRateLimited(err) {
  if (err?.status === 429) return true;
  const msg = String(err?.message ?? "");
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg);
}

function round4(n) {
  return Number(Number(n).toFixed(4));
}

function sumUsage(a = {}, b = {}) {
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}

// Phase 4 logging: one line per query with latency, tokens, and a cost estimate.
// Returns the same meta object so the route can echo it to the client.
function logQuery({ question, role, rerank, escalated, started, topScore, usage }) {
  const latencyMs = Date.now() - started;
  const u = usage ?? { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  const costUsd =
    (u.promptTokens / 1e6) * PRICE_IN_PER_M + (u.outputTokens / 1e6) * PRICE_OUT_PER_M;
  const meta = {
    latencyMs,
    rerank,
    escalated,
    topScore: topScore != null ? round4(topScore) : null,
    tokens: u.totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
  };
  console.log(
    `[chat] role=${role} rerank=${rerank} escalated=${escalated} ` +
      `top=${meta.topScore} tokens=${meta.tokens} cost=$${meta.costUsd} ` +
      `latency=${latencyMs}ms q=${JSON.stringify(question.slice(0, 60))}`
  );
  return meta;
}

export default router;
