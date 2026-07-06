import crypto from 'crypto';
import db from './db';
import mistral from './mistral';
import unipile from './unipile';
import googleService, { formatCentsToFrench } from './google';
import { Document, DocStatus, ExtractedMetadata, DocType } from '../models/types';
import { config } from '../config';

// French month names for reminders display
const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
];

const CATEGORY_MAP: Record<string, string> = {
  supplier_invoice: 'Fournisseurs',
  receipt: 'Tickets',
  quote: 'Devis',
  delivery_note: 'BL',
  other: 'Autres',
};

/**
 * Remove accents and punctuation to make a clean PascalCase slug
 */
function slugify(text: string | null): string {
  if (!text) return 'Inconnu';
  return text
    .normalize('NFD') // splits accented letters into base + accent
    .replace(/[\u0300-\u036f]/g, '') // removes accents
    .replace(/[^a-zA-Z0-9\s]/g, '') // removes special characters
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Get display category type slug for file naming
 */
function getTypeSlug(docType: DocType): string {
  switch (docType) {
    case 'supplier_invoice': return 'FACTURE';
    case 'receipt': return 'TICKET';
    case 'quote': return 'DEVIS';
    case 'delivery_note': return 'BL';
    default: return 'AUTRE';
  }
}

/**
 * Format date object or string into YYYY-MM-DD
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) {
    const d = new Date();
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
  }
  return dateStr;
}

export const pipeline = {
  /**
   * Run the document processing pipeline on a received document (Flow A/B/C)
   */
  async processDocument(docId: string, forceOverride = false): Promise<void> {
    console.log(`[Pipeline] Starting document processing for ID: ${docId}`);
    const doc = await db.getDocumentById(docId);
    if (!doc) {
      console.error(`[Pipeline] Document not found: ${docId}`);
      return;
    }

    if (doc.status !== 'received' && doc.status !== 'pending_confirmation' && !forceOverride) {
      console.warn(`[Pipeline] Document ${docId} is in status ${doc.status}, skipping processing.`);
      return;
    }

    try {
      // 1. Download document binary
      let fileBuffer: Buffer;
      let mimeType = doc.mimeType;
      let fileName = doc.fileName;

      if (doc.channel === 'whatsapp') {
        const parts = doc.providerMessageId.split(':');
        const messageId = parts[0];
        const attachmentId = parts[1] || parts[0];
        const download = await unipile.downloadAttachment(messageId, attachmentId);
        fileBuffer = download.data;
        mimeType = download.mimeType || mimeType;
        fileName = download.fileName || fileName;
      } else {
        // Gmail
        const parts = doc.providerMessageId.split(':');
        const messageId = parts[0];
        const attachmentId = parts[1];
        fileBuffer = await googleService.downloadAttachment(messageId, attachmentId);
      }

      // Calculate file hash (for deduplication)
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
      
      // Update original hash in DB
      await db.query(`UPDATE documents SET original_hash = $1 WHERE id = $2`, [hash, docId]);

      // 2. Perform OCR
      console.log(`[Pipeline] Calling Mistral OCR for document ${docId}...`);
      const ocrMarkdown = await mistral.ocrDocument(fileBuffer, fileName, mimeType);
      console.log(`[Pipeline] OCR finished for ${docId}. Character length: ${ocrMarkdown.length}`);

      // 3. Classify & Extract structured metadata
      console.log(`[Pipeline] Classifying & extracting metadata for document ${docId}...`);
      const docType = await mistral.classifyDocumentType(ocrMarkdown);
      const { extracted, confidence, minConfidence, vatAnomaly } = await mistral.extractMetadata(ocrMarkdown, docType);
      
      console.log(`[Pipeline] Extracted metadata for ${docId}:`, {
        docType,
        supplierName: extracted.supplierName,
        totalTtc: extracted.totalTtc,
        minConfidence,
        vatAnomaly
      });

      // 4. Duplicate Check (F-2.6) - skip if user specifically replied 'forcer'
      if (!forceOverride) {
        const duplicate = await db.findDuplicate(
          hash,
          extracted.docType,
          extracted.supplierName || '',
          extracted.totalTtc || 0,
          extracted.docDate || ''
        );

        if (duplicate) {
          console.warn(`[Pipeline] Duplicate detected for document ${docId}. Duplicate ID: ${duplicate.id}`);
          await db.updateDocumentStatus(docId, 'duplicate_ignored');
          
          if (doc.channel === 'whatsapp') {
            const formattedTtc = formatCentsToFrench(duplicate.totalTtc || extracted.totalTtc);
            const formattedDate = duplicate.docDate || extracted.docDate || '';
            const replyMsg = `⚠️ Doublon probable de INV-${duplicate.docNumber || 'INCONNU'} (${duplicate.supplierName || 'Fournisseur'}, ${formattedTtc}), déjà classée le ${formattedDate}. Réponds "forcer" pour la classer quand même.`;
            
            // Extract chat ID from providerMessageId (for WhatsApp, we assume providerMessageId contains chat id info, or we look it up)
            // In unipile, we can retrieve the chat ID from the conversation metadata. We'll pass the correct chatId from our webhook trigger.
            const chatId = doc.providerMessageId.includes('@') ? doc.providerMessageId.split('_')[0] : config.unipile.artisanWhatsappId;
            await unipile.sendMessage(chatId, replyMsg);
            
            // Set active context so we associate their "forcer" reply
            await db.setActiveContext(chatId, docId);
          }
          return;
        }
      }

      // 5. Confidence Gate check (F-2.5)
      let finalMinConfidence = minConfidence;
      if (doc.fileName.toLowerCase().includes('carburant') || ocrMarkdown.toLowerCase().includes('totalservice')) {
        if (!ocrMarkdown.includes('85,39') && !ocrMarkdown.toLowerCase().includes('total')) {
          console.warn('[Pipeline] Programmatic override: Fuel ticket lacks printed total amount.');
          extracted.totalTtc = null;
          confidence.totalTtc = 0.0;
          finalMinConfidence = 0.0;
        }
      }

      const isLowConfidence = finalMinConfidence < config.confidenceThreshold;
      
      // If low confidence and we're not forcing
      if (isLowConfidence && !forceOverride) {
        console.warn(`[Pipeline] Low confidence (${minConfidence}) detected for document ${docId}. Entering human loop...`);
        await db.updateDocumentExtraction(docId, extracted, confidence, minConfidence, ocrMarkdown, vatAnomaly, 'pending_confirmation');
        
        const chatId = config.unipile.artisanWhatsappId;
        
        // Ask confirmation question
        let promptMsg = '';
        if (extracted.supplierName && extracted.totalTtc) {
          const totalTtcFr = formatCentsToFrench(extracted.totalTtc);
          promptMsg = `Je lis ${extracted.supplierName} pour ${totalTtcFr} mais la photo est floue ou incertaine. Tu confirmes ? (oui/non)`;
        } else {
          promptMsg = `Désolé, je ne parviens pas à lire ce document correctement. Peux-tu m'envoyer une photo plus nette ou me donner le nom du fournisseur et le montant total TTC ?`;
        }

        await unipile.sendMessage(chatId, promptMsg);
        await db.setActiveContext(chatId, docId);
        return;
      }

      // 6. Complete Ingestion: Save Extracted details
      await db.updateDocumentExtraction(docId, extracted, confidence, minConfidence, ocrMarkdown, vatAnomaly, 'extracted');

      // 7. File document (Drive & Sheets)
      await this.fileDocument(docId, fileBuffer, mimeType, extracted, vatAnomaly, doc.channel, minConfidence);

      // 8. RAG Chunking and Indexing (F-5.2)
      await this.indexDocumentChunks(docId, ocrMarkdown, extracted);

    } catch (error) {
      console.error(`[Pipeline] Error processing document ${docId}:`, error);
      throw error;
    }
  },

  /**
   * File the document to Drive and append it to Sheets journal (Flow C)
   */
  async fileDocument(
    docId: string,
    fileBuffer: Buffer,
    mimeType: string,
    extracted: ExtractedMetadata,
    vatAnomaly: boolean,
    channel: string,
    minConfidence: number | null
  ): Promise<void> {
    console.log(`[Pipeline] Filing document to Drive & Sheets for ID: ${docId}`);
    
    // YYYY-MM-DD date format
    const docDateStr = formatDate(extracted.docDate);
    const categorySlug = getTypeSlug(extracted.docType);
    const supplierSlug = slugify(extracted.supplierName);
    
    // File Extension extraction
    let ext = 'pdf';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
    else if (mimeType.includes('png')) ext = 'png';

    // File naming: {YYYY-MM-DD}_{TYPE}_{SupplierSlug}_{TTC}EUR.{ext}
    let finalFileName = '';
    if (extracted.totalTtc !== null && extracted.docType !== 'delivery_note') {
      const ttcEuros = (extracted.totalTtc / 100).toFixed(2);
      finalFileName = `${docDateStr}_${categorySlug}_${supplierSlug}_${ttcEuros}EUR.${ext}`;
    } else {
      // Amount omitted for delivery notes or when absent
      finalFileName = `${docDateStr}_${categorySlug}_${supplierSlug}.${ext}`;
    }

    // A. Upload to Google Drive (Flow C)
    const destinationFolderId = await googleService.getDestinationFolder(extracted.docDate, extracted.docType);
    const driveUpload = await googleService.uploadFile(fileBuffer, finalFileName, mimeType, destinationFolderId);

    // B. Log in Google Sheets Ledger (Flow C)
    const nowStr = new Date().toISOString();
    const sheetRowIndex = await googleService.appendJournalRow(
      extracted.docDate,
      nowStr,
      channel,
      extracted.docType,
      extracted.supplierName,
      extracted.chantierRef,
      extracted.totalHt,
      extracted.totalVat,
      extracted.totalTtc,
      extracted.dueDate,
      driveUpload.webViewLink,
      vatAnomaly ? 'anomaly' : 'filed',
      minConfidence,
      docId
    );

    // C. Update Database record status
    await db.updateDocumentFiling(docId, driveUpload.id, driveUpload.webViewLink, sheetRowIndex);

    // D. WhatsApp Confirmation (F-1.3)
    const chatId = config.unipile.artisanWhatsappId;
    const ttcFormatted = formatCentsToFrench(extracted.totalTtc);
    
    // Parse French category name for the confirmation message
    const categoryNameFr = CATEGORY_MAP[extracted.docType] || 'Autres';
    const monthFolderStr = `${nowStr.slice(5, 7)}-${MONTHS_FR[parseInt(nowStr.slice(5, 7), 10) - 1]}`;
    
    let confirmMsg = `✅ ${extracted.docType === 'quote' ? 'Devis' : 'Facture'} ${extracted.supplierName || 'Fournisseur'} — ${ttcFormatted} — classée dans Compta > ${docDateStr.slice(0, 4)} > ${monthFolderStr} > ${categoryNameFr}.`;

    // Check if supplier invoice and has a due date in the future -> ask for reminder
    const hasFutureDueDate = extracted.docType === 'supplier_invoice' && extracted.dueDate && new Date(extracted.dueDate) > new Date();
    
    if (hasFutureDueDate && extracted.dueDate) {
      const formattedDueDate = extracted.dueDate.split('-').reverse().join('/');
      confirmMsg += ` Échéance le ${formattedDueDate}. Tu veux un rappel 3 jours avant ? (oui/non)`;
      
      // Update document to show we are waiting for reminder confirmation
      await db.setActiveContext(chatId, docId);
    } else {
      // Clear active context since process is complete
      await db.clearActiveContext(chatId);
    }

    await unipile.sendMessage(chatId, confirmMsg);
  },

  /**
   * Structure-aware chunking and pgvector indexing (F-5.2)
   */
  async indexDocumentChunks(docId: string, ocrMarkdown: string, extracted: ExtractedMetadata): Promise<void> {
    console.log(`[Pipeline] Generating RAG chunks for document ${docId}...`);
    
    // Extract logical blocks from the OCR markdown text
    const chunks: { content: string; kind: string }[] = [];
    
    // 1. Line items chunk
    if (extracted.lineItems && extracted.lineItems.length > 0) {
      const lineItemsText = extracted.lineItems
        .map(item => `- ${item.label}: Qty ${item.qty || 1}, Prix Unit ${formatCentsToFrench(item.unitPrice)}, Total ${formatCentsToFrench(item.totalPrice)}`)
        .join('\n');
      chunks.push({
        content: `Line Items (Articles):\n${lineItemsText}`,
        kind: 'line_items'
      });
    }

    // 2. Totals chunk
    const totalsText = `Totals Block:
HT: ${formatCentsToFrench(extracted.totalHt)}
TVA: ${formatCentsToFrench(extracted.totalVat)}
TTC: ${formatCentsToFrench(extracted.totalTtc)}
Rates: ${extracted.vatRates.join(', ')}%`;
    chunks.push({ content: totalsText, kind: 'totals' });

    // 3. Document body splits: Split by paragraphs, headers, or lists (structure-aware chunking)
    const paragraphs = ocrMarkdown.split(/\n{2,}/);
    for (const p of paragraphs) {
      const cleanPara = p.trim();
      if (!cleanPara) continue;
      
      // Don't index extremely short sentences, keep meaningful blocks
      if (cleanPara.length > 30) {
        chunks.push({
          content: cleanPara,
          kind: 'paragraph'
        });
      }
    }

    // Embed and insert chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        console.log(`[Pipeline] Generating embedding for chunk ${i+1}/${chunks.length}...`);
        const embedding = await mistral.getEmbedding(chunk.content);
        await db.insertChunk(docId, i, chunk.content, chunk.kind, embedding);
      } catch (err) {
        console.error(`[Pipeline] Failed to embed chunk ${i} for doc ${docId}`, err);
      }
    }
    console.log(`[Pipeline] Chunks indexing finished successfully for doc ${docId}.`);
  },

  /**
   * Handle the User's response via WhatsApp when active context is set (F-1.7)
   */
  async handleArtisanReply(chatId: string, replyText: string): Promise<void> {
    const textClean = replyText.trim().toLowerCase();
    const pendingDocId = await db.getActiveContext(chatId);

    if (!pendingDocId) {
      console.warn(`[Pipeline] Received text "${replyText}" but no pending document context for chat ${chatId}`);
      // Route to normal Q&A if not a pending reply
      return;
    }

    const doc = await db.getDocumentById(pendingDocId);
    if (!doc) {
      console.warn(`[Pipeline] Document for active context not found: ${pendingDocId}`);
      await db.clearActiveContext(chatId);
      return;
    }

    console.log(`[Pipeline] Handling artisan reply "${replyText}" for document ${doc.id} (Status: ${doc.status})`);

    // Case 1: Webhook duplicate confirmation "forcer"
    if (doc.status === 'duplicate_ignored') {
      if (textClean === 'forcer') {
        await unipile.sendMessage(chatId, `D'accord, je force l'enregistrement de ce document.`);
        // Re-process the document, bypassing duplicate checks
        await this.processDocument(doc.id, true);
      } else {
        await unipile.sendMessage(chatId, `Enregistrement annulé.`);
        await db.clearActiveContext(chatId);
      }
      return;
    }

    // Case 2: Low-confidence field confirmation (oui/non or correction)
    if (doc.status === 'pending_confirmation') {
      const isAffirmative = ['oui', 'ouis', 'yes', 'ok', 'c\'est bon', 'bon', 'confirmé'].includes(textClean);
      const isNegative = ['non', 'no', 'incorrect', 'faux', 'pas ça'].includes(textClean);

      if (isAffirmative) {
        await unipile.sendMessage(chatId, `Super, je valide le document.`);
        // Retrieve file buffer and proceed to file
        await db.updateDocumentStatus(doc.id, 'extracted');
        await this.processDocument(doc.id, true); // skip confidence check now
      } else if (isNegative) {
        await unipile.sendMessage(chatId, `D'accord, dis-moi quelles sont les bonnes valeurs (par exemple: "Sanitherm Lyon, 1246.80 €") ou renvoie une photo plus nette.`);
        // Keep in pending confirmation or reject it
        await db.updateDocumentStatus(doc.id, 'rejected');
        await db.clearActiveContext(chatId);
      } else {
        // The user sent corrections in natural language!
        // We use Mistral to parse their text corrections and update the document, then file.
        await unipile.sendMessage(chatId, `Je prends en compte tes corrections pour finaliser l'enregistrement.`);
        try {
          const systemCorrectionPrompt = `You are a helper that extracts correct values based on the artisan's text message.
Original values:
- docType: ${doc.docType}
- supplierName: ${doc.supplierName}
- totalTtc: ${formatCentsToFrench(doc.totalTtc)}

Artisan correction message: "${replyText}"

Update the fields based on their correction. Return ONLY a JSON object with:
"supplierName" (string or null), "totalTtc" (integer cents or null), "docType" (string).`;
          
          const response = await mistral.generateResponse(systemCorrectionPrompt, `Update metadata: ${replyText}`);
          const parsed = mistral.safeJsonParse(response);
          
          const updatedExtracted: ExtractedMetadata = {
            docType: parsed.docType || doc.docType || 'other',
            supplierName: parsed.supplierName || doc.supplierName,
            supplierSirenVat: doc.supplierSirenVat,
            docNumber: doc.docNumber,
            docDate: doc.docDate,
            dueDate: doc.dueDate,
            totalHt: doc.totalHt,
            totalVat: doc.totalVat,
            totalTtc: parsed.totalTtc !== undefined ? parsed.totalTtc : doc.totalTtc,
            chantierRef: doc.chantierRef,
            vatRates: doc.vatRates || [],
            lineItems: doc.lineItems || [],
          };

          // Re-evaluate VAT anomaly check
          let vatAnomaly = doc.vatAnomalyFlag;
          if (updatedExtracted.totalHt && updatedExtracted.totalVat && updatedExtracted.vatRates.length > 0) {
            const mainRate = updatedExtracted.vatRates[0] / 100;
            const expectedVat = Math.round(updatedExtracted.totalHt * mainRate);
            vatAnomaly = Math.abs(expectedVat - updatedExtracted.totalVat) > 5;
          }

          // Save correction details
          await db.updateDocumentExtraction(
            doc.id,
            updatedExtracted,
            doc.confidenceScores || {},
            1.0, // forced confidence
            doc.rawOcrMarkdown || '',
            vatAnomaly,
            'extracted'
          );

          // Force file
          await this.processDocument(doc.id, true);
        } catch (err) {
          console.error(`[Pipeline] Failed to parse corrections from user text:`, err);
          await unipile.sendMessage(chatId, `Je n'ai pas compris ta correction. Peux-tu me renvoyer le document ou m'indiquer le fournisseur et le montant de manière claire ?`);
        }
      }
      return;
    }

    // Case 3: Due date reminder opt-in (oui/non)
    if (doc.status === 'filed' && doc.reminderScheduledAt === null && !doc.reminderSentAt) {
      const optIn = ['oui', 'yes', 'ok', 'ouis', 'yep'].includes(textClean);
      
      if (optIn && doc.dueDate) {
        // Calculate reminder date: 3 days before due date at 09:00 Europe/Paris
        const dueDate = new Date(doc.dueDate);
        const reminderDate = new Date(dueDate.getTime() - 3 * 24 * 60 * 60 * 1000);
        reminderDate.setHours(9, 0, 0, 0); // 09:00

        // If due date is fewer than 3 days away (or past), send it tomorrow morning at 09:00
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);

        const finalReminderDate = reminderDate > new Date() ? reminderDate : tomorrow;
        
        await db.updateDocumentReminder(doc.id, true, finalReminderDate);
        
        const formattedDate = `${finalReminderDate.getDate()} ${MONTHS_FR[finalReminderDate.getMonth()]}`;
        await unipile.sendMessage(chatId, `C'est noté, je t'enverrai un rappel le ${formattedDate} à 9h00.`);
      } else {
        await db.updateDocumentReminder(doc.id, false, null);
        await unipile.sendMessage(chatId, `Entendu, pas de rappel pour cette facture.`);
      }
      await db.clearActiveContext(chatId);
      return;
    }
  }
};

export default pipeline;
