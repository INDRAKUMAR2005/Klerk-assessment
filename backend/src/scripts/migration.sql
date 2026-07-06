-- Enable the pgvector extension
create extension if not exists vector;

-- Drop existing tables/types if they exist (for clean migrations/restarts)
drop table if exists active_contexts cascade;
drop table if exists document_chunks cascade;
drop table if exists documents cascade;
drop table if exists jobs cascade;
drop type if exists doc_channel cascade;
drop type if exists doc_type cascade;
drop type if exists doc_status cascade;

-- Define enums
create type doc_channel as enum ('whatsapp', 'gmail');
create type doc_type as enum ('supplier_invoice', 'receipt', 'quote', 'delivery_note', 'other');
create type doc_status as enum (
  'received', 
  'ocr_done', 
  'extracted', 
  'pending_confirmation', 
  'filed', 
  'rejected', 
  'duplicate_ignored'
);

-- Documents Table
create table documents (
  id uuid default gen_random_uuid() primary key,
  original_hash text not null,                -- MD5 hash of original file for deduplication
  file_name text not null,
  file_extension text not null,
  mime_type text not null,
  channel doc_channel not null,
  provider_message_id text not null unique,   -- For idempotency checks (Unipile message ID / Gmail message ID)
  status doc_status not null default 'received',
  
  -- Extracted metadata
  doc_type doc_type,
  supplier_name text,
  supplier_siren_vat text,
  doc_number text,
  doc_date date,
  due_date date,
  total_ht integer,                           -- stored in cents
  total_vat integer,                          -- stored in cents
  total_ttc integer,                          -- stored in cents
  chantier_ref text,
  vat_rates numeric[],
  line_items jsonb,                           -- Array of line items
  
  -- Processing metadata
  confidence_scores jsonb,                     -- e.g. { supplier_name: 0.85, total_ttc: 0.9 }
  min_confidence numeric check (min_confidence >= 0 and min_confidence <= 1),
  raw_ocr_markdown text,
  vat_anomaly_flag boolean default false,
  
  -- External IDs
  drive_file_id text,
  drive_link text,
  google_sheet_row_index integer,
  
  -- Confirmations / Reminders
  reminder_scheduled_at timestamp with time zone,
  reminder_sent_at timestamp with time zone,
  reminder_opt_in boolean default false,
  
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Document Chunks Table (for RAG vector search)
create table document_chunks (
  id uuid default gen_random_uuid() primary key,
  doc_id uuid references documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  chunk_kind text not null,                    -- 'line_item', 'totals_block', 'header', 'body_paragraph'
  embedding vector(1024) not null,             -- Mistral embed dimensions (1024)
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Conversations / Context State (F-1.7 pending confirmations safety)
create table active_contexts (
  artisan_whatsapp_id text primary key,
  pending_document_id uuid references documents(id) on delete set null,
  last_interaction_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Jobs / Queue Table (for SKIP LOCKED background queueing)
create table jobs (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  data jsonb not null,
  status text not null default 'pending',       -- 'pending', 'processing', 'completed', 'failed'
  attempts integer default 0,
  max_attempts integer default 5,
  run_after timestamp with time zone default timezone('utc'::text, now()) not null,
  error text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create indexes
create index idx_documents_hash on documents(original_hash);
create index idx_documents_status on documents(status);
create index idx_documents_due_date on documents(due_date);
create index idx_documents_doc_date on documents(doc_date);
create index idx_documents_supplier on documents(supplier_name);
create index idx_document_chunks_doc_id on document_chunks(doc_id);
create index idx_jobs_status_run_after on jobs(status, run_after);

-- Enable Supabase Realtime for the documents table (useful for dashboard real-time updates)
alter publication supabase_realtime add table documents;
