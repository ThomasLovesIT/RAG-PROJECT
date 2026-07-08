// Chunking strategy: ~700-char chunks with ~15% overlap, split on paragraph
// boundaries when possible.
//
// WHY chunk at all: embeddings compress a text into ONE vector. Embed a whole
// 30-page PDF and the vector is a mushy average of every topic in it — a
// specific question won't match it well. Embed tiny fragments and each vector
// is precise but carries no context. 500–800 chars is the empirical sweet
// spot for lecture-note-style text: about one coherent idea per chunk.
//
// WHY overlap: a hard cut at every N chars will sometimes split a sentence or
// definition across two chunks, so neither chunk fully "contains" the answer.
// Repeating the tail of each chunk at the head of the next (~15%) means any
// idea near a boundary appears intact in at least one chunk. The cost is
// ~15% more storage and embedding calls — cheap insurance.

const CHUNK_SIZE = 700; // target characters per chunk
const OVERLAP = 100; // ~15% of CHUNK_SIZE

export function chunkText(text) {
  // PDFs extract with messy whitespace (form feeds, triple newlines).
  // Normalize first so chunk boundaries are meaningful.
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // Split into paragraphs first — a paragraph is the author's own "one idea"
  // boundary, so we prefer never to cut through one.
  const paragraphs = cleaned.split(/\n\n+/);

  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    // Paragraph longer than a whole chunk: fall back to sentence-ish splits.
    if (para.length > CHUNK_SIZE) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = tail(current);
      }
      for (const piece of splitLong(para)) {
        chunks.push(piece.trim());
      }
      current = tail(chunks[chunks.length - 1] ?? "");
      continue;
    }

    // Would adding this paragraph overflow the chunk? Flush and start a new
    // one seeded with the overlap tail of the old one.
    if (current.length + para.length + 2 > CHUNK_SIZE && current.trim()) {
      chunks.push(current.trim());
      current = tail(current);
    }
    current += (current ? "\n\n" : "") + para;
  }

  if (current.trim()) chunks.push(current.trim());

  // Drop near-empty fragments (page numbers, stray headers) — embedding them
  // wastes quota and they pollute search results.
  return chunks.filter((c) => c.length > 50);
}

/** Last OVERLAP chars of a chunk, snapped forward to a word boundary. */
function tail(text) {
  if (text.length <= OVERLAP) return text;
  const raw = text.slice(-OVERLAP);
  const firstSpace = raw.indexOf(" ");
  return firstSpace === -1 ? raw : raw.slice(firstSpace + 1);
}

/** Split an oversized paragraph on sentence ends, packing to CHUNK_SIZE. */
function splitLong(para) {
  const sentences = para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [para];
  const pieces = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > CHUNK_SIZE && current) {
      pieces.push(current);
      current = tail(current);
    }
    current += s;
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}
