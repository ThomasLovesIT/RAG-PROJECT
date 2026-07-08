-- Enable pgvector before anything references the vector type.
-- Hand-written (Prisma doesn't manage extensions here — see schema.prisma).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('RUNBOOK', 'FAQ', 'PAST_TICKET');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('INTERNAL', 'PUBLIC');

-- CreateTable
CREATE TABLE "KBArticle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" "Source" NOT NULL DEFAULT 'RUNBOOK',
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "ownerId" TEXT NOT NULL DEFAULT 'it-staff',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KBArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "chunkIndex" INTEGER NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chunk_articleId_idx" ON "Chunk"("articleId");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KBArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
