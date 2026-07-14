// Phase 3 evaluation harness — the "prove it works" step.
//
// Runs every question in questions.json through the REAL retrieval pipeline
// (lib/retrieval.js — same code the chat route uses) twice: once WITHOUT
// re-ranking and once WITH it. For each run it measures:
//
//   • precision@3  — was the correct source article among the top-3 chunks?
//     (the retrieval metric: did we FIND the right doc?)
//   • faithfulness — does the generated answer only use retrieved context?
//     judged by a second LLM call (the generation metric: did we USE it?)
//   • latency      — wall-clock per query.
//
// The headline is the BEFORE→AFTER difference: does re-ranking actually help,
// or does it just feel like it should?
//
//   node eval/seed.js       # once, to load the known corpus
//   node eval/run-eval.js   # add --fast to skip faithfulness (retrieval only)
//
// Free-tier rate limits: calls are paced and retried on 429. A full run is
// ~24 questions × 2 conditions, so expect a few minutes.

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { retrieve, FINAL_K } from "../src/lib/retrieval.js";
import { generateAnswer, judgeFaithfulness } from "../src/lib/gemini.js";
import { prisma } from "../src/lib/db.js";

// Self-throttle every Gemini call under the free-tier limit. The cap is
// ~5 req/min for gemini-2.5-flash; we default to 4 for headroom (retries and
// clock drift can otherwise nudge a 5/min pace over the line). gemini.js reads
// GEMINI_RPM per-call. Override for a paid key: `GEMINI_RPM=60 node eval/...`.
process.env.GEMINI_RPM ??= "4";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAST = process.argv.includes("--fast"); // retrieval-only, no answer/judge
// --limit N: only run the first N questions (conserves the daily free quota).
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

const allQuestions = JSON.parse(readFileSync(resolve(__dirname, "questions.json"), "utf8"));
const questions = allQuestions.slice(0, LIMIT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry LLM-bound work on transient rate-limit / 5xx errors so a single 429
// doesn't abort a 5-minute run.
async function withRetry(fn, label, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? err);
      const retryable = /429|rate|quota|timeout|ECONNRESET|500|503|overloaded|high demand/i.test(msg);
      if (!retryable || attempt >= tries) throw err;
      const backoff = 4000 * attempt; // linear backoff, up to ~20s on the last try
      console.warn(`  ! ${label} failed (${msg.slice(0, 80)}) — retry ${attempt} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

async function runCondition(rerank) {
  const label = rerank ? "AFTER re-rank" : "BEFORE re-rank";
  console.log(`\n=== ${label} ===`);

  let hits = 0; // correct source in top-3
  let faithfulYes = 0;
  let faithfulTotal = 0;
  let keywordHits = 0;
  let keywordTotal = 0;
  let latencySum = 0;
  const rows = [];

  for (const q of questions) {
    const t0 = Date.now();
    const { chunks } = await withRetry(
      () => retrieve(q.question, { role: q.role, rerank }),
      "retrieve"
    );
    const latencyMs = Date.now() - t0;
    latencySum += latencyMs;

    const top = chunks.slice(0, FINAL_K).map((c) => c.articleTitle);
    const hit = top.includes(q.expectedSource);
    if (hit) hits++;

    let faithful = null;
    let answer = null;
    if (!FAST) {
      // Non-fatal: if the free tier is exhausted even after retries, record this
      // question as un-judged (faithful=null) and keep going — precision@3 above
      // still counts, and a single blip shouldn't discard the whole run.
      try {
        answer = (await withRetry(() => generateAnswer(q.question, chunks), "answer")).text;
        faithful = (await withRetry(() => judgeFaithfulness(answer, chunks), "judge")).faithful;
        faithfulTotal++;
        if (faithful) faithfulYes++;

        // Secondary signal: did the answer surface the expected keyword(s)?
        if (q.mustContain?.length) {
          keywordTotal++;
          const lc = answer.toLowerCase();
          if (q.mustContain.some((k) => lc.includes(k.toLowerCase()))) keywordHits++;
        }
      } catch (err) {
        console.warn(`      (skipped faithfulness: ${String(err?.message ?? err).slice(0, 60)})`);
      }
    }

    console.log(
      `  ${hit ? "✓" : "✗"} p@3  ${faithful == null ? "" : faithful ? "✓ faithful " : "✗ UNFAITHFUL"} ` +
        `[${latencyMs}ms] ${q.question.slice(0, 55)}`
    );
    if (!hit) console.log(`      expected "${q.expectedSource}", got: ${top.join(", ") || "(none)"}`);

    rows.push({ question: q.question, expectedSource: q.expectedSource, top3: top, hit, faithful, latencyMs });
  }

  const n = questions.length;
  return {
    label,
    rerank,
    precisionAt3: hits / n,
    faithfulnessRate: faithfulTotal ? faithfulYes / faithfulTotal : null,
    keywordRecall: keywordTotal ? keywordHits / keywordTotal : null,
    avgLatencyMs: Math.round(latencySum / n),
    n,
    rows,
  };
}

function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const before = await runCondition(false);
  const after = await runCondition(true);

  console.log("\n\n================ RESULTS ================");
  console.log(`Questions: ${before.n}${FAST ? "  (--fast: retrieval only)" : ""}\n`);
  const col = (s) => String(s).padEnd(22);
  console.log(col("Metric") + col("Before re-ranking") + col("After re-ranking"));
  console.log("-".repeat(66));
  console.log(col("Retrieval precision@3") + col(pct(before.precisionAt3)) + col(pct(after.precisionAt3)));
  console.log(col("Faithfulness rate") + col(pct(before.faithfulnessRate)) + col(pct(after.faithfulnessRate)));
  console.log(col("Keyword recall") + col(pct(before.keywordRecall)) + col(pct(after.keywordRecall)));
  console.log(col("Avg. latency") + col(before.avgLatencyMs + " ms") + col(after.avgLatencyMs + " ms"));
  console.log("========================================\n");

  const out = { generatedAt: new Date().toISOString(), fast: FAST, before, after };
  const outPath = resolve(__dirname, "results.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Full per-question results written to ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
