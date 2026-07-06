import db from '../services/db';
import googleService from '../services/google';
import { config } from '../config';

async function reset() {
  console.log('[Reset] Wiping database state...');
  
  // Wipe all database tables
  await db.query('DELETE FROM active_contexts');
  await db.query('DELETE FROM document_chunks');
  await db.query('DELETE FROM documents');
  await db.query('DELETE FROM jobs');
  
  console.log('[Reset] Database state wiped successfully.');

  // Wipe Google Drive folder contents
  if (config.google.driveFolderId) {
    try {
      console.log(`[Reset] Deleting children of Google Drive root folder: ${config.google.driveFolderId}...`);
      const drive = googleService.getDrive();
      
      const response = await drive.files.list({
        q: `'${config.google.driveFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
      });

      const files = response.data.files || [];
      console.log(`[Reset] Found ${files.length} child folders/files to delete.`);
      
      for (const file of files) {
        if (!file.id) continue;
        console.log(`[Reset] Deleting Drive file/folder: ${file.name} (${file.id})`);
        await drive.files.delete({ fileId: file.id });
      }
      console.log('[Reset] Google Drive folders cleaned.');
    } catch (err: any) {
      console.error('[Reset Error] Google Drive reset failed:', err.message);
    }
  }

  // Clear Google Sheets Ledger
  if (config.google.sheetId) {
    try {
      console.log(`[Reset] Clearing Google Sheets journal: ${config.google.sheetId}...`);
      const sheets = googleService.getSheets();
      
      const spreadsheetInfo = await sheets.spreadsheets.get({
        spreadsheetId: config.google.sheetId,
      });

      const sheetsList = spreadsheetInfo.data.sheets || [];
      console.log(`[Reset] Found ${sheetsList.length} tabs in spreadsheet.`);

      // We delete all tabs except the first one, which we clear.
      // A spreadsheet must have at least one sheet.
      if (sheetsList.length > 0) {
        const firstSheetTitle = sheetsList[0].properties?.title || 'Sheet1';
        
        // Clear first sheet
        await sheets.spreadsheets.values.clear({
          spreadsheetId: config.google.sheetId,
          range: `${firstSheetTitle}!A:Z`,
        });

        // If there are other sheets (like 2026, 2027), delete them
        const deleteRequests = [];
        for (let i = 1; i < sheetsList.length; i++) {
          const sheetId = sheetsList[i].properties?.sheetId;
          if (sheetId !== undefined) {
            deleteRequests.push({
              deleteSheet: {
                sheetId,
              },
            });
          }
        }

        if (deleteRequests.length > 0) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: config.google.sheetId,
            requestBody: {
              requests: deleteRequests,
            },
          });
        }
      }
      console.log('[Reset] Google Sheets ledger cleared.');
    } catch (err: any) {
      console.error('[Reset Error] Google Sheets reset failed:', err.message);
    }
  }

  // Delete Gmail Labels (resets processed status on emails)
  try {
    console.log('[Reset] Deleting Gmail labels "Klerk/Processed" and "Klerk/Ignored"...');
    const gmail = googleService.getGmail();
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const labels = labelsRes.data.labels || [];
    
    const labelNames = ['Klerk/Processed', 'Klerk/Ignored'];
    for (const name of labelNames) {
      const match = labels.find((l) => l.name === name);
      if (match && match.id) {
        console.log(`[Reset] Deleting label: ${name} (${match.id})`);
        await gmail.users.labels.delete({
          userId: 'me',
          id: match.id,
        });
      }
    }
    console.log('[Reset] Gmail labels deleted.');
  } catch (err: any) {
    console.error('[Reset Error] Gmail labels reset failed:', err.message);
  }

  console.log('[Reset] Complete system reset finished.');
  process.exit(0);
}

reset().catch((err) => {
  console.error('[Reset Failed]', err);
  process.exit(1);
});
