// All AI-provider calls live in this one file.
// WHY: if you later swap Gemini for OpenAI/Anthropic, you rewrite ~60 lines
// here and the rest of the pipeline (chunking, storage, retrieval, routes)
// doesn't change. This is the "port/adapter" idea in miniature.

import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-001";
const CHAT_MODEL = "gemini-2.5-flash";

// Must match the vector(1536) column in schema.prisma. If you ever change
// one, you must change the other AND re-embed every stored chunk — embeddings
// of different dimensions (or from different models) are not comparable.
export const EMBEDDING_DIMS = 1536;

// Optional self-throttle for generateContent calls. Gemini's free tier caps
// gemini-2.5-flash at ~5 requests/minute; batch jobs (the Phase 3 eval) blow
// through that instantly. Set GEMINI_RPM to space calls at least 60/RPM ms
// apart. Unset (production) = no gating, zero added latency. Read per-call so
// a script can set it in-process before running.
let gateChain = Promise.resolve();
function gate() {
  const rpm = Number(process.env.GEMINI_RPM) || 0;
  if (rpm <= 0) return Promise.resolve();
  const gap = Math.ceil(60000 / rpm);
  // Serialize callers onto a chain, each waiting `gap` after the previous.
  const wait = gateChain.then(() => new Promise((r) => setTimeout(r, gap)));
  gateChain = wait;
  return wait;
}

let client;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey");
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/**
 * Embed an array of texts. Returns an array of number[] (one per input).
 *
 * WHY taskType matters: Gemini trains its embedding model so that documents
 * and queries land in slightly different "roles" of the same vector space.
 * Tagging documents as RETRIEVAL_DOCUMENT and questions as RETRIEVAL_QUERY
 * measurably improves how well a short question matches a long passage.
 */
export async function embedTexts(texts, taskType = "RETRIEVAL_DOCUMENT") {
  const ai = getClient();
  const results = [];

  // Batch requests to stay friendly with free-tier rate limits.
  // WHY 10: small enough that one failed batch loses little work, large
  // enough that a 50-chunk PDF is 5 round-trips instead of 50.
  const BATCH_SIZE = 10;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch,
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIMS,
      },
    });
    for (const e of response.embeddings) {
      // WHY normalize: when you truncate gemini-embedding-001 below its native
      // 3072 dims, the vectors are no longer unit-length. Cosine distance
      // (which we use in pgvector) is scale-invariant so search still works,
      // but normalizing keeps the raw similarity numbers in a sane, comparable
      // range — important for the Phase 2 confidence threshold.
      results.push(normalize(e.values));
    }
  }
  return results;
}

/** Embed a single user question. */
export async function embedQuery(text) {
  const [vec] = await embedTexts([text], "RETRIEVAL_QUERY");
  return vec;
}

function normalize(values) {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

/**
 * Generate an answer grounded ONLY in the retrieved chunks.
 *
 * WHY the strict system prompt: this is the core anti-hallucination control
 * in RAG. Without "use ONLY the context / say you don't know", the model will
 * happily blend retrieved facts with its own training data, and you can no
 * longer tell users where an answer came from.
 */
export async function generateAnswer(question, chunks) {
  const ai = getClient();

  // Number each chunk so the model can cite [1], [2]... and we can map those
  // citations back to real KB articles in the UI.
  const context = chunks
    .map((c, i) => `[${i + 1}] (from "${c.articleTitle}", ${c.source ?? "KB"}, category: ${c.category ?? "General"})\n${c.content}`)
    .join("\n\n---\n\n");

  const prompt = `You are an IT helpdesk assistant. Answer the support question using ONLY the knowledge-base context below.

Rules:
- If the context does not contain enough information to answer, reply exactly: "I don't have enough information in the knowledge base to answer that — please escalate to a human agent."
- Cite sources inline using the bracketed numbers, e.g. "Unlock the account with Unlock-ADAccount [2]."
- Give steps in the order the source gives them; do not invent extra troubleshooting steps.
- Do not use any knowledge outside the provided context.

Context:
${context}

Question: ${question}`;

  await gate();
  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: prompt,
  });

  // Return usage alongside the text so the route can log tokens/cost (Phase 4).
  return { text: response.text, usage: usageOf(response) };
}

/**
 * Re-rank retrieved candidates with the LLM, keeping the best `topN`.
 *
 * WHY re-rank at all: vector + full-text search are fast but only *approximate*
 * relevance — they score passages without truly reading the question. A second
 * pass where the model actually compares each candidate to the question is
 * slower but far more precise, so we run it only on the ~12-candidate shortlist,
 * never the whole KB. (The spec suggests Cohere/a cross-encoder; we use Gemini
 * so the project needs no extra API key — the Phase 3 eval measures the lift.)
 *
 * Returns { chunks, usage }. On any parse failure it falls back to the input
 * order (RRF) so a flaky rerank call can never drop retrieval to zero results.
 */
export async function rerankChunks(question, chunks, topN) {
  const ai = getClient();

  const passages = chunks
    .map((c, i) => `[${i}] ${c.content.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `You are ranking knowledge-base passages by how well each one answers an IT support question.

Return ONLY a JSON array of passage numbers, most relevant first, containing at most ${topN} entries. Example: [3, 0, 7]. No prose, no code fences.

Passages:
${passages}

Question: ${question}`;

  await gate();
  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: prompt,
    config: { temperature: 0 },
  });

  const order = parseIndexArray(response.text, chunks.length);
  const ranked =
    order.length > 0
      ? order.slice(0, topN).map((i) => chunks[i])
      : chunks.slice(0, topN); // fallback: keep RRF order

  return { chunks: ranked, usage: usageOf(response) };
}

// Pull integer indices out of the model's reply, ignoring anything that isn't a
// valid in-range passage number. Tolerant of stray text/code fences.
function parseIndexArray(text, length) {
  const match = (text ?? "").match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const n of arr) {
      if (Number.isInteger(n) && n >= 0 && n < length && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Faithfulness judge (Phase 3 eval): does the ANSWER stay grounded in CONTEXT?
 *
 * WHY a second LLM call: precision@3 checks whether retrieval FOUND the right
 * doc; faithfulness checks whether generation actually USED it instead of the
 * model's own memory. A confident, well-cited, but fabricated troubleshooting
 * step passes retrieval and fails here — that's the failure this catches.
 * A refusal ("not enough information") is faithful by definition (invents nothing).
 *
 * Returns { faithful: boolean, usage }.
 */
export async function judgeFaithfulness(answer, chunks) {
  const ai = getClient();
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n---\n\n");

  const prompt = `You are auditing a RAG assistant for faithfulness. Given the CONTEXT and the ANSWER, decide whether EVERY factual claim in the ANSWER is supported by the CONTEXT.

Reply with exactly one word: YES if the answer is fully grounded in the context (or the answer is a refusal/"I don't know"), or NO if it contains any claim not supported by the context.

CONTEXT:
${context}

ANSWER:
${answer}`;

  await gate();
  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: prompt,
    config: { temperature: 0 },
  });

  const verdict = (response.text ?? "").trim().toUpperCase();
  return { faithful: verdict.startsWith("YES"), usage: usageOf(response) };
}

// Gemini returns token counts in usageMetadata. Normalize to a small shape the
// rest of the app logs without caring about the SDK's field names.
function usageOf(response) {
  const u = response?.usageMetadata ?? {};
  return {
    promptTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokenCount ?? 0,
  };
}
