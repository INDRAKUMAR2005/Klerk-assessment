import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { config, validateConfig } from './config';
import { startQueue, enqueueJob } from './queue';
import db from './services/db';
import unipile from './services/unipile';
import pipeline from './services/pipeline';
import rag from './services/rag';
import { generateMonthlyRecap } from './scripts/trigger_recap';

const app = express();

app.use(cors());
app.use((req, res, next) => {
  if (req.path === '/api/webhooks/unipile') {
    req.headers['content-type'] = 'application/json';
  }
  next();
});
app.use(express.json());

export const webhookLogs: string[] = [];

/**
 * Log viewing endpoint for debugging webhooks
 */
app.get('/api/webhook-logs', (req: Request, res: Response) => {
  res.json({ logs: webhookLogs });
});

// Start validation checks
validateConfig();

/**
 * Home endpoint
 */
app.get('/', (req: Request, res: Response) => {
  res.send('Klerk Backend API is running successfully. Try /health for status.');
});

/**
 * Health check endpoint
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});


/**
 * Unipile webhook receiver (Flow A / WhatsApp text or attachments)
 */
app.post('/api/webhooks/unipile', async (req: Request, res: Response) => {
  webhookLogs.push(`[${new Date().toISOString()}] Raw webhook body: ${JSON.stringify(req.body)}`);
  const { event, message_id, chat_id, message, sender, attachments, account_type } = req.body;

  // We only process message_received events for WhatsApp
  if (event !== 'message_received' || account_type !== 'WHATSAPP') {
    res.sendStatus(200);
    return;
  }

  // Discard messages sent by the bot itself to prevent infinite loops (NFR-1 / webhook loop)
  if (req.body.from_me === true || req.body.message?.from_me === true) {
    res.sendStatus(200);
    return;
  }

  // Ensure message is from a trusted artisan to prevent responding to our own messages
  const senderId = sender?.attendee_provider_id || sender?.id || '';
  const artisanId = config.unipile.artisanWhatsappId;
  
  // Normalize: strip @c.us and compare just the phone numbers
  const normalizeId = (id: string) => id.replace(/@c\.us$/i, '').replace(/@.*$/, '').trim();
  const senderNorm = normalizeId(senderId);

  // Support comma-separated list of artisan IDs: e.g. "919095334806,917349190213"
  const artisanIds = artisanId.split(',').map(normalizeId).filter(Boolean);
  let isArtisan = artisanIds.includes(senderNorm);

  const logMsg = `[Unipile Webhook] Sender: "${senderId}" (normalized: "${senderNorm}"), Trusted artisans: [${artisanIds.join(', ')}], isArtisanDirect: ${isArtisan}`;
  console.log(logMsg);
  webhookLogs.push(logMsg);
  
  if (!isArtisan && chat_id) {
    try {
      const chatUrl = `${config.unipile.apiUrl}/api/v1/chats/${chat_id}`;
      webhookLogs.push(`[Unipile Webhook] Checking chat URL: ${chatUrl}`);
      const chatRes = await axios.get(chatUrl, {
        headers: {
          'X-API-KEY': config.unipile.apiKey,
          'accept': 'application/json',
        },
      });
      const attendeeIdentifier = chatRes.data?.attendee_public_identifier || '';
      webhookLogs.push(`[Unipile Webhook] Fetched chat details: attendee_public_identifier=${attendeeIdentifier}`);
      if (attendeeIdentifier) {
        const attendeeNorm = normalizeId(attendeeIdentifier);
        if (artisanIds.includes(attendeeNorm)) {
          isArtisan = true;
          const logMsg2 = `[Unipile Webhook] Verified sender via chat attendee public identifier: ${attendeeIdentifier}`;
          console.log(logMsg2);
          webhookLogs.push(logMsg2);
        }
      }
    } catch (err: any) {
      const logErr = `[Unipile Webhook] Failed to fetch chat details for verification: ${err.message}`;
      console.warn(logErr);
      webhookLogs.push(logErr);
    }
  }

  if (!isArtisan) {
    const logMsg3 = `[Unipile Webhook] Ignoring message from non-artisan sender: ${senderId}`;
    console.log(logMsg3);
    webhookLogs.push(logMsg3);
    res.sendStatus(200);
    return;
  }


  console.log(`[Unipile Webhook] Received message ${message_id} in chat ${chat_id} from Julien: "${message || 'with attachments'}"`);

  try {
    // 1. Check message idempotence (NFR-1)
    // For attachments, we'll check unique message_id + attachment_id combination in queue/process steps.
    // For text messages, we check message_id directly in DB.
    const hasAttachments = attachments && attachments.length > 0;

    if (hasAttachments) {
      console.log(`[Unipile Webhook] Message contains ${attachments.length} attachment(s). Ingesting...`);
      
      let enqueuedCount = 0;
      for (const att of attachments) {
        const attachmentId = att.attachment_id || att.id;
        if (!attachmentId) continue;
        
        const providerMessageId = `${message_id}:${attachmentId}`;
        
        // Idempotency check: check if already processed or processing
        const existing = await db.getDocumentByMessageId(providerMessageId);
        if (existing) {
          console.log(`[Unipile Webhook] Attachment ${providerMessageId} already received, skipping duplicate ingestion.`);
          continue;
        }

        // Determine mime-type and filename
        let mimeType = att.mimetype || att.mime_type || 'application/octet-stream';
        if (att.attachment_type === 'img' || att.type === 'img') {
          mimeType = 'image/jpeg';
        }
        
        const filename = att.filename || `whatsapp_doc_${attachmentId}`;
        
        let fileExtension = 'pdf';
        if (mimeType.startsWith('image/')) {
          fileExtension = 'jpg';
        }
        const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
        if (match) fileExtension = match[1].toLowerCase();

        // Create received document record
        const doc = await db.createDocument({
          originalHash: 'pending',
          fileName: filename,
          fileExtension,
          mimeType,
          channel: 'whatsapp',
          providerMessageId,
          status: 'received',
        });

        // Enqueue document processing job
        await enqueueJob('process-document', { docId: doc.id });
        enqueuedCount++;
      }

      console.log(`[Unipile Webhook] Enqueued ${enqueuedCount} document(s) for processing.`);
      res.sendStatus(200);
      return;
    }

    // 2. Handle Text-Only message (either conversation response or Q&A)
    if (message && message.trim().length > 0) {
      const messageText = message.trim();

      // Check if we are waiting for a user action / confirmation context (F-1.7)
      const pendingDocId = await db.getActiveContext(chat_id);
      
      if (pendingDocId) {
        console.log(`[Unipile Webhook] Routing reply "${messageText}" to active context for doc: ${pendingDocId}`);
        // Handle reply in background queue to respond instantly (keeps webhook response time < 30s)
        await enqueueJob('artisan-reply', { chatId: chat_id, text: messageText });
      } else {
        console.log(`[Unipile Webhook] Routing text query to RAG conversational Q&A...`);
        // Handle RAG answer in background queue
        await enqueueJob('conversational-query', { chatId: chat_id, question: messageText });
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[Unipile Webhook Error]', err);
    res.status(500).send(err.message);
  }
});

// Setup dynamic worker routing for text events in background queue
import { pool } from './services/db';

/**
 * Endpoint to trigger manual monthly accountant recap (F-4.3)
 */
app.post('/api/recap', async (req: Request, res: Response) => {
  const { period } = req.body; // format YYYY-MM
  
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    res.status(400).json({ error: 'La période doit être au format YYYY-MM. Exemple: 2026-06' });
    return;
  }

  try {
    await generateMonthlyRecap(period);
    res.json({ message: `Récapitulatif généré et envoyé à l'adresse comptable pour la période ${period}.` });
  } catch (err: any) {
    console.error('[Manual Recap Error]', err);
    res.status(500).json({ error: err.message || 'Erreur interne' });
  }
});

/**
 * Dashboard API: List all documents (F-6.1)
 */
app.get('/api/documents', async (req: Request, res: Response) => {
  try {
    const rows = await db.query(
      `SELECT 
        id, file_name as "fileName", channel, status, doc_type as "docType", 
        supplier_name as "supplierName", total_ttc as "totalTtc", 
        doc_date as "docDate", due_date as "dueDate", drive_link as "driveLink",
        min_confidence as "minConfidence", created_at as "createdAt"
       FROM documents 
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Dashboard API: Get anomalies list
 */
app.get('/api/anomalies', async (req: Request, res: Response) => {
  try {
    const rows = await db.query(
      `SELECT 
        id, file_name as "fileName", supplier_name as "supplierName", 
        total_ttc as "totalTtc", due_date as "dueDate", drive_link as "driveLink", 
        status, vat_anomaly_flag as "vatAnomalyFlag"
       FROM documents
       WHERE vat_anomaly_flag = true 
          OR status = 'duplicate_ignored' 
          OR (doc_type = 'supplier_invoice' AND due_date < NOW()::date AND status = 'filed')
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Dashboard API: Get monthly totals statistics
 */
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    // Get summary of filed counts and TTC totals by category
    const rows = await db.query(
      `SELECT 
        doc_type as "docType", 
        count(id)::int as count, 
        sum(total_ttc)::int as "totalTtc"
       FROM documents 
       WHERE status = 'filed'
       GROUP BY doc_type`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Boot Server and Queue
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`[Server] Klerk backend server running on port ${PORT} in ${config.env} mode.`);
  
  // Start job processing queues
  startQueue();
});
