import { Pool, PoolClient } from 'pg';
import { config } from '../config';
import { Document, DocStatus, ExtractedMetadata, ConfidenceScores, Chunk } from '../models/types';

// Initialize connection pool
export const pool = new Pool({
  connectionString: config.supabase.dbUrl,
  ssl: {
    rejectUnauthorized: false, // Required for Supabase external SSL connections
  },
  max: 10, // Maximum pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err);
});

export const db = {
  /**
   * Run a query with parameters
   */
  async query<T = any>(text: string, params?: any[]): Promise<T[]> {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      if (config.env === 'development') {
        // console.log('[DB Query]', { text, duration, rows: res.rowCount });
      }
      return res.rows;
    } catch (error) {
      console.error('[DB Query Error]', { text, error });
      throw error;
    }
  },

  /**
   * Run a transaction with a callback
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[DB Transaction Error] Rolled back', error);
      throw error;
    } finally {
      client.release();
    }
  },

  // --- Document Operations ---

  async getDocumentById(id: string): Promise<Document | null> {
    const rows = await this.query<any>(
      `SELECT 
        id, original_hash as "originalHash", file_name as "fileName", 
        file_extension as "fileExtension", mime_type as "mimeType", 
        channel, provider_message_id as "providerMessageId", status,
        doc_type as "docType", supplier_name as "supplierName", 
        supplier_siren_vat as "supplierSirenVat", doc_number as "docNumber", 
        doc_date as "docDate", due_date as "dueDate", 
        total_ht as "totalHt", total_vat as "totalVat", total_ttc as "totalTtc", 
        chantier_ref as "chantierRef", vat_rates as "vatRates", line_items as "lineItems",
        confidence_scores as "confidenceScores", min_confidence as "minConfidence", 
        raw_ocr_markdown as "rawOcrMarkdown", vat_anomaly_flag as "vatAnomalyFlag",
        drive_file_id as "driveFileId", drive_link as "driveLink", 
        google_sheet_row_index as "googleSheetRowIndex",
        reminder_scheduled_at as "reminderScheduledAt", reminder_sent_at as "reminderSentAt", 
        reminder_opt_in as "reminderOptIn", created_at as "createdAt", updated_at as "updatedAt"
      FROM documents WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  },

  async getDocumentByMessageId(providerMessageId: string): Promise<Document | null> {
    const rows = await this.query<any>(
      `SELECT 
        id, original_hash as "originalHash", file_name as "fileName", 
        file_extension as "fileExtension", mime_type as "mimeType", 
        channel, provider_message_id as "providerMessageId", status,
        doc_type as "docType", supplier_name as "supplierName", 
        supplier_siren_vat as "supplierSirenVat", doc_number as "docNumber", 
        doc_date as "docDate", due_date as "dueDate", 
        total_ht as "totalHt", total_vat as "totalVat", total_ttc as "totalTtc", 
        chantier_ref as "chantierRef", vat_rates as "vatRates", line_items as "lineItems",
        confidence_scores as "confidenceScores", min_confidence as "minConfidence", 
        raw_ocr_markdown as "rawOcrMarkdown", vat_anomaly_flag as "vatAnomalyFlag",
        drive_file_id as "driveFileId", drive_link as "driveLink", 
        google_sheet_row_index as "googleSheetRowIndex",
        reminder_scheduled_at as "reminderScheduledAt", reminder_sent_at as "reminderSentAt", 
        reminder_opt_in as "reminderOptIn", created_at as "createdAt", updated_at as "updatedAt"
      FROM documents WHERE provider_message_id = $1`,
      [providerMessageId]
    );
    return rows.length > 0 ? rows[0] : null;
  },

  async createDocument(doc: {
    originalHash: string;
    fileName: string;
    fileExtension: string;
    mimeType: string;
    channel: string;
    providerMessageId: string;
    status: DocStatus;
  }): Promise<Document> {
    const rows = await this.query<any>(
      `INSERT INTO documents (
        original_hash, file_name, file_extension, mime_type, channel, provider_message_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING 
        id, original_hash as "originalHash", file_name as "fileName", 
        file_extension as "fileExtension", mime_type as "mimeType", 
        channel, provider_message_id as "providerMessageId", status,
        doc_type as "docType", supplier_name as "supplierName", 
        supplier_siren_vat as "supplierSirenVat", doc_number as "docNumber", 
        doc_date as "docDate", due_date as "dueDate", 
        total_ht as "totalHt", total_vat as "totalVat", total_ttc as "totalTtc", 
        chantier_ref as "chantierRef", vat_rates as "vatRates", line_items as "lineItems",
        confidence_scores as "confidenceScores", min_confidence as "minConfidence", 
        raw_ocr_markdown as "rawOcrMarkdown", vat_anomaly_flag as "vatAnomalyFlag",
        drive_file_id as "driveFileId", drive_link as "driveLink", 
        google_sheet_row_index as "googleSheetRowIndex",
        reminder_scheduled_at as "reminderScheduledAt", reminder_sent_at as "reminderSentAt", 
        reminder_opt_in as "reminderOptIn", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        doc.originalHash,
        doc.fileName,
        doc.fileExtension,
        doc.mimeType,
        doc.channel,
        doc.providerMessageId,
        doc.status,
      ]
    );
    return rows[0];
  },

  async updateDocumentStatus(id: string, status: DocStatus): Promise<void> {
    await this.query(
      `UPDATE documents SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id]
    );
  },

  async updateDocumentExtraction(
    id: string,
    extracted: ExtractedMetadata,
    confidence: ConfidenceScores,
    minConfidence: number,
    ocrMarkdown: string,
    vatAnomaly: boolean,
    status: DocStatus
  ): Promise<void> {
    await this.query(
      `UPDATE documents 
      SET 
        doc_type = $1,
        supplier_name = $2,
        supplier_siren_vat = $3,
        doc_number = $4,
        doc_date = $5,
        due_date = $6,
        total_ht = $7,
        total_vat = $8,
        total_ttc = $9,
        chantier_ref = $10,
        vat_rates = $11,
        line_items = $12,
        confidence_scores = $13,
        min_confidence = $14,
        raw_ocr_markdown = $15,
        vat_anomaly_flag = $16,
        status = $17,
        updated_at = NOW()
      WHERE id = $18`,
      [
        extracted.docType,
        extracted.supplierName,
        extracted.supplierSirenVat,
        extracted.docNumber,
        extracted.docDate || null,
        extracted.dueDate || null,
        extracted.totalHt,
        extracted.totalVat,
        extracted.totalTtc,
        extracted.chantierRef,
        extracted.vatRates,
        JSON.stringify(extracted.lineItems),
        JSON.stringify(confidence),
        minConfidence,
        ocrMarkdown,
        vatAnomaly,
        status,
        id,
      ]
    );
  },

  async updateDocumentFiling(
    id: string,
    driveFileId: string,
    driveLink: string,
    sheetRowIndex: number | null
  ): Promise<void> {
    await this.query(
      `UPDATE documents 
      SET 
        drive_file_id = $1,
        drive_link = $2,
        google_sheet_row_index = $3,
        status = 'filed',
        updated_at = NOW()
      WHERE id = $4`,
      [driveFileId, driveLink, sheetRowIndex, id]
    );
  },

  async updateDocumentReminder(
    id: string,
    optIn: boolean,
    scheduledAt: Date | null
  ): Promise<void> {
    await this.query(
      `UPDATE documents 
      SET 
        reminder_opt_in = $1,
        reminder_scheduled_at = $2,
        updated_at = NOW()
      WHERE id = $3`,
      [optIn, scheduledAt, id]
    );
  },

  async markReminderSent(id: string): Promise<void> {
    await this.query(
      `UPDATE documents 
      SET 
        reminder_sent_at = NOW(),
        updated_at = NOW()
      WHERE id = $1`,
      [id]
    );
  },

  // --- Duplicate Check ---

  async findDuplicate(
    hash: string,
    docType: string,
    supplierName: string,
    totalTtc: number,
    docDate: string
  ): Promise<Document | null> {
    // 1. Exact hash match
    const hashRows = await this.query<any>(
      `SELECT id, doc_type as "docType", supplier_name as "supplierName", total_ttc as "totalTtc", doc_date as "docDate", drive_link as "driveLink", created_at as "createdAt"
       FROM documents 
       WHERE original_hash = $1 AND status = 'filed' LIMIT 1`,
      [hash]
    );
    if (hashRows.length > 0) return hashRows[0];

    // 2. Metadata match: same type + supplier + total TTC (±1 cent since stored as integer cents) + doc date
    if (docType && supplierName && totalTtc && docDate) {
      const metaRows = await this.query<any>(
        `SELECT id, doc_type as "docType", supplier_name as "supplierName", total_ttc as "totalTtc", doc_date as "docDate", drive_link as "driveLink", created_at as "createdAt"
         FROM documents 
         WHERE status = 'filed'
           AND doc_type = $1 
           AND LOWER(supplier_name) = LOWER($2) 
           AND ABS(total_ttc - $3) <= 1 
           AND doc_date = $4 
         LIMIT 1`,
        [docType, supplierName, totalTtc, docDate]
      );
      if (metaRows.length > 0) return metaRows[0];
    }

    return null;
  },

  // --- active_contexts Operations ---

  async getActiveContext(artisanWhatsappId: string): Promise<string | null> {
    const rows = await this.query(
      `SELECT pending_document_id as "pendingDocumentId" FROM active_contexts WHERE artisan_whatsapp_id = $1`,
      [artisanWhatsappId]
    );
    return rows.length > 0 ? rows[0].pendingDocumentId : null;
  },

  async setActiveContext(artisanWhatsappId: string, pendingDocumentId: string | null): Promise<void> {
    await this.query(
      `INSERT INTO active_contexts (artisan_whatsapp_id, pending_document_id, last_interaction_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (artisan_whatsapp_id) 
       DO UPDATE SET pending_document_id = EXCLUDED.pending_document_id, last_interaction_at = NOW()`,
      [artisanWhatsappId, pendingDocumentId]
    );
  },

  async clearActiveContext(artisanWhatsappId: string): Promise<void> {
    await this.query(
      `UPDATE active_contexts SET pending_document_id = NULL, last_interaction_at = NOW() WHERE artisan_whatsapp_id = $1`,
      [artisanWhatsappId]
    );
  },

  // --- Vector/RAG operations ---

  async insertChunk(docId: string, index: number, content: string, kind: string, embedding: number[]): Promise<void> {
    // Convert array of floats to postgres vector format: '[0.1,0.2,...]'
    const vectorStr = `[${embedding.join(',')}]`;
    await this.query(
      `INSERT INTO document_chunks (doc_id, chunk_index, content, chunk_kind, embedding)
       VALUES ($1, $2, $3, $4, $5)`,
      [docId, index, content, kind, vectorStr]
    );
  },

  async searchVectorChunks(embedding: number[], limit: number = 5, docType?: string, supplierName?: string): Promise<Chunk[]> {
    const vectorStr = `[${embedding.join(',')}]`;
    let sql = `
      SELECT 
        c.id, c.doc_id as "docId", c.chunk_index as "chunkIndex", c.content, c.chunk_kind as "chunkKind",
        d.supplier_name as "supplierName", d.drive_link as "driveLink", d.file_name as "fileName",
        (c.embedding <=> $1) as distance
      FROM document_chunks c
      JOIN documents d ON c.doc_id = d.id
      WHERE d.status = 'filed'
    `;
    const params: any[] = [vectorStr];

    let paramIdx = 2;
    if (docType) {
      sql += ` AND d.doc_type = $${paramIdx}`;
      params.push(docType);
      paramIdx++;
    }
    if (supplierName) {
      sql += ` AND (LOWER(d.supplier_name) = LOWER($${paramIdx}) OR LOWER(d.supplier_name) LIKE '%' || LOWER($${paramIdx}) || '%' OR LOWER($${paramIdx}) LIKE '%' || LOWER(d.supplier_name) || '%')`;
      params.push(supplierName);
      paramIdx++;
    }

    sql += ` ORDER BY distance ASC LIMIT $${paramIdx}`;
    params.push(limit);

    return this.query<any>(sql, params);
  }
};
export default db;
