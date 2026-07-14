// Reset the KB to a known corpus (the 4 sample-docs) so the eval is repeatable.
//
// WHY a dedicated seed: the eval's precision@3 metric asks "was the CORRECT
// article in the top-3?" — that only means something against a fixed, known set
// of documents with known titles. Run this before run-eval.js.
//
//   node eval/seed.js
//
// Destructive: deletes ALL existing KBArticles (chunks cascade) first.

import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { prisma } from "../src/lib/db.js";
import { chunkText } from "../src/lib/chunker.js";
import { embedTexts } from "../src/lib/gemini.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "../../sample-docs");

// Per-document metadata. Title = filename without extension, matching how the
// upload route derives it — so eval `expectedSource` values line up.
// VPN FAQ is PUBLIC (all employees); the rest are INTERNAL (IT staff only),
// which is exactly what the access-control eval questions rely on.
const META = {
  "AD-Account-Lockout-Runbook": { category: "Account Access", source: "RUNBOOK", visibility: "INTERNAL" },
  "Incident-Response-Runbook": { category: "General", source: "RUNBOOK", visibility: "INTERNAL" },
  "TICKET-4213-Outlook-Stuck-Disconnected": { category: "Software", source: "PAST_TICKET", visibility: "INTERNAL" },
  "VPN-Troubleshooting-FAQ": { category: "Network", source: "FAQ", visibility: "PUBLIC" },
};

function cuidLike() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

async function main() {
  const files = readdirSync(DOCS_DIR).filter((f) => /\.(md|markdown|txt)$/i.test(f));
  if (files.length === 0) throw new Error(`No sample docs found in ${DOCS_DIR}`);

  console.log(`Wiping existing KB…`);
  await prisma.kBArticle.deleteMany({});

  for (const file of files) {
    const title = file.replace(/\.(md|markdown|txt)$/i, "");
    const meta = META[title] ?? { category: "General", source: "RUNBOOK", visibility: "INTERNAL" };
    const text = readFileSync(join(DOCS_DIR, file), "utf8");
    const chunks = chunkText(text);
    const embeddings = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

    const article = await prisma.kBArticle.create({
      data: { title, category: meta.category, source: meta.source, visibility: meta.visibility },
    });
    for (let i = 0; i < chunks.length; i++) {
      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "articleId", "content", "embedding", "chunkIndex")
        VALUES (${cuidLike()}, ${article.id}, ${chunks[i]}, ${JSON.stringify(embeddings[i])}::vector, ${i})
      `;
    }
    console.log(`  ✓ ${title}  (${chunks.length} chunks, ${meta.visibility})`);
  }
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
