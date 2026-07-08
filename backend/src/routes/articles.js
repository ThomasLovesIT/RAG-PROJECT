// Ingestion pipeline: upload a KB doc (runbook/FAQ/ticket) → extract text →
// chunk → embed → store.
// This runs ONCE per article. The whole point of RAG's architecture is to
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

// memoryStorage: the file lives in RAM only for the duration of the request.
// WHY: we never need the original file again — only its extracted text — so
// writing it to disk would just create cleanup work and a data-leak surface.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — plenty for runbooks
});

const SOURCES = ["RUNBOOK", "FAQ", "PAST_TICKET"];
const VISIBILITIES = ["INTERNAL", "PUBLIC"];

// POST /api/articles  (multipart form: file, category, source, visibility)
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
    }

    // Validate metadata up front — bad enum values would otherwise surface as
    // a cryptic Prisma error after we've already paid for the embeddings.
    const category = (req.body.category ?? "").trim() || "General";
    const source = (req.body.source ?? "RUNBOOK").toUpperCase();
    const visibility = (req.body.visibility ?? "INTERNAL").toUpperCase();
    if (!SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of ${SOURCES.join(", ")}` });
    }
    if (!VISIBILITIES.includes(visibility)) {
      return res.status(400).json({ error: `visibility must be one of ${VISIBILITIES.join(", ")}` });
    }

    // 1. Extract raw text. Real IT knowledge bases are mostly Markdown
    // (runbooks, wiki exports) with the occasional PDF, so we accept both.
    // Markdown/plain text needs no parsing — chunking on paragraphs works
    // directly on it (headings/lists survive as readable context).
    const name = req.file.originalname;
    let text;
    let pages = null;
    if (/\.pdf$/i.test(name)) {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text ?? "";
      pages = parsed.numpages;
      if (text.trim().length < 100) {
        // Scanned/image-only PDFs extract as (nearly) empty text. Better to
        // reject loudly than to silently store an article that can never match.
        return res.status(422).json({
          error: "Could not extract text from this PDF. Is it a scanned/image-only document?",
        });
      }
    } else if (/\.(md|markdown|txt)$/i.test(name)) {
      text = req.file.buffer.toString("utf8");
    } else {
      return res.status(415).json({ error: "Unsupported file type. Upload a .pdf, .md, or .txt file." });
    }

    // 2. Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return res.status(422).json({ error: "Document produced no usable chunks." });
    }

    // 3. Embed every chunk (the slow step — one API round-trip per batch)
    const embeddings = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

    // 4. Store. Article row via the typed client; chunk rows via raw SQL
    // because Prisma can't write to an Unsupported("vector") column.
    const title = name.replace(/\.(pdf|md|markdown|txt)$/i, "");
    const article = await prisma.kBArticle.create({
      data: { title, category, source, visibility },
    });

    for (let i = 0; i < chunks.length; i++) {
      // pgvector accepts a '[0.1,0.2,...]' string literal cast to ::vector.
      // JSON.stringify of a number[] produces exactly that format.
      // $executeRaw uses parameterized queries — the content string is never
      // spliced into SQL, so no injection risk.
      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "articleId", "content", "embedding", "chunkIndex")
        VALUES (${cuidLike()}, ${article.id}, ${chunks[i]}, ${JSON.stringify(embeddings[i])}::vector, ${i})
      `;
    }

    res.status(201).json({
      id: article.id,
      title: article.title,
      category: article.category,
      source: article.source,
      visibility: article.visibility,
      chunkCount: chunks.length,
      // Surfacing these numbers teaches you what your pipeline actually did.
      stats: {
        pages,
        extractedChars: text.length,
        avgChunkChars: Math.round(text.length / chunks.length),
      },
    });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: err.message ?? "Upload failed" });
  }
});

// GET /api/articles — list what's been ingested (for the UI sidebar)
router.get("/", async (_req, res) => {
  const articles = await prisma.kBArticle.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { chunks: true } } },
  });
  res.json(
    articles.map((a) => ({
      id: a.id,
      title: a.title,
      category: a.category,
      source: a.source,
      visibility: a.visibility,
      createdAt: a.createdAt,
      chunkCount: a._count.chunks,
    }))
  );
});

// DELETE /api/articles/:id — chunks cascade via the FK's onDelete: Cascade
router.delete("/:id", async (req, res) => {
  try {
    await prisma.kBArticle.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Article not found" });
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
