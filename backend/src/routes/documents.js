// Ingestion pipeline: PDF upload → extract text → chunk → embed → store.
// This runs ONCE per document. The whole point of RAG's architecture is to
// pay the expensive work (parsing, embedding) at upload time so that query
// time is just one cheap embedding + one indexed DB lookup.

import { Router } from "express";
import multer from "multer";
// Import the inner module directly — pdf-parse's package entry point runs
// debug code when loaded via ESM import and crashes. Known upstream quirk.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { prisma } from "../lib/db.js";
import { chunkText } from "../lib/chunker.js";
import { embedTexts } from "../lib/gemini.js";
import { Prisma } from "@prisma/client";

const router = Router();

// memoryStorage: the PDF lives in RAM only for the duration of the request.
// WHY: we never need the original file again — only its extracted text — so
// writing it to disk would just create cleanup work and a data-leak surface.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — plenty for lecture PDFs
});

// POST /api/documents  (multipart form, field name "file")
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
    }

    // 1. Extract raw text
    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text ?? "";
    if (text.trim().length < 100) {
      // Scanned/image-only PDFs extract as (nearly) empty text. Better to
      // reject loudly than to silently store a document that can never match.
      return res.status(422).json({
        error: "Could not extract text from this PDF. Is it a scanned/image-only document?",
      });
    }

    // 2. Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return res.status(422).json({ error: "Document produced no usable chunks." });
    }

    // 3. Embed every chunk (the slow step — one API round-trip per batch)
    const embeddings = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

    // 4. Store. Document row via the typed client; chunk rows via raw SQL
    // because Prisma can't write to an Unsupported("vector") column.
    const title = req.file.originalname.replace(/\.pdf$/i, "");
    const document = await prisma.document.create({
      data: { title },
    });

    for (let i = 0; i < chunks.length; i++) {
      // pgvector accepts a '[0.1,0.2,...]' string literal cast to ::vector.
      // JSON.stringify of a number[] produces exactly that format.
      // $executeRaw uses parameterized queries — the content string is never
      // spliced into SQL, so no injection risk.
      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "documentId", "content", "embedding", "chunkIndex")
        VALUES (${cuidLike()}, ${document.id}, ${chunks[i]}, ${JSON.stringify(embeddings[i])}::vector, ${i})
      `;
    }

    res.status(201).json({
      id: document.id,
      title: document.title,
      chunkCount: chunks.length,
      // Surfacing these numbers teaches you what your pipeline actually did.
      stats: {
        pages: parsed.numpages,
        extractedChars: text.length,
        avgChunkChars: Math.round(text.length / chunks.length),
      },
    });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: err.message ?? "Upload failed" });
  }
});

// GET /api/documents — list what's been ingested (for the UI sidebar)
router.get("/", async (_req, res) => {
  const docs = await prisma.document.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { chunks: true } } },
  });
  res.json(
    docs.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt,
      chunkCount: d._count.chunks,
    }))
  );
});

// DELETE /api/documents/:id — chunks cascade via the FK's onDelete: Cascade
router.delete("/:id", async (req, res) => {
  try {
    await prisma.document.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Document not found" });
    }
    throw err;
  }
});

// Prisma normally generates cuids for us, but raw INSERTs bypass that.
// A timestamp + random suffix is unique enough for this project's scale.
function cuidLike() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export default router;
