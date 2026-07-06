import db from '../services/db';
import pipeline from '../services/pipeline';
import googleService, { formatCentsToFrench } from '../services/google';
import unipile from '../services/unipile';
import rag from '../services/rag';
import { config } from '../config';
import mistral from '../services/mistral';

// Define a map of job handlers
const HANDLERS: Record<string, (data: any) => Promise<void>> = {
  'process-document': async (data: { docId: string }) => {
    await pipeline.processDocument(data.docId);
  },
  'artisan-reply': async (data: { chatId: string; text: string }) => {
    await pipeline.handleArtisanReply(data.chatId, data.text);
  },
  'conversational-query': async (data: { chatId: string; question: string }) => {
    const answer = await rag.answerQuestion(data.question);
    await unipile.sendMessage(data.chatId, answer);
  },
  'gmail-poll': async () => {
    console.log('[Queue Job: gmail-poll] Polling Gmail inbox for candidate messages...');
    const messages = await googleService.listInboxEmails();
    console.log(`[Gmail Poll] Found ${messages.length} candidate email messages.`);

    for (const msg of messages) {
      if (!msg.id) continue;
      
      try {
        const fullMsg = await googleService.getEmailMessage(msg.id);
        const headers = fullMsg.payload?.headers || [];
        const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
        const subjectHeader = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
        const bodySnippet = fullMsg.snippet || '';

        // Extract attachment details
        const parts = fullMsg.payload?.parts || [];
        const attachments = parts.filter(p => p.filename && p.body?.attachmentId);

        if (attachments.length === 0) {
          // No attachments, ignore
          await googleService.markEmailProcessed(msg.id, false);
          continue;
        }

        const attachmentNames = attachments.map(a => a.filename || '');

        // LLM check to see if email plausibly contains financial documents (F-2.2)
        const checkPrompt = `You are a filter. Decide if the email described below contains financial documents (invoices, bills, receipts, quotes, delivery notes).
From: ${fromHeader}
Subject: ${subjectHeader}
Snippet: ${bodySnippet}
Attachments: ${attachmentNames.join(', ')}

Respond ONLY with a JSON object containing a single boolean: {"financial": true} or {"financial": false}.`;

        const response = await googleService.getGmail().users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'minimal'
        }); // simple test, but let's run LLM classification:
        const filterRes = await googleService.sendEmail ? await (async () => {
          // Let's call Mistral to classify the email
          const systemPrompt = `You are a filter. Decide if the email described below is likely carrying financial documents.`;
          const content = `From: ${fromHeader}\nSubject: ${subjectHeader}\nSnippet: ${bodySnippet}\nAttachments: ${attachmentNames.join(', ')}`;
          
          // Let's use Mistral Chat API to decide
          const payload = {
            model: config.mistral.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Plausibly financial? Return JSON: {"financial": true/false}.\n\n${content}` }
            ],
            response_format: { type: 'json_object' }
          };
          
          const apiRes = await axiosPostMistral(payload);
          return mistral.safeJsonParse(apiRes).financial;
        })() : true; // Fallback to true if helper fails

        if (!filterRes) {
          console.log(`[Gmail Poll] Email ${msg.id} classified as non-financial. Marking as Ignored.`);
          await googleService.markEmailProcessed(msg.id, false);
          continue;
        }

        // Process attachments independently (F-2.2)
        let anyDocumentFiled = false;
        for (const att of attachments) {
          if (!att.body?.attachmentId || !att.filename) continue;
          
          const filename = att.filename;
          const mimeType = att.mimeType || 'application/pdf';
          
          // Create a received document record in the database
          const providerMessageId = `${msg.id}:${att.body.attachmentId}`;
          
          // Check idempotency: make sure we don't process this attachment again (NFR-1)
          const existing = await db.getDocumentByMessageId(providerMessageId);
          if (existing) {
            console.log(`[Gmail Poll] Attachment ${providerMessageId} already exists in DB. Skipping.`);
            if (existing.status === 'filed') {
              anyDocumentFiled = true;
            }
            continue;
          }

          // Generate file extension
          let fileExtension = 'pdf';
          const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
          if (match) fileExtension = match[1].toLowerCase();

          // Create document
          const doc = await db.createDocument({
            originalHash: 'pending',
            fileName: filename,
            fileExtension,
            mimeType,
            channel: 'gmail',
            providerMessageId,
            status: 'received',
          });

          // Enqueue processing
          await enqueueJob('process-document', { docId: doc.id });
          anyDocumentFiled = true;
        }

        // Mark message processed/ignored based on if attachments were enqueued
        await googleService.markEmailProcessed(msg.id, anyDocumentFiled);

      } catch (err: any) {
        console.error(`[Gmail Poll] Error processing message ${msg.id}:`, err.message);
      }
    }
  },
  'check-reminders': async () => {
    console.log('[Queue Job: check-reminders] Checking for scheduled invoice reminders...');
    const now = new Date();
    // Query reminders that are due and not yet sent
    const pendingReminders = await db.query<any>(
      `SELECT id, supplier_name as "supplierName", total_ttc as "totalTtc", due_date as "dueDate", drive_link as "driveLink"
       FROM documents
       WHERE reminder_opt_in = true 
         AND reminder_scheduled_at <= $1 
         AND reminder_sent_at IS NULL`,
      [now]
    );

    console.log(`[Queue Job: check-reminders] Found ${pendingReminders.length} due reminders.`);

    for (const doc of pendingReminders) {
      try {
        const formattedTtc = formatCentsToFrench(doc.totalTtc);
        const formattedDueDate = doc.dueDate.split('-').reverse().join('/');
        
        const message = `🔔 Rappel de paiement pour la facture ${doc.supplierName || 'Fournisseur'} d'un montant de ${formattedTtc}. Échéance le ${formattedDueDate}.\n📄 Document : ${doc.driveLink || ''}`;
        
        await unipile.sendMessage(config.unipile.artisanWhatsappId, message);
        
        // Mark reminder as sent
        await db.query(`UPDATE documents SET reminder_sent_at = NOW() WHERE id = $1`, [doc.id]);
        console.log(`[Reminders] Sent reminder successfully for doc ${doc.id}`);
      } catch (err) {
        console.error(`[Reminders] Failed to send reminder for doc ${doc.id}:`, err);
      }
    }
  },
  'check-recap': async () => {
    // This runs checks for monthly email recap.
    // Timezone: Europe/Paris
    // Check if it's the 1st of the month, hour is 8:00 AM Paris time.
    // Calculate Paris time offset or format
    const parisTime = new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' });
    const parisDate = new Date(parisTime);
    
    const day = parisDate.getDate();
    const hour = parisDate.getHours();
    const minute = parisDate.getMinutes();

    // Check if day is 1 and hour is 8 (we check between 8:00 and 8:10 since job runs every 5-10 min)
    if (day === 1 && hour === 8 && minute < 10) {
      // Calculate YYYY-MM of the previous month
      let year = parisDate.getFullYear();
      let month = parisDate.getMonth(); // previous month index, e.g. if now is July (6), previous is June (5)
      
      if (month === 0) {
        month = 12;
        year--;
      }
      
      const monthStr = month.toString().padStart(2, '0');
      const period = `${year}-${monthStr}`;

      // Check if we already sent this monthly recap
      const alreadySent = await db.query(
        `SELECT id FROM jobs WHERE name = 'send-recap-email' AND data->>'period' = $1 AND status = 'completed'`,
        [period]
      );

      if (alreadySent.length === 0) {
        console.log(`[Queue] Triggering monthly email recap job for period ${period}`);
        await enqueueJob('send-recap-email', { period });
      }
    }
  },
  'send-recap-email': async (data: { period: string }) => {
    // Generates monthly recap and sends to accountant
    const { period } = data; // YYYY-MM
    console.log(`[Recap Email] Generating recap for period: ${period}...`);
    
    // Call manual trigger helper which builds the recap
    const { generateMonthlyRecap } = require('../scripts/trigger_recap');
    await generateMonthlyRecap(period);
  }
};

// Helper for making direct Mistral call during gmail classification (avoids circular dependency)
async function axiosPostMistral(payload: any): Promise<string> {
  const axios = require('axios');
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.mistral.apiKey}`,
      },
    }
  );
  return response.data?.choices?.[0]?.message?.content || '';
}

/**
 * Enqueue a new background job
 */
export async function enqueueJob(name: string, data: any, runAfter: Date = new Date(), maxAttempts = 5): Promise<string> {
  const rows = await db.query<any>(
    `INSERT INTO jobs (name, data, run_after, max_attempts, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [name, JSON.stringify(data), runAfter, maxAttempts]
  );
  return rows[0].id;
}

/**
 * Poll for a pending job, process it, and update its status (SKIP LOCKED)
 */
async function pollAndProcessJob(): Promise<boolean> {
  return db.transaction(async (client) => {
    // Acquire next pending job
    const selectRes = await client.query(
      `UPDATE jobs 
       SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE id = (
         SELECT id FROM jobs 
         WHERE status = 'pending' AND run_after <= NOW()
         ORDER BY created_at ASC 
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, name, data, attempts, max_attempts`
    );

    const job = selectRes.rows[0];
    if (!job) return false; // No jobs to process

    console.log(`[Queue] Processing job: ${job.name} (Attempt ${job.attempts}/${job.max_attempts})`);

    const handler = HANDLERS[job.name];
    if (!handler) {
      const errorMsg = `No handler registered for job: ${job.name}`;
      await client.query(
        `UPDATE jobs SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
        [errorMsg, job.id]
      );
      return true;
    }

    try {
      // Execute job handler
      await handler(job.data);
      
      // Mark as completed
      await client.query(
        `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
      console.log(`[Queue] Completed job: ${job.name} (${job.id})`);
    } catch (err: any) {
      console.error(`[Queue] Job ${job.name} failed with error:`, err.message);
      
      if (job.attempts < job.max_attempts) {
        // Retry with exponential backoff: delay 30s * 2^(attempts-1)
        const delaySeconds = 30 * Math.pow(2, job.attempts - 1);
        const retryTime = new Date(Date.now() + delaySeconds * 1000);
        
        await client.query(
          `UPDATE jobs 
           SET status = 'pending', run_after = $1, error = $2, updated_at = NOW() 
           WHERE id = $3`,
          [retryTime, err.message || 'Unknown error', job.id]
        );
        console.warn(`[Queue] Job ${job.name} enqueued for retry at ${retryTime.toISOString()}`);
      } else {
        // Mark as failed permanently
        await client.query(
          `UPDATE jobs 
           SET status = 'failed', error = $1, updated_at = NOW() 
           WHERE id = $2`,
          [err.message || 'Max attempts reached', job.id]
        );
        console.error(`[Queue] Job ${job.name} permanently failed (max attempts reached).`);
      }
    }

    return true;
  });
}

/**
 * Start the polling loop for jobs and schedulers
 */
export function startQueue() {
  console.log('[Queue] Starting task queue worker loop...');
  
  // Job processing loop (every 2 seconds)
  setInterval(async () => {
    try {
      let processed = true;
      // Loop until there are no more pending jobs
      while (processed) {
        processed = await pollAndProcessJob();
      }
    } catch (err) {
      console.error('[Queue Worker Loop Error]', err);
    }
  }, 2000);

  // Schedulers loop (every 1 minute)
  // Schedules: check-reminders, check-recap, and gmail-poll
  setInterval(async () => {
    try {
      // 1. Enqueue Gmail poll
      await enqueueJob('gmail-poll', {}, new Date(), 3);
      // 2. Enqueue reminders check
      await enqueueJob('check-reminders', {}, new Date(), 3);
      // 3. Enqueue monthly recap check
      await enqueueJob('check-recap', {}, new Date(), 3);
    } catch (err) {
      console.error('[Queue Scheduler Error]', err);
    }
  }, 60000); // 1 minute
}
