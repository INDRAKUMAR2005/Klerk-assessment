# Klerk — AI Administrative Assistant for French Tradespeople

Klerk is an AI-powered administrative assistant that turns WhatsApp and Gmail into a complete back office. Independent tradespeople (artisans) send invoice photos, receipts, or quotes, and Klerk reads, classifies, files them in a structured Google Drive folder, logs records in a Google Sheets journal, and answers natural language questions (RAG).

---

## 🛠️ Tech Stack & Requirements
- **Runtime**: Node.js ≥ 20
- **Database**: Supabase (PostgreSQL) + `pgvector`
- **APIs**: Mistral AI (OCR, Chat, Embeddings), Unipile (WhatsApp), Google Cloud (Gmail, Drive, Sheets)
- **Frontend**: Next.js 14+ (App Router) + Tailwind CSS

---

## 🚀 Installation & Setup (Under 10 Minutes)

### 1. Clone the repository and configure environments
Copy the `.env.example` file to `.env` in the `backend` folder and populate the credentials:
```bash
cp backend/.env.example backend/.env
```
*(Refer to the **Environment Variables Reference** section below to populate keys).*

### 2. Install workspace dependencies
Install all backend and frontend packages in one command from the project root folder:
```bash
npm install
```

### 3. Initialize the database and configurations (Seed)
Run the seeding script to run SQL migrations (creating enums, tables, indexes, and pgvector extension) and set up Gmail labels:
```bash
npm run seed --workspace=backend
```
*(Alternatively, you can copy the contents of `backend/src/scripts/migration.sql` and run them directly in the Supabase SQL editor).*

### 4. Run the development server
Start the Express API server and Next.js frontend concurrently:
```bash
# In one terminal: Start backend Express server (Default port: 3001)
npm run dev --workspace=backend

# In a second terminal: Start Next.js dashboard (Default port: 3000)
npm run dev --workspace=frontend
```

---

## 📦 Script Executions & CLI Commands

All commands can be run from the root directory or inside the `backend` folder:

### 1. Public Evaluation Script (F-5.6)
Executes the 8 reference evaluation questions from `eval_questions_public.json` end-to-end against the RAG system and outputs a PASS/FAIL report along with a machine-readable JSON results file (`backend/eval_results.json`):
```bash
npm run eval --workspace=backend
```

### 2. Manual Monthly Recap Email (F-4.3)
Generates the monthly accountant recap email (with totals, list of documents, and anomalies list) and attaches the CSV journal export for a specific period:
```bash
npm run manual-recap --workspace=backend -- 2026-06
```

### 3. Complete System Reset
Wipes database table records, deletes year subfolders in Drive, clears Google Sheets ledger rows, and deletes Gmail labels, allowing a clean run:
```bash
npm run reset --workspace=backend
```

### 4. Webhook Idempotency Verification (NFR-1 Proof)
To verify that webhooks are idempotent and do not create duplicate records on retry, you can trigger a simulated duplicate webhook request:
```bash
# Propose a POST request twice with the same provider message ID:
curl -X POST http://localhost:3001/api/webhooks/unipile \
  -H "Content-Type: application/json" \
  -d '{"event":"message_received","account_type":"WHATSAPP","message_id":"test_id_123","chat_id":"33612345678@c.us","sender":{"attendee_provider_id":"33612345678@c.us"},"attachments":[{"id":"att_123","mime_type":"image/jpeg","filename":"facture.jpg"}]}'
```
*Observe console logs: the first request inserts and enqueues, and the second request returns 200 OK immediately without duplicate DB inserts.*

---

## 🔑 Environment Variables Reference

| Variable | Description |
|---|---|
| `PORT` | Local Express API port (default: 3001). |
| `MISTRAL_API_KEY` | Mistral La Plateforme API Key (free tier sufficient). |
| `SUPABASE_URL` | Supabase project dashboard API URL. |
| `SUPABASE_ANON_KEY` | Supabase anonymous client API Key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (enables database operations). |
| `DATABASE_URL` | Direct connection string for PostgreSQL (pooler or session). |
| `UNIPILE_API_KEY` | Unipile access token. |
| `UNIPILE_API_URL` | Unipile server endpoint. |
| `ARTISAN_WHATSAPP_ID` | Julien's WhatsApp number ID (e.g. `33612345678@c.us`). |
| `GOOGLE_CLIENT_ID` | Google Cloud Console OAuth 2.0 client ID. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console OAuth 2.0 client secret. |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token for Gmail, Drive, and Sheets. |
| `GOOGLE_DRIVE_FOLDER_ID` | Google Drive folder ID acting as the parent for accounting files. |
| `GOOGLE_SHEET_ID` | Google Sheet spreadsheet ID acting as the journal. |
| `ACCOUNTANT_EMAIL` | Destination email where the monthly recaps are sent. |
| `CONFIDENCE_THRESHOLD` | Threshold above which documents are filed silently (default: `0.75`). |
