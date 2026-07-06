# Deliverables — Klerk Mission

Two checkpoints: **Milestone M1 at 48h** (gate) and the **final delivery at day 7**, followed by a 30-minute defense call. Everything below is mandatory unless marked bonus.

---

## Milestone M1 — 48 hours after kickoff (hard gate)

Purpose: catch design problems before they cost you (and us) the week. We review within a few hours and either green-light or ask for adjustments. **Do not build past M1 without our green light.**

Deliver, in the repo (draft quality is fine — decisions matter, polish doesn't):

1. **`ARCHITECTURE.md` (draft)** covering at minimum:
   - Component diagram: webhook receiver, queue/workers, DB, external APIs, dashboard.
   - The document **state machine** (states + transitions + what triggers each).
   - Your **three-way router** approach (rules / LLM / hybrid) for Flow E.
   - Your **dedupe** strategy and your **ANALYTIC-query safety** approach (NFR-3 choice).
   - A short "Assumptions & open questions" list — every decision you made where the spec was silent.
2. **Database schema** — SQL migration file(s) or dbml: documents, chunks/embeddings, conversations & pending confirmations, jobs, journal mirror.
3. **Sequence diagram of Flow A** (WhatsApp photo → confirmation message), any format (Mermaid welcome).

Send us the repo link (private GitHub repo, invite `<GITHUB_HANDLE_TO_FILL>`) with an issue or short message titled `M1 ready`.

---

## Final delivery — day 7

### 1. Running system

- Backend deployed (Render or equivalent free tier) with the Unipile webhook live.
- Dashboard deployed (Vercel or same host).
- The **full test corpus ingested** (all `whatsapp_inbox/` items sent over WhatsApp, all 3 `.eml` injected into the test Gmail), with the resulting Drive folder, Sheets journal, and dashboard state left intact for our inspection.
- Temporary read access for grading: share the test Google account's Drive folder + Sheet with `<EMAIL_TO_FILL>`, and keep the dashboard URL up.

### 2. Repository (private GitHub, we are invited)

- Full commit history — small, atomic commits. We read the history; a single giant commit is a red flag.
- `README.md`: prerequisites, account setup pointers, env vars, install & run, how to run the eval script, how to trigger the monthly recap manually, how to replay a webhook (NFR-1 proof).
- `ARCHITECTURE.md` (final): the M1 content, updated, plus tradeoffs you accepted (chunking strategy and why, router accuracy observations, queue/backoff parameters, what you would change with more time).
- `.env.example` — complete, commented.
- Seed/reset script (wipe DB state + Gmail labels + Drive test folder so a grader can re-run from zero).
- **Eval script**: ingest-assumed, runs the 8 public questions end-to-end (real WhatsApp round-trip or direct pipeline invocation — document which), prints per-question pass/fail and a summary. Machine-readable output (JSON) is a bonus.

### 3. Loom video — 10 minutes maximum

Structure it exactly like this (we grade against it):

1. **(≈5 min) Live demo**: send one photo invoice on WhatsApp end-to-end (confirmation, Drive, Sheet row); show one low-confidence interaction; inject or show one email ingestion; ask three questions live — one ANALYTIC, one CONTENT with citation, and one that has **no answer** in the corpus.
2. **(≈3 min) Architecture walkthrough**: state machine, queue, router — on your diagram, not by scrolling code.
3. **(≈2 min) Honest limits**: what is fragile, what you would do next.

No editing tricks, one take preferred. If something fails on camera and you recover cleanly, that is worth more to us than a flawless cut.

### 4. Defense call — 30 minutes (scheduled after delivery)

Live discussion on your code and design. Expect questions like "why this chunk size?", "what happens if two uploads arrive simultaneously?", "walk me through what happens when Mistral returns 429 mid-batch". You may share your screen; you may not bring notes generated for you. Using AI to *build* was expected; being unable to *explain* what you built is disqualifying.

---

## Practical notes

- **Timesheet honesty**: tell us roughly how many hours you actually spent. It does not affect the grade; it calibrates our expectations for future work.
- Questions during the mission: batch them into GitHub issues (label `question`). We answer once a day. Blocking ambiguities: mark `blocking` — we answer faster. The *quality* of your questions is itself a positive signal; asking nothing all week and delivering something misaligned is the worst outcome.
- Compensation and exact dates are as agreed in our conversation — this pack does not override them.
