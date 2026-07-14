-- Phase 2 hybrid search: add a full-text search column alongside the vector.
--
-- GENERATED ALWAYS ... STORED means Postgres computes and stores this tsvector
-- from "content" automatically: existing rows are backfilled at ALTER time and
-- every future INSERT/UPDATE keeps it in sync. The app never writes this column
-- (mirrors how it never hand-maintains a search index).
--
-- 'english' config = stemming + stop-word removal, so "disconnecting" matches
-- "disconnect" and noise words ("the", "a") don't dilute rank.
ALTER TABLE "Chunk"
  ADD COLUMN "contentTsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

-- GIN index: the standard index for tsvector; makes @@ (match) queries fast.
CREATE INDEX "Chunk_contentTsv_idx" ON "Chunk" USING GIN ("contentTsv");
