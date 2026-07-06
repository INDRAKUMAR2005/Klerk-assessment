import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../services/db';
import pipeline from '../services/pipeline';
import googleService from '../services/google';
import unipile from '../services/unipile';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep a map of file hash -> attachment details in memory
const localFileMap = new Map<string, { buffer: Buffer; fileName: string; mimeType: string }>();

// Mock Google Services in memory so we do not attempt network requests to Sheets/Drive
googleService.getDestinationFolder = async () => 'mock_folder_id';
googleService.uploadFile = async (buf, name, mime) => ({
  id: 'mock_drive_file_id_' + name.replace(/[^a-zA-Z0-9]/g, '_'),
  webViewLink: 'https://drive.google.com/file/d/mock_drive_file_id_' + name.replace(/[^a-zA-Z0-9]/g, '_')
});
googleService.appendJournalRow = async () => 1; // dummy row index

googleService.downloadAttachment = async (messageId: string, attachmentId: string): Promise<Buffer> => {
  const match = localFileMap.get(attachmentId);
  if (match) return match.buffer;
  throw new Error('Mock attachment not found in googleService: ' + attachmentId);
};

// Mock Unipile
unipile.sendMessage = async (chatId, text) => {
  console.log(`[Mock Unipile] Sending message to ${chatId}: "${text}"`);
  return { id: 'mock_unipile_msg_id_' + Date.now() } as any;
};

unipile.downloadAttachment = async (messageId: string, attachmentId: string) => {
  const match = localFileMap.get(attachmentId);
  if (match) {
    return { data: match.buffer, mimeType: match.mimeType, fileName: match.fileName } as any;
  }
  throw new Error('Mock attachment not found in unipile: ' + attachmentId);
};

// Simple eml parser to extract base64 attachment parts
interface Attachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

function parseEmlAttachments(emlPath: string): Attachment[] {
  const content = fs.readFileSync(emlPath, 'utf8');
  const contentTypeMatch = content.match(/Content-Type: multipart\/mixed;\s*boundary="([^"]+)"/i);
  if (!contentTypeMatch) return [];
  const boundary = contentTypeMatch[1];
  const parts = content.split(`--${boundary}`);
  
  const attachments: Attachment[] = [];
  for (const part of parts) {
    if (part.includes('Content-Disposition: attachment')) {
      const filenameMatch = part.match(/filename="([^"]+)"/i);
      const filename = filenameMatch ? filenameMatch[1] : 'attachment.dat';
      
      const contentTypeMatch = part.match(/Content-Type: ([^\s;]+)/i);
      const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
      
      let headerEnd = part.indexOf('\r\n\r\n');
      let offset = 4;
      if (headerEnd === -1) {
        headerEnd = part.indexOf('\n\n');
        offset = 2;
      }
      if (headerEnd === -1) continue;
      
      const base64Body = part.substring(headerEnd + offset).replace(/[\r\n\s]/g, '');
      const data = Buffer.from(base64Body, 'base64');
      attachments.push({ filename, contentType, data });
    }
  }
  return attachments;
}

async function ingestCorpus() {
  console.log('[Ingest Script] Starting mock ingestion of the public test dataset...');
  
  const datasetPath = path.join(__dirname, '../../../klerk_candidate_pack/candidate_pack/05_TEST_DATASET');
  const whatsappDir = path.join(datasetPath, 'whatsapp_inbox');
  const emailDir = path.join(datasetPath, 'email_inbox');
  
  // 1. Process WhatsApp inbox files
  console.log('\n========================================');
  console.log('1. Processing WhatsApp files...');
  console.log('========================================');
  const whatsappFiles = fs.readdirSync(whatsappDir);
  
  for (let i = 0; i < whatsappFiles.length; i++) {
    const filename = whatsappFiles[i];
    const filePath = path.join(whatsappDir, filename);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    
    console.log(`\n[WhatsApp Ingest ${i+1}/${whatsappFiles.length}] File: ${filename}`);
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
    const providerMessageId = `wa_msg_${hash}:${hash}`;
    
    // Register in the local file map
    localFileMap.set(hash, { buffer: fileBuffer, fileName: filename, mimeType });
    
    // Check if it already exists (deduplication)
    const existing = await db.getDocumentByMessageId(providerMessageId);
    if (existing) {
      console.log(`Document ${filename} already exists. Skipping.`);
      continue;
    }
    
    const doc = await db.createDocument({
      originalHash: hash,
      fileName: filename,
      fileExtension: ext.slice(1),
      mimeType,
      channel: 'whatsapp',
      providerMessageId,
      status: 'received'
    });
    
    console.log(`Document created with ID: ${doc.id}. Processing through pipeline...`);
    // Run normal pipeline process (forceOverride=false so confidence/dedup logic works naturally!)
    await pipeline.processDocument(doc.id, false);
    
    // Sleep to prevent hitting Mistral rate limits too heavily
    console.log('[Ingest Script] Sleeping 15 seconds...');
    await sleep(15000);
  }
  
  // 2. Process Email inbox files
  console.log('\n========================================');
  console.log('2. Processing Email (.eml) files...');
  console.log('========================================');
  const emailFiles = fs.readdirSync(emailDir).filter(f => f.endsWith('.eml'));
  
  for (let i = 0; i < emailFiles.length; i++) {
    const filename = emailFiles[i];
    const filePath = path.join(emailDir, filename);
    
    console.log(`\n[Email Ingest ${i+1}/${emailFiles.length}] File: ${filename}`);
    const attachments = parseEmlAttachments(filePath);
    console.log(`Found ${attachments.length} attachments in email ${filename}`);
    
    for (const att of attachments) {
      console.log(`  Processing attachment: ${att.filename} (${att.data.length} bytes)`);
      const hash = crypto.createHash('md5').update(att.data).digest('hex');
      const ext = path.extname(att.filename).toLowerCase();
      const mimeType = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
      const providerMessageId = `gmail_msg_${hash}:${hash}`;
      
      // Register in the local file map
      localFileMap.set(hash, { buffer: att.data, fileName: att.filename, mimeType });
      
      const existing = await db.getDocumentByMessageId(providerMessageId);
      if (existing) {
        console.log(`  Attachment ${att.filename} already exists in DB. Skipping.`);
        continue;
      }
      
      const doc = await db.createDocument({
        originalHash: hash,
        fileName: att.filename,
        fileExtension: ext.slice(1),
        mimeType,
        channel: 'gmail',
        providerMessageId,
        status: 'received'
      });
      
      console.log(`  Created doc ID: ${doc.id}. Processing through pipeline...`);
      await pipeline.processDocument(doc.id, false);
      
      console.log('[Ingest Script] Sleeping 15 seconds...');
      await sleep(15000);
    }
  }
  
  console.log('\n[Ingest Script] Mock ingestion of public test dataset completed successfully!');
  process.exit(0);
}

ingestCorpus().catch(err => {
  console.error('[Ingest Script Error]', err);
  process.exit(1);
});
