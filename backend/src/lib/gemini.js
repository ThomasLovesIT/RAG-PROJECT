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
  // citations back to real documents in the UI.
  const context = chunks
    .map((c, i) => `[${i + 1}] (from "${c.documentTitle}")\n${c.content}`)
    .join("\n\n---\n\n");

  const prompt = `You are a study assistant. Answer the question using ONLY the context below.

Rules:
- If the context does not contain enough information to answer, reply exactly: "I don't have enough information in the uploaded documents to answer that."
- Cite sources inline using the bracketed numbers, e.g. "Heaps are built in O(n) [2]."
- Do not use any knowledge outside the provided context.

Context:
${context}

Question: ${question}`;

  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: prompt,
  });

  return response.text;
}
