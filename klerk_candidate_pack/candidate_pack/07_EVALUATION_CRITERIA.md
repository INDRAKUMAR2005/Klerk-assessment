# Evaluation Criteria — Klerk Mission

We publish the grading grid on purpose: knowing where the points are lets you spend your effort where we value it. The grade is out of **100 points**, plus up to **+10 bonus**. Grading uses the official test corpus plus a private extension of the same style (same document types, same question patterns — build for the pattern, not for the sample).

## Grid (100 points)

### 1. Pipeline correctness & robustness — 25 pts
- Extraction accuracy on the corpus: types, suppliers, dates, amounts (French formats), due dates, chantier refs. *(10)*
- Correct behavior on hard inputs: degraded photos, the unreadable document path (asks, never invents), documents with no amounts, non-invoice attachments correctly ignored. *(8)*
- Duplicate detection across channels + `forcer` override. *(4)*
- VAT sanity check flags what it should, files it anyway, reports it. *(3)*

### 2. Engineering quality — 20 pts
- NFR-1 idempotence, demonstrated (webhook replay changes nothing). *(5)*
- NFR-2 queue + backoff under a 10-document burst on the rate-limited free tier. *(5)*
- State machine + structured logs: any document's position and history are traceable (NFR-6). *(4)*
- Code quality: TypeScript strict, structure, money handling (NFR-7), config hygiene (NFR-8). *(4)*
- Commit history: atomic, readable, honest. *(2)*

### 3. RAG & router quality — 20 pts
- Router: the three paths exist and route correctly on our question set. *(6)*
- CONTENT answers: grounded, correct, **cited with Drive links**. *(6)*
- HYBRID: retrieval/filtering + database arithmetic (never LLM arithmetic). *(4)*
- Honest "not found" behavior. *(2)*
- Chunking is structure-aware and justified in ARCHITECTURE.md. *(2)*

### 4. Integrations correctness — 15 pts
- Unipile: webhook handling, media download, replies, pending-confirmation context handled without mis-attribution (F-1.7). *(6)*
- Google: OAuth scopes minimal and justified; Drive structure + naming convention exact; Sheets journal conforms; Gmail labels + no double-processing. *(6)*
- Monthly recap email: content complete (totals, anomalies, Drive link, CSV), French, manual trigger works. *(3)*

### 5. Product sense & UX — 10 pts
- WhatsApp messages: French, short, one question max, natural for a non-technical artisan. *(5)*
- Confirmation/reminder flows feel effortless; edge messages (unsupported media) handled politely. *(3)*
- Dashboard: legible, accurate, honest about states. *(2)*

### 6. Documentation & defense — 10 pts
- ARCHITECTURE.md: real decisions, real tradeoffs, assumptions listed. *(4)*
- README reproducibility + eval script quality. *(3)*
- Loom + defense call: you can explain and justify everything you shipped. *(3)*

## Bonus — up to +10
- Embedding-based semantic dedupe as an additional duplicate signal. *(+3)*
- Dynamic few-shot email classification (retrieve similar past classifications). *(+2)*
- Gmail push notifications via Pub/Sub instead of polling. *(+2)*
- Dashboard live updates via Supabase Realtime. *(+1)*
- Cost/latency instrumentation: tokens, Mistral calls and per-document latency visible per pipeline run. *(+2)*

## Automatic fails (any single one ends the evaluation)

1. **Fabricated data**: any invented amount, date, or supplier presented as extracted or as an answer (NFR-5 / F-5.4).
2. **Secrets committed** to the repository (any point in history).
3. **Raw LLM-generated SQL executed without validation** against the database (NFR-3).
4. Inability to explain your own code at the defense call.
5. Plagiarized/cloned project presented as original work.

## What we are really evaluating

A production mindset on an agentic document pipeline: correctness under messy input, safety under retries and rate limits, honesty under uncertainty, and communication a French artisan would actually tolerate. A smaller scope done rigorously beats full scope done fragile — if you must cut, cut bonus and dashboard polish, never NFR-1/2/5.
