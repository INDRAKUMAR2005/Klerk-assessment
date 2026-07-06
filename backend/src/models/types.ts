export type DocChannel = 'whatsapp' | 'gmail';

export type DocType = 'supplier_invoice' | 'receipt' | 'quote' | 'delivery_note' | 'other';

export type DocStatus =
  | 'received'
  | 'ocr_done'
  | 'extracted'
  | 'pending_confirmation'
  | 'filed'
  | 'rejected'
  | 'duplicate_ignored';

export interface LineItem {
  label: string;
  qty?: number;
  unitPrice?: number; // stored in cents
  totalPrice?: number; // stored in cents
}

export interface ExtractedMetadata {
  docType: DocType;
  supplierName: string | null;
  supplierSirenVat: string | null;
  docNumber: string | null;
  docDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  totalHt: number | null; // in cents
  totalVat: number | null; // in cents
  totalTtc: number | null; // in cents
  chantierRef: string | null;
  vatRates: number[];
  lineItems: LineItem[];
}

export interface ConfidenceScores {
  docType?: number;
  supplierName?: number;
  totalTtc?: number;
  docDate?: number;
  dueDate?: number;
}

export interface Document {
  id: string;
  originalHash: string;
  fileName: string;
  fileExtension: string;
  mimeType: string;
  channel: DocChannel;
  providerMessageId: string;
  status: DocStatus;
  
  // Extracted fields
  docType: DocType | null;
  supplierName: string | null;
  supplierSirenVat: string | null;
  docNumber: string | null;
  docDate: string | null;
  dueDate: string | null;
  totalHt: number | null; // cents
  totalVat: number | null; // cents
  totalTtc: number | null; // cents
  chantierRef: string | null;
  vatRates: number[] | null;
  lineItems: LineItem[] | null;
  
  // Confidences and OCR
  confidenceScores: ConfidenceScores | null;
  minConfidence: number | null;
  rawOcrMarkdown: string | null;
  vatAnomalyFlag: boolean;
  
  // Links & references
  driveFileId: string | null;
  driveLink: string | null;
  googleSheetRowIndex: number | null;
  
  // Reminders
  reminderScheduledAt: string | null;
  reminderSentAt: string | null;
  reminderOptIn: boolean;
  
  createdAt: string;
  updatedAt: string;
}

export interface ActiveContext {
  artisanWhatsappId: string;
  pendingDocumentId: string | null;
  lastInteractionAt: string;
}

export interface Chunk {
  id: string;
  docId: string;
  chunkIndex: number;
  content: string;
  chunkKind: string;
  embedding: number[];
  createdAt: string;
}
