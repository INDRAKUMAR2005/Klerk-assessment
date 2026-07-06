import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { DocType } from '../models/types';
import stream from 'stream';

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];

const CATEGORY_MAP: Record<string, string> = {
  supplier_invoice: 'Fournisseurs',
  receipt: 'Tickets',
  quote: 'Devis',
  delivery_note: 'BL',
  other: 'Autres',
};

// Initialize OAuth2 client
const oauth2Client = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret
);

oauth2Client.setCredentials({
  refresh_token: config.google.refreshToken,
});

/**
 * Format cents to French currency display string (e.g. 124680 -> "1 246,80 €")
 */
export function formatCentsToFrench(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const euros = cents / 100;
  // Replace standard space with non-breaking space for French format style
  return euros.toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).replace(/\s/g, ' ');
}

export const googleService = {
  /**
   * Get authenticated Drive client
   */
  getDrive() {
    return google.drive({ version: 'v3', auth: oauth2Client });
  },

  /**
   * Get authenticated Sheets client
   */
  getSheets() {
    return google.sheets({ version: 'v4', auth: oauth2Client });
  },

  /**
   * Get authenticated Gmail client
   */
  getGmail() {
    return google.gmail({ version: 'v1', auth: oauth2Client });
  },

  // --- Google Drive Operations ---

  /**
   * Find a folder by name inside a parent folder, or create it if not exists
   */
  async getOrCreateFolder(parentFolderId: string, folderName: string): Promise<string> {
    const drive = this.getDrive();
    
    // Check if folder exists
    const response = await drive.files.list({
      q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    const files = response.data.files || [];
    if (files.length > 0 && files[0].id) {
      return files[0].id;
    }

    // Create folder
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    };

    const folder = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id',
    });

    if (!folder.data.id) {
      throw new Error(`Failed to create Google Drive folder: ${folderName}`);
    }

    return folder.data.id;
  },

  /**
   * Get or create the full destination folder path in Google Drive
   * Structure: Klerk/Compta/{YYYY}/{MM-MonthNameFR}/{Category}/
   */
  async getDestinationFolder(docDateStr: string | null, docType: DocType): Promise<string> {
    const rootFolderId = config.google.driveFolderId;
    if (!rootFolderId) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured.');
    }

    // Parse date (default to today if document date is null or invalid)
    let year = new Date().getFullYear().toString();
    let monthNum = (new Date().getMonth() + 1).toString().padStart(2, '0');
    let monthName = MONTHS_FR[new Date().getMonth()];

    if (docDateStr && /^\d{4}-\d{2}-\d{2}$/.test(docDateStr)) {
      const parts = docDateStr.split('-');
      year = parts[0];
      monthNum = parts[1];
      const mIdx = parseInt(parts[1], 10) - 1;
      if (mIdx >= 0 && mIdx < 12) {
        monthName = MONTHS_FR[mIdx];
      }
    }

    const monthFolderName = `${monthNum}-${monthName}`;
    const categoryFolderName = CATEGORY_MAP[docType] || 'Autres';

    // Walk/create tree
    const yearFolderId = await this.getOrCreateFolder(rootFolderId, year);
    const monthFolderId = await this.getOrCreateFolder(yearFolderId, monthFolderName);
    const categoryFolderId = await this.getOrCreateFolder(monthFolderId, categoryFolderName);

    return categoryFolderId;
  },

  /**
   * Upload file buffer to a specific Google Drive folder
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    folderId: string
  ): Promise<{ id: string; webViewLink: string }> {
    const drive = this.getDrive();

    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: mimeType,
      body: bufferStream,
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    });

    if (!file.data.id || !file.data.webViewLink) {
      throw new Error(`Failed to upload file to Google Drive: ${fileName}`);
    }

    // Share link settings - update permission so anyone with the link can view (public read-only)
    try {
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });
    } catch (permError) {
      console.warn(`[Drive API] Could not set public permissions on file ${file.data.id}`, permError);
    }

    return {
      id: file.data.id,
      webViewLink: file.data.webViewLink,
    };
  },

  // --- Google Sheets Operations ---

  /**
   * Append a row to the journal spreadsheet in the tab matching {YYYY}
   */
  async appendJournalRow(
    docDateStr: string | null,
    ingestedAtStr: string,
    channel: string,
    docType: string,
    supplierName: string | null,
    chantierRef: string | null,
    htCents: number | null,
    vatCents: number | null,
    ttcCents: number | null,
    dueDateStr: string | null,
    driveLink: string | null,
    status: string,
    minConfidence: number | null,
    docId: string
  ): Promise<number> {
    const spreadsheetId = config.google.sheetId;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEET_ID is not configured.');
    }

    const sheets = this.getSheets();

    // Determine year sheet name
    let year = new Date().getFullYear().toString();
    if (docDateStr && /^\d{4}-\d{2}-\d{2}$/.test(docDateStr)) {
      year = docDateStr.split('-')[0];
    }

    // Ensure tab exists
    try {
      const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetNames = (spreadsheetInfo.data.sheets || []).map((s) => s.properties?.title);
      
      if (!sheetNames.includes(year)) {
        // Create the sheet/tab
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: year,
                  },
                },
              },
            ],
          },
        });

        // Add headers to new tab
        const headers = [
          'doc_date', 'ingested_at', 'channel', 'doc_type', 'supplier', 'chantier', 
          'ht', 'tva', 'ttc', 'due_date', 'drive_link', 'status', 'min_confidence', 'doc_id'
        ];
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${year}!A1:N1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [headers],
          },
        });
      }
    } catch (err: any) {
      console.error('[Sheets API] Error verifying/creating tab:', err.message);
      throw err;
    }

    // Format amounts using French formatting
    const htFormatted = formatCentsToFrench(htCents);
    const tvaFormatted = formatCentsToFrench(vatCents);
    const ttcFormatted = formatCentsToFrench(ttcCents);

    // Row values
    const rowValues = [
      docDateStr || '',
      ingestedAtStr,
      channel,
      docType,
      supplierName || '',
      chantierRef || '',
      htFormatted,
      tvaFormatted,
      ttcFormatted,
      dueDateStr || '',
      driveLink || '',
      status,
      minConfidence !== null ? minConfidence.toFixed(2) : '',
      docId,
    ];

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${year}!A:N`,
      valueInputOption: 'USER_ENTERED', // Enables parsing currency formatted string as text/values
      requestBody: {
        values: [rowValues],
      },
    });

    // Parse appended row index if available
    const range = response.data.updates?.updatedRange || '';
    const match = /!A(\d+):/.exec(range);
    return match ? parseInt(match[1], 10) : 0;
  },

  // --- Gmail Operations ---

  /**
   * Create a Gmail label if it does not already exist
   */
  async getOrCreateLabel(labelName: string): Promise<string> {
    const gmail = this.getGmail();
    const response = await gmail.users.labels.list({ userId: 'me' });
    const labels = response.data.labels || [];
    
    const existing = labels.find((l) => l.name === labelName);
    if (existing && existing.id) {
      return existing.id;
    }

    // Create the label
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });

    if (!created.data.id) {
      throw new Error(`Failed to create Gmail label: ${labelName}`);
    }

    return created.data.id;
  },

  /**
   * List unread Gmail messages containing attachments
   */
  async listInboxEmails(): Promise<any[]> {
    const gmail = this.getGmail();
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'has:attachment -label:Klerk/Processed -label:Klerk/Ignored label:INBOX',
    });
    return response.data.messages || [];
  },

  /**
   * Get detailed info for a Gmail message
   */
  async getEmailMessage(messageId: string) {
    const gmail = this.getGmail();
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return response.data;
  },

  /**
   * Download Gmail attachment data
   */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const gmail = this.getGmail();
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: attachmentId,
    });

    const base64Data = response.data.data;
    if (!base64Data) {
      throw new Error(`Gmail attachment ${attachmentId} returned empty data`);
    }

    // Gmail base64 uses url-safe encoding (RFC 4648)
    const base64Clean = base64Data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64Clean, 'base64');
  },

  /**
   * Label email as Processed or Ignored and archive it from INBOX
   */
  async markEmailProcessed(messageId: string, success: boolean): Promise<void> {
    const labelToAdd = success ? 'Klerk/Processed' : 'Klerk/Ignored';
    
    // Ensure labels exist
    const labelId = await this.getOrCreateLabel(labelToAdd);

    const gmail = this.getGmail();
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
        removeLabelIds: ['INBOX'], // Archive it
      },
    });
  },

  /**
   * Send monthly recap email with attachment (CSV)
   */
  async sendEmail(
    to: string,
    subject: string,
    bodyHtml: string,
    attachments: { filename: string; content: string; contentType: string }[]
  ): Promise<void> {
    const gmail = this.getGmail();

    // Build raw email message MIME format
    const boundary = 'klerk_mail_boundary_' + Date.now();
    const nl = '\r\n';

    let rawMessage = `To: ${to}${nl}`;
    rawMessage += `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=${nl}`;
    rawMessage += `MIME-Version: 1.0${nl}`;
    rawMessage += `Content-Type: multipart/mixed; boundary="${boundary}"${nl}${nl}`;

    // Body part
    rawMessage += `--${boundary}${nl}`;
    rawMessage += `Content-Type: text/html; charset="UTF-8"${nl}`;
    rawMessage += `Content-Transfer-Encoding: base64${nl}${nl}`;
    rawMessage += Buffer.from(bodyHtml).toString('base64') + nl + nl;

    // Attachments
    for (const att of attachments) {
      rawMessage += `--${boundary}${nl}`;
      rawMessage += `Content-Type: ${att.contentType}; name="${att.filename}"${nl}`;
      rawMessage += `Content-Disposition: attachment; filename="${att.filename}"${nl}`;
      rawMessage += `Content-Transfer-Encoding: base64${nl}${nl}`;
      rawMessage += Buffer.from(att.content).toString('base64') + nl + nl;
    }

    rawMessage += `--${boundary}--`;

    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });
  }
};

export default googleService;
