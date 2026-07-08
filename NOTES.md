# NOTES.md — my running log (in my own words)

> Rule: after each phase, I write one paragraph here myself — not copy-pasted.
> This becomes my interview prep.

## Phase 1 — MVP (ingest → chunk → embed → retrieve → cited answer)

_(write your own summary here after Phase 1 works — prompts to answer:)_

- Why do we chunk runbooks instead of embedding a whole document?
- Why does chunk overlap exist? What breaks without it?
- Walk through what happens, step by step, when an agent types a support question and hits Ask.
- Why must the query be embedded with the same model as the documents?
- What does cosine similarity actually measure? What does the `<=>` operator do?
- Why does the prompt say "answer ONLY from the context"? What would a hallucinated troubleshooting step look like, and why is that dangerous on a live helpdesk?
- Why do KBArticle rows carry `visibility`/`ownerId` already, even though Phase 1 doesn't enforce them?

## Phase 2 — hybrid search, re-ranking, confidence guardrail, access control

_(later — key question to be able to answer: why must the visibility filter run
before retrieval, not in the UI?)_

## Phase 3 — evaluation harness

_(later — key question: what do precision@3 and faithfulness each catch that
the other doesn't?)_
