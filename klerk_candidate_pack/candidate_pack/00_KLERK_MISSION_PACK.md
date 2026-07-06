# KLERK — Technical Test Mission Pack

**AI Administrative Assistant for French Tradespeople (WhatsApp-first)**

| | |
|---|---|
| Mission duration | 7 calendar days from kickoff |
| Checkpoint | Milestone M1 at 48h (see `06_DELIVERABLES.md`) |
| Required budget | **€0 — every service used has a free tier. No credit card is required at any point.** |
| Companion files | `05_TEST_DATASET/` · `06_DELIVERABLES.md` · `07_EVALUATION_CRITERIA.md` |

> **Read this entire document before writing a single line of code.** It contains everything: product context (Part 1), functional specification (Part 2), engineering constraints (Part 3), and account/setup instructions (Part 4). When the spec is silent on a detail, make the decision a real product engineer would make for the end user described in Part 1 — and write that decision down in your `ARCHITECTURE.md`.

---

# PART 1 — MISSION BRIEF (the "why")

## 1.1 Product context

Klerk is an AI administrative assistant for French **artisans** (independent tradespeople: plumbers, electricians, painters…). These are one-person or two-person businesses. They are excellent at their craft and terrible at paperwork — not because they can't do it, but because it happens in the evening, after 10 hours on job sites, and it is the last thing they want to do.

Their accountant needs a clean set of documents every month: supplier invoices, receipts, signed quotes. Today those documents live in a glovebox, a jacket pocket, and a chaotic email inbox.

**The core insight:** the artisan already has a reflex — when something matters, they take a photo with their phone and send it on WhatsApp. Klerk turns that reflex into a complete back office. **WhatsApp is the product's entire user interface for the artisan.** There is no app for them to install, no dashboard for them to learn.

## 1.2 The user

**Julien Moreau, 38, plumber & heating engineer in Lyon, France.**

- Runs "Moreau Plomberie Chauffage" with one apprentice.
- Lives on WhatsApp all day (clients, suppliers, his apprentice).
- Receives supplier invoices two ways: paper handed over at the counter/job site (→ he photographs them), and PDFs by email.
- Sends his accountant a shoebox of paper once a quarter. The accountant is not happy.
- Speaks French. All his documents are in French. **He will never read English.**
- Zero patience for software. If the assistant asks him more than one short question, he stops using it.

## 1.3 What Klerk does (elevator version)

1. Julien photographs any financial document (invoice, receipt, quote, delivery note) and sends it on WhatsApp. Or the document simply arrives in his Gmail.
2. Klerk reads it (OCR), understands it (LLM), files it in a tidy Google Drive folder structure, and logs it in a Google Sheets journal.
3. Klerk confirms on WhatsApp in one short French message — and asks a question **only** when it is genuinely unsure.
4. On the 1st of each month, Klerk emails the accountant a clean recap with a link to the month's Drive folder.
5. At any moment, Julien can ask questions in natural language on WhatsApp ("combien j'ai dépensé chez PlombiPro ?", "retrouve-moi le devis signé de Mme Martin") and get accurate, sourced answers.

## 1.4 User stories

- **US-1** — As Julien, I send a photo of a supplier invoice on WhatsApp and receive, within a reasonable time, one confirmation message telling me it's filed, where, for how much, and when it's due.
- **US-2** — As Julien, when the photo is bad or a value is unclear, Klerk asks me **one** precise question with its best guess ("Je lis 1 246,80 € mais la photo est floue — tu confirmes ?") instead of silently guessing.
- **US-3** — As Julien, invoices that arrive in my Gmail are filed automatically without me doing anything.
- **US-4** — As Julien, if I accidentally send the same invoice twice (or it arrives by both photo and email), Klerk detects it and does not create a duplicate.
- **US-5** — As Julien, I can ask questions about my documents in French on WhatsApp and get answers with a link to the source document in Drive.
- **US-6** — As Julien, when the answer isn't in my documents, Klerk says so. It never invents a number.
- **US-7** — As Julien, I can accept a payment-due reminder and receive it 3 days before the due date.
- **US-8** — As Julien's accountant, on the 1st of each month I receive one email in French with totals by category, the list of documents, detected anomalies, and a link to the month's Drive folder.
- **US-9** — As the operator (you, during the demo), I can open a minimal read-only web dashboard showing the document pipeline status and the journal, so I can see what the system is doing.

## 1.5 Explicitly OUT of scope

Do **not** build any of the following. Time spent here is time lost.

- Multi-user / multi-artisan support (single artisan, single WhatsApp number, single Gmail account).
- Authentication/roles on the dashboard (it's a read-only internal ops view; a static token or nothing is fine).
- Payments, payment tracking, bank reconciliation ("overdue" = due date in the past, purely informational).
- A mobile app or a rich web UI for the artisan (WhatsApp **is** the artisan UI).
- WhatsApp Cloud API / BSP migration (Unipile only for this mission).
- Accounting-software integrations, French e-invoicing (Factur-X/PDP) compliance.
- Multi-currency (EUR only), multi-language for the artisan (French only).
- Editing/correcting documents through the dashboard.

## 1.6 Language rules

- **Everything the artisan or the accountant sees is in French**: WhatsApp messages, the monthly email, journal values where user-facing.
- **Everything a developer sees is in English**: code, comments, commit messages, README, ARCHITECTURE.md, logs.
- The test dataset is in French on purpose — your OCR/extraction pipeline must handle French documents natively (accents, `1 246,80 €` number formatting, French dates).

---

# PART 2 — FUNCTIONAL SPECIFICATION (the "what")

Everything in this part is contractual: if it is written here, it must work in the demo. Numbered requirements (`F-x.y`) are individually checked during grading.

## 2.0 Document model

Every ingested item becomes a **Document** with, at minimum:

- `doc_type`: one of `supplier_invoice` | `receipt` | `quote` | `delivery_note` | `other`
- Extracted fields (per type, see F-2.4), each with a **confidence score in [0,1]**
- `channel`: `whatsapp` | `gmail`
- `status` (state machine, see NFR-6): `received → ocr_done → extracted → pending_confirmation → filed | rejected | duplicate_ignored`
- Source pointers: provider message id, original file hash, Drive file id once filed.

**Critical fields** (per doc type) are: `supplier_name`, `total_ttc`, `doc_date` — plus `due_date` for supplier invoices when present on the document.

## 2.1 Flow A — WhatsApp ingestion (Unipile)

- **F-1.1** An incoming WhatsApp message containing an image or a PDF (received via Unipile webhook) triggers the pipeline. Multiple attachments in one message are processed independently.
- **F-1.2** The pipeline: download media → dedupe check (F-2.6) → OCR (Mistral) → classification into `doc_type` → structured extraction (F-2.4) → confidence gate (F-2.5) → filing (Flow C) → WhatsApp confirmation.
- **F-1.3** Success confirmation is **one** French message following this template (adapt naturally):
  `✅ Facture SANITHERM LYON — 1 246,80 € — classée dans Compta > 2026 > 06-Juin > Fournisseurs. Échéance le 30/07. Tu veux un rappel 3 jours avant ? (oui/non)`
  The reminder question is asked only for supplier invoices with a due date in the future.
- **F-1.4** If the artisan answers `oui`, schedule a WhatsApp reminder at **09:00 Europe/Paris, 3 days before the due date**. If the due date is fewer than 3 days away, send the reminder the next morning at 09:00. `non` or no answer within 24h = no reminder.
- **F-1.5** A message that contains only text (no media) is routed to the Q&A flow (Flow E) — except when it is an answer to a pending confirmation (see F-2.5 / F-1.7).
- **F-1.6** Unsupported media (audio, video, contacts…) gets a polite French reply stating what Klerk accepts.
- **F-1.7** **Pending-confirmation context:** while a document awaits a user answer, other documents and questions may arrive. The agent must never mis-attribute an answer. If an incoming short answer ("oui", "c'est bon", "1246,80") could refer to more than one pending item, the agent must ask which one (e.g. by quoting supplier + amount). Design this explicitly; it is graded.

## 2.2 Flow B — Gmail ingestion

- **F-2.1** Klerk watches the connected Gmail inbox. Polling every 2–5 minutes is acceptable; Gmail push notifications (Pub/Sub) are a bonus, not a requirement.
- **F-2.2** Candidate emails are those with at least one PDF or image attachment. For each candidate email, an LLM classification step decides, from `(from, subject, body snippet, attachment filenames)`, whether the email plausibly carries financial documents. **Each attachment is then classified and processed independently** through the same pipeline as Flow A — an email can contain one real invoice among several irrelevant PDFs; only the relevant document(s) get filed.
- **F-2.3** Processed emails are labeled in Gmail: `Klerk/Processed` when at least one document was filed, `Klerk/Ignored` otherwise. An email must never be processed twice (idempotence on the Gmail message id).
- **F-2.4** **Structured extraction** (applies to both flows). Per `doc_type`, extract at minimum:
  - `supplier_invoice`: supplier name, supplier SIREN/VAT if present, invoice number, doc date, due date, total HT, total VAT, VAT rate(s), total TTC, chantier/job-site reference if present, line items (label, qty, unit price when readable).
  - `receipt`: merchant name, date, total TTC, VAT amount if printed.
  - `quote`: issuer, client name, quote number, date, total HT/TTC, signed or not (and signature date if visible).
  - `delivery_note`: supplier, number, date, referenced invoice/order if present.
  - All amounts must survive French formatting (`1 246,80 €`) and be stored numerically.
- **F-2.5** **Confidence gate:** if any critical field has confidence `< 0.75`, do not file silently. Ask the artisan **on WhatsApp** (single validation channel, regardless of the source channel) one question containing your best guess. The artisan's answer updates the document, which then proceeds to filing. If the document is unreadable to the point of having no usable guess, say so and ask for a better photo or the missing values. **Inventing a value is an automatic fail** (see `07_EVALUATION_CRITERIA.md`).
- **F-2.6** **Duplicate detection.** A new document is a duplicate if (a) exact file hash match with an already-processed file, or (b) same `doc_type` + same supplier + same total TTC (±0,01 €) + same doc date as an existing document — even when the files differ (e.g. a photo of an invoice whose PDF already arrived by email). Duplicates are **not** filed and **not** journaled as new rows; reply: `⚠️ Doublon probable de INV-2026-0612 (Sanitherm, 1 246,80 €), déjà classée le … . Réponds "forcer" pour la classer quand même.` The keyword `forcer` overrides. Embedding-based semantic similarity as an additional signal is a bonus.

## 2.3 Flow C — Filing conventions (Drive + Sheets)

- **F-3.1** Drive folder structure (created on demand):
  `Klerk/Compta/{YYYY}/{MM-MonthNameFR}/{Category}/`
  where `MonthNameFR` ∈ Janvier…Décembre and `Category` ∈ `Fournisseurs` (supplier invoices), `Tickets` (receipts), `Devis` (quotes), `BL` (delivery notes), `Autres`.
  Folder is chosen by **document date** (not ingestion date).
- **F-3.2** Filename convention: `{YYYY-MM-DD}_{TYPE}_{SupplierSlug}_{TTC}EUR.{ext}` — e.g. `2026-06-12_FACTURE_SanithermLyon_1246.80EUR.pdf`. TYPE ∈ FACTURE / TICKET / DEVIS / BL / AUTRE. Keep the original file format (a JPEG stays a JPEG). Amount omitted when the document has none (delivery notes).
- **F-3.3** A Google Sheets spreadsheet `Klerk_Journal` (one tab per year) is appended with one row per filed document:
  `doc_date | ingested_at | channel | doc_type | supplier | chantier | ht | tva | ttc | due_date | drive_link | status | min_confidence | doc_id`.
  The Sheet is a human-readable **projection**; your database remains the source of truth (see NFR-3 context in Part 3). Journal amounts use French display formatting.
- **F-3.4** VAT sanity check: when HT, VAT amount and VAT rate are all readable and `|HT × rate − VAT| > 0,05 €`, the document is still filed but flagged as an anomaly: mention it in the WhatsApp confirmation (`⚠️ TVA incohérente sur cette facture (62,50 € indiqués, 82,50 € attendus à 20%)`), mark it in the journal `status`, and list it in the monthly email.

## 2.4 Flow D — Monthly accountant email

- **F-4.1** On the **1st of each month at 08:00 Europe/Paris**, Klerk sends (via the Gmail API, from the connected account) a French recap email to the accountant address configured in env (`ACCOUNTANT_EMAIL`) covering the previous month: document counts and TTC totals by category, list of documents with amounts, an **Anomalies** section (duplicates detected, VAT inconsistencies, invoices past due date, documents still pending confirmation), and the link to the month's Drive folder.
- **F-4.2** A CSV export of the month's journal rows is attached.
- **F-4.3** Because nobody will wait for the 1st of the month during grading: provide a **manual trigger** (CLI command or authenticated HTTP endpoint) that generates and sends the recap for an arbitrary `YYYY-MM`. Document it in the README.

## 2.5 Flow E — Conversational Q&A (RAG + router)

All artisan questions arrive as WhatsApp text and are answered in French.

- **F-5.1** **Three-way router.** Each question is first routed:
  - **ANALYTIC** — aggregations over structured journal data ("combien", "total", "quelles factures arrivent à échéance…") → answered from the database (see NFR-3 for the safety rules).
  - **CONTENT** — questions about what documents *say* ("quelle est la garantie de la cuve ?", "le devis de Mme Martin inclut-il la dépose ?") → vector search over document chunks (pgvector + Mistral embeddings) **with metadata pre-filtering** (doc type, supplier, client, date range inferred from the question), then LLM answer grounded in retrieved chunks.
  - **HYBRID** — questions needing both ("total des factures liées au chantier Villa Martin ?" when the chantier lives in document content/metadata) → retrieve/filter to identify the relevant documents, then aggregate numerically.
  Document your router design (rules, LLM classification, or both) in ARCHITECTURE.md.
- **F-5.2** **Ingestion-side RAG work:** after OCR, chunk the document **structure-aware** (a line item, a totals block or a clause must not be split mid-way), embed with Mistral embeddings, store in pgvector with metadata (`doc_id, doc_type, supplier, doc_date, chantier, chunk_kind`).
- **F-5.3** Every CONTENT/HYBRID answer **cites its source(s)**: document name and its Drive link. Example:
  `Oui — le devis signé de Mme Martin (DEV-2026-041) inclut bien la ligne « Dépose et évacuation chaudière existante — 380,00 € HT ». 📄 [lien Drive]`
- **F-5.4** **Honesty requirement:** when no document supports an answer, say so (`Je ne trouve pas de devis de janvier dans tes documents.`). Returning a fabricated number or attributing content to the wrong document is an automatic fail.
- **F-5.5** Numeric answers must be **computed**, not generated: the LLM formats the answer, the database does the arithmetic.
- **F-5.6** `05_TEST_DATASET/eval_questions_public.json` contains 8 reference questions with expected answers. Your **eval script** (see `06_DELIVERABLES.md`) must run them end-to-end against your system and print a pass/fail report. We will additionally run a private question set of the same style during grading.

## 2.6 Flow F — Ops dashboard (small, read-only)

- **F-6.1** A minimal web dashboard (Next.js) with: (a) the documents table (status, type, supplier, amount, channel, confidence, Drive link), (b) an anomalies list, (c) simple monthly totals. Read-only; no artisan-facing features.
- **F-6.2** This is an ops/demo tool — budget roughly half a day. Live status updates via Supabase Realtime are a bonus. Clean and legible beats fancy.

## 2.7 Business rules — single reference table

| Rule | Value |
|---|---|
| Confidence threshold (critical fields) | ask below **0.75** |
| Critical fields | supplier_name, total_ttc, doc_date (+ due_date for supplier invoices) |
| Duplicate | file-hash match, OR same type+supplier+TTC(±0,01 €)+doc date; `forcer` overrides |
| VAT anomaly | readable HT/VAT/rate and `|HT×rate − VAT| > 0,05 €` → file + flag |
| Reminder | opt-in per invoice; 09:00 Europe/Paris, 3 days before due date |
| Monthly recap | 1st of month 08:00 Europe/Paris + manual trigger for any month |
| Overdue (informational) | due_date < today; payment tracking is out of scope |
| Timezone | Europe/Paris everywhere scheduling is involved |
| Money | EUR; parse French formats; store numerically (integer cents or a decimal-safe type); display French style |
| Artisan/accountant language | French — always |

---

# PART 3 — TECHNICAL CONSTRAINTS (the "how")

## 3.1 Imposed stack

| Layer | Requirement |
|---|---|
| Language | Node.js ≥ 20, **TypeScript strict** end to end |
| Backend | One deployable service (webhook receiver + workers). Monorepo welcome. |
| Database | **Supabase** (Postgres) — source of truth for documents, state, conversations, jobs — with **pgvector** for embeddings |
| Queue / jobs | Postgres-based (e.g. pg-boss) or Supabase cron/Edge Functions. No paid queue services. |
| OCR + LLM + embeddings | **Mistral La Plateforme** (free tier) — OCR endpoint for documents, a chat model for classification/extraction/answers, Mistral embeddings for RAG |
| WhatsApp | **Unipile** (free trial) |
| Google | Gmail API (read + send + labels), Drive API, Sheets API — OAuth user consent in Testing mode |
| Dashboard | Next.js 14+ (App Router), Tailwind |
| Hosting | Free tiers only: Render (backend) and/or Vercel (dashboard). A public HTTPS URL is required for the Unipile webhook. |

Any additional library is fine if it is free, open source, and justified in ARCHITECTURE.md.

## 3.2 Non-functional requirements — each one is graded

- **NFR-1 · Idempotent webhooks.** Unipile (and any webhook provider) can retry deliveries. Reprocessing the same provider message id must not create a second Drive file, journal row, or WhatsApp reply. Prove it: your demo/eval script should replay a webhook payload and show nothing duplicates.
- **NFR-2 · Rate-limit resilience.** The Mistral free tier is rate-limited. All Mistral calls go through a queue with bounded concurrency, exponential backoff with jitter on 429/5xx, and bounded retries. A burst of 10 documents at once must eventually all process, with statuses visible — never a crash, never a silent drop.
- **NFR-3 · No unvalidated LLM-generated SQL.** For ANALYTIC questions, the LLM must never produce raw SQL that is executed as-is against your database. Acceptable patterns: a set of predefined parameterized query functions ("tools") the LLM selects and fills; or generated SQL that is validated (allowlisted tables/columns, SELECT-only) and executed under a **read-only role**. Explain your choice in ARCHITECTURE.md.
- **NFR-4 · Secrets hygiene.** All secrets via environment variables; commit a complete `.env.example`; no secret anywhere in Git history. A leaked key = automatic fail.
- **NFR-5 · Never fabricate.** Extraction carries confidence; low confidence triggers the human loop (F-2.5); RAG says "not found" when applicable (F-5.4). This NFR exists because it is the single most common failure mode of LLM document pipelines.
- **NFR-6 · Observability.** Structured logs (JSON) per pipeline stage with `doc_id` correlation, and the document state machine from §2.0 persisted in DB. From logs + dashboard alone, one must be able to tell where any document is and why.
- **NFR-7 · Money safety.** No IEEE-754 float arithmetic on money. Integer cents or a decimal library. French formatting only at the presentation layer.
- **NFR-8 · Config, not constants.** Thresholds (0.75), accountant email, artisan WhatsApp id, schedule times: environment/config, not magic numbers scattered in code.

## 3.3 Repository expectations

- Small, atomic commits with meaningful messages (conventional commits appreciated). **We read the history** — one giant "final commit" is a red flag.
- `README.md` (setup in < 30 min by a stranger), `ARCHITECTURE.md` (your design + tradeoffs: router, chunking, dedupe, queue, state machine), `.env.example`, a seed/reset script, the eval script (F-5.6), and the manual monthly-recap trigger (F-4.3).

## 3.4 AI coding assistants

Allowed and expected — we use Claude Code daily ourselves. Two conditions: (1) you must understand and be able to defend **every line** you ship — the defense call (see `06_DELIVERABLES.md`) will test exactly that; (2) the design decisions in ARCHITECTURE.md must be yours.

---

# PART 4 — SETUP GUIDE (accounts, keys, and the €0 guarantee)

> ## 💶 Budget: zero. Really.
> **Every single service in this mission has a free tier that is sufficient for the whole test. You will not pay anything, and no step requires a credit card.** If any signup page asks you for a card, stop — you are on the wrong plan or the wrong page. If you believe a free tier has changed since this document was written, flag it to us immediately instead of paying.

### 4.1 Mistral La Plateforme (OCR + LLM + embeddings) — free

1. Create an account at console.mistral.ai.
2. Stay on the **free tier** (Mistral's rate-limited experiment/free API plan — no card needed).
3. Create one API key. This single key covers the three capabilities you need: the **OCR endpoint** (document → structured markdown), **chat models** (classification, extraction, answers), and **embeddings**.
4. The free tier is rate-limited — that is intentional for this mission: NFR-2 requires your pipeline to absorb 429s gracefully. Check your exact limits in the Mistral console ("Limits" page) and size your queue concurrency accordingly.

### 4.2 Supabase — free

1. Create a free project (no card).
2. Enable pgvector: `create extension if not exists vector;`
3. Note: free projects **pause after ~7 days of inactivity**. If it happens, restore from the dashboard in one click. Keep your project active during the mission week.

### 4.3 Unipile (WhatsApp) — free trial

1. Create a Unipile account and start the **free trial** (no card required to start; check the current trial duration on their site and plan accordingly).
2. **Tip: connect WhatsApp only when you start Flow A** (typically day 2–3), so the trial window covers your development and the final demo.
3. Connect a WhatsApp account (your own via multi-device, or a spare number). Configure the webhook to your deployed backend URL (Render). Unipile's docs cover message webhooks and media download; sending replies goes through their messaging API.
4. For testing, send documents from a **second** phone/number to the connected one — that second number plays Julien.

### 4.4 Google Cloud (Gmail + Drive + Sheets) — free

1. **Strong recommendation:** create a fresh, dedicated Gmail account for the mission (e.g. `yourname.klerk.test@gmail.com`) so tests never touch your personal mail. This account is "Julien's".
2. In Google Cloud Console: create a project (free), enable **Gmail API**, **Drive API**, **Sheets API**.
3. OAuth consent screen → **Testing** mode → add your test Gmail as a test user. In Testing mode there is **no app verification** needed; refresh tokens for test users expire after ~7 days, which is fine for a 7-day mission (re-consent if needed).
4. Create an OAuth Client ID and implement the consent flow (a tiny local script that prints the refresh token is acceptable). Scopes — request only what you need and justify them in ARCHITECTURE.md; recommended set:
   - `gmail.readonly` + `gmail.send` + `gmail.modify` (labels)
   - `drive.file` (access only to files/folders the app creates — preferred over full Drive)
   - `spreadsheets`
5. We deliberately keep this section short: navigating Google's OAuth documentation is part of the job and part of the evaluation.

### 4.5 Hosting — free

- **Render** free web service for the backend (public HTTPS URL for the Unipile webhook). Free instances cold-start after idling (~50 s) — acceptable; wake it before demos, or add a scheduled ping during your test window.
- **Vercel** hobby for the Next.js dashboard (or serve it from the same Render service — your call, justify it).

### 4.6 Test data & simulation protocol

- The dataset is in `05_TEST_DATASET/` — read its `README.md`. In short: everything in `whatsapp_inbox/` is sent from your second phone to the connected WhatsApp number, in any realistic order spread over your test window; everything in `email_inbox/` (.eml files) is injected into the test Gmail inbox (via the Gmail API `messages.import`, or by re-sending the attachments from another mailbox — your choice, document it).
- All companies, SIREN numbers, IBANs, people and amounts in the dataset are **fictitious**.

### 4.7 Suggested 7-day plan (indicative, not graded)

| Day | Focus |
|---|---|
| 1 | Accounts, repo, schema, state machine, ARCHITECTURE draft → **M1 at 48h** |
| 2–3 | Flow A end-to-end (webhook → OCR → extraction → confidence gate → Drive/Sheets → confirmation) |
| 4 | Flow B (Gmail) + dedupe + VAT check |
| 5 | Flow E (chunking, embeddings, three-way router, citations) |
| 6 | Flow D (monthly email + manual trigger), dashboard, hardening (NFR-1/2), burst test |
| 7 | Eval script green, README/ARCHITECTURE final, Loom recording, polish |

Good luck — build it like it ships to a real Julien on Monday.
