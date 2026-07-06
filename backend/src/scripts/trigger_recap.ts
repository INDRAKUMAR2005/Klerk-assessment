import db from '../services/db';
import googleService, { formatCentsToFrench } from '../services/google';
import { config } from '../config';

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];

const CATEGORY_NAMES: Record<string, string> = {
  supplier_invoice: 'Factures Fournisseurs',
  receipt: 'Tickets de caisse',
  quote: 'Devis clients',
  delivery_note: 'Bons de livraison',
  other: 'Autres documents',
};

/**
 * Generate monthly recap HTML and CSV attachment, and email it to the accountant
 */
export async function generateMonthlyRecap(period: string): Promise<void> {
  const [yearStr, monthStr] = period.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    throw new Error(`Format de période invalide: ${period}. Utilise le format YYYY-MM.`);
  }

  const startDate = `${period}-01`;
  // Get end of month
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${period}-${lastDay}`;

  console.log(`[Recap] Running recap queries for date range: ${startDate} to ${endDate}`);

  // 1. Query documents in range
  const docs = await db.query<any>(
    `SELECT 
      id, doc_date as "docDate", created_at as "createdAt", channel, doc_type as "docType",
      supplier_name as "supplierName", chantier_ref as "chantierRef", 
      total_ht as "totalHt", total_vat as "totalVat", total_ttc as "totalTtc",
      due_date as "dueDate", drive_link as "driveLink", status,
      vat_anomaly_flag as "vatAnomalyFlag", min_confidence as "minConfidence"
     FROM documents
     WHERE (doc_date >= $1 AND doc_date <= $2) OR (doc_date IS NULL AND created_at::date >= $1 AND created_at::date <= $2)
     ORDER BY doc_date ASC, created_at ASC`,
    [startDate, endDate]
  );

  // 2. Compute stats by category
  const stats: Record<string, { count: number; totalTtcCents: number }> = {
    supplier_invoice: { count: 0, totalTtcCents: 0 },
    receipt: { count: 0, totalTtcCents: 0 },
    quote: { count: 0, totalTtcCents: 0 },
    delivery_note: { count: 0, totalTtcCents: 0 },
    other: { count: 0, totalTtcCents: 0 },
  };

  for (const doc of docs) {
    if (doc.status === 'duplicate_ignored' || doc.status === 'rejected') continue;
    const type = doc.docType || 'other';
    if (!stats[type]) {
      stats[type] = { count: 0, totalTtcCents: 0 };
    }
    stats[type].count++;
    stats[type].totalTtcCents += doc.totalTtc || 0;
  }

  // 3. Find anomalies
  // A. VAT Anomalies (vat_anomaly_flag = true)
  const vatAnomalies = docs.filter((d: any) => d.vatAnomalyFlag && d.status === 'filed');
  
  // B. Overdue Invoices: due_date in past and not yet paid (payment is out of scope, so just check due_date < today)
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdueInvoices = docs.filter((d: any) => d.docType === 'supplier_invoice' && d.dueDate && d.dueDate < todayStr && d.status === 'filed');

  // C. Duplicates ignored in that period
  const duplicates = docs.filter((d: any) => d.status === 'duplicate_ignored');

  // D. Pending confirmation
  const pendingDocs = docs.filter((d: any) => d.status === 'pending_confirmation');

  // 4. Find Google Drive folder link for this month
  let monthFolderLink = '';
  try {
    const rootFolderId = config.google.driveFolderId;
    const drive = googleService.getDrive();
    
    // Find year folder
    const yearList = await drive.files.list({
      q: `'${rootFolderId}' in parents and name = '${year}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
    });
    const yearFolderId = yearList.data.files?.[0]?.id;

    if (yearFolderId) {
      const monthFolderFr = `${monthStr}-${getMonthNameFr(month)}`;
      const monthList = await drive.files.list({
        q: `'${yearFolderId}' in parents and name = '${monthFolderFr}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, webViewLink)',
      });
      monthFolderLink = monthList.data.files?.[0]?.webViewLink || '';
    }
  } catch (err: any) {
    console.warn('[Recap] Could not fetch Drive month folder link:', err.message);
  }

  // 5. Build HTML Email Body (in French)
  const monthName = getMonthNameFr(month);
  let html = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; line-height: 1.6;">
      <h2 style="color: #2c3e50; border-bottom: 2px solid #ecf0f1; padding-bottom: 10px;">Récapitulatif Comptable — ${monthName} ${year}</h2>
      <p>Bonjour,</p>
      <p>Voici le récapitulatif mensuel des pièces comptables de <strong>Moreau Plomberie Chauffage</strong> pour la période de ${monthName} ${year}.</p>
      
      <h3 style="color: #34495e;">1. Totaux par catégorie</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #f8f9fa;">
            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Catégorie</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: center;">Nombre</th>
            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Total TTC</th>
          </tr>
        </thead>
        <tbody>
  `;

  let grandTotalCents = 0;
  for (const [type, data] of Object.entries(stats)) {
    // Quote is not an expense, delivery note doesn't carry values
    const isExpense = type === 'supplier_invoice' || type === 'receipt' || type === 'other';
    const totalTtcStr = type === 'delivery_note' ? '-' : formatCentsToFrench(data.totalTtcCents);
    
    html += `
      <tr>
        <td style="border: 1px solid #ddd; padding: 8px;">${CATEGORY_NAMES[type]}</td>
        <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${data.count}</td>
        <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${totalTtcStr}</td>
      </tr>
    `;

    if (isExpense) {
      grandTotalCents += data.totalTtcCents;
    }
  }

  html += `
          <tr style="font-weight: bold; background-color: #eaedd0;">
            <td style="border: 1px solid #ddd; padding: 8px;">Total Dépenses (Factures + Tickets)</td>
            <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">-</td>
            <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${formatCentsToFrench(grandTotalCents)}</td>
          </tr>
        </tbody>
      </table>
  `;

  // Folder Link
  if (monthFolderLink) {
    html += `
      <p style="margin: 20px 0;">
        📂 <strong>Accéder au dossier Google Drive du mois :</strong> <a href="${monthFolderLink}" style="color: #3498db; text-decoration: none; font-weight: bold;">Voir les documents sur Google Drive</a>
      </p>
    `;
  }

  // 6. Anomalies section
  html += `<h3 style="color: #c0392b; border-bottom: 1px solid #f9d5d5; padding-bottom: 5px;">2. Anomalies et points de vigilance</h3>`;
  
  let hasAnomalies = false;
  let anomaliesHtml = `<ul style="padding-left: 20px; color: #7f8c8d;">`;

  if (vatAnomalies.length > 0) {
    hasAnomalies = true;
    anomaliesHtml += `<li><strong>Incohérences de TVA détectées (${vatAnomalies.length}) :</strong><ul>`;
    for (const doc of vatAnomalies) {
      const ht = formatCentsToFrench(doc.totalHt);
      const tva = formatCentsToFrench(doc.totalVat);
      const ratesStr = doc.vatRates ? doc.vatRates.join(', ') : '0';
      anomaliesHtml += `<li>${doc.supplierName || 'Fournisseur'} - Facture ${doc.docNumber || 'Sans Numéro'} : HT ${ht}, TVA déclarée ${tva} (Taux : ${ratesStr}%). <a href="${doc.driveLink}">Lien Drive</a></li>`;
    }
    anomaliesHtml += `</ul></li>`;
  }

  if (overdueInvoices.length > 0) {
    hasAnomalies = true;
    anomaliesHtml += `<li style="margin-top: 10px;"><strong>Factures en retard de paiement (${overdueInvoices.length}) :</strong><ul>`;
    for (const doc of overdueInvoices) {
      const ttc = formatCentsToFrench(doc.totalTtc);
      const formattedDueDate = doc.dueDate.split('-').reverse().join('/');
      anomaliesHtml += `<li>${doc.supplierName || 'Fournisseur'} : ${ttc} (Échéance dépassée le ${formattedDueDate}). <a href="${doc.driveLink}">Lien Drive</a></li>`;
    }
    anomaliesHtml += `</ul></li>`;
  }

  if (duplicates.length > 0) {
    hasAnomalies = true;
    anomaliesHtml += `<li style="margin-top: 10px;"><strong>Doublons ignorés (${duplicates.length}) :</strong><ul>`;
    for (const doc of duplicates) {
      anomaliesHtml += `<li>Fichier ${doc.fileName} de ${doc.supplierName || 'Inconnu'} (${formatCentsToFrench(doc.totalTtc)}).</li>`;
    }
    anomaliesHtml += `</ul></li>`;
  }

  if (pendingDocs.length > 0) {
    hasAnomalies = true;
    anomaliesHtml += `<li style="margin-top: 10px;"><strong>Documents en attente de validation par l'artisan (${pendingDocs.length}) :</strong><ul>`;
    for (const doc of pendingDocs) {
      anomaliesHtml += `<li>Fichier ${doc.fileName} (${doc.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}).</li>`;
    }
    anomaliesHtml += `</ul></li>`;
  }

  if (!hasAnomalies) {
    anomaliesHtml += `<li>Aucune anomalie détectée pour ce mois-ci.</li>`;
  }

  anomaliesHtml += `</ul>`;
  html += anomaliesHtml;

  // Documents list
  html += `<h3 style="color: #34495e; margin-top: 20px;">3. Liste détaillée des documents</h3>`;
  html += `<ul style="padding-left: 20px;">`;
  for (const doc of docs) {
    if (doc.status !== 'filed' && doc.status !== 'anomaly') continue;
    const ttc = formatCentsToFrench(doc.totalTtc);
    const docDate = doc.docDate ? doc.docDate.split('-').reverse().join('/') : 'Inconnue';
    html += `<li style="margin-bottom: 5px;">${docDate} - <strong>${doc.supplierName || 'Fournisseur'}</strong> - ${CATEGORY_NAMES[doc.docType || 'other']} : ${doc.totalTtc !== null ? ttc : 'N/A'} (<a href="${doc.driveLink}">Lien Drive</a>)</li>`;
  }
  html += `</ul>`;

  html += `
      <p style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; font-size: 0.9em; color: #7f8c8d;">
        Cet email a été généré automatiquement par l'assistant comptable Klerk.
      </p>
    </div>
  `;

  // 7. Generate CSV content (Flow C columns layout: doc_date | ingested_at | channel | doc_type | supplier | chantier | ht | tva | ttc | due_date | drive_link | status | min_confidence | doc_id)
  const csvHeaders = 'doc_date,ingested_at,channel,doc_type,supplier,chantier,ht,tva,ttc,due_date,drive_link,status,min_confidence,doc_id';
  const csvRows = docs.map((doc: any) => {
    return [
      doc.docDate || '',
      doc.createdAt.toISOString ? doc.createdAt.toISOString() : doc.createdAt,
      doc.channel,
      doc.docType || '',
      `"${(doc.supplierName || '').replace(/"/g, '""')}"`,
      `"${(doc.chantierRef || '').replace(/"/g, '""')}"`,
      doc.totalHt !== null ? (doc.totalHt / 100).toFixed(2) : '',
      doc.totalVat !== null ? (doc.totalVat / 100).toFixed(2) : '',
      doc.totalTtc !== null ? (doc.totalTtc / 100).toFixed(2) : '',
      doc.dueDate || '',
      doc.driveLink || '',
      doc.status,
      doc.minConfidence !== null ? doc.minConfidence : '',
      doc.id,
    ].join(',');
  });

  const csvContent = [csvHeaders, ...csvRows].join('\n');

  // 8. Send Email via Gmail API
  const subject = `Journal Comptable et Pièces — ${monthName} ${year}`;
  const accountantEmail = config.accountant.email;
  
  console.log(`[Recap] Sending email to accountant at: ${accountantEmail}`);
  
  await googleService.sendEmail(
    accountantEmail,
    subject,
    html,
    [
      {
        filename: `journal_compta_${period}.csv`,
        content: csvContent,
        contentType: 'text/csv; charset=utf-8',
      },
    ]
  );

  console.log(`[Recap] Recap email successfully sent for period ${period}.`);
}

function getMonthNameFr(m: number): string {
  if (m >= 1 && m <= 12) {
    return MONTHS_FR[m - 1];
  }
  return '';
}

// --- CLI Execution Code ---
if (require.main === module) {
  // If run from command line directly, e.g. "ts-node trigger_recap.ts 2026-06"
  const args = process.argv.slice(2);
  const period = args[0];

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    console.error('Erreur: Veuillez spécifier une période au format YYYY-MM. Exemple: npm run manual-recap 2026-06');
    process.exit(1);
  }

  (async () => {
    try {
      console.log(`[Manual Trigger] Triggering monthly recap for period: ${period}...`);
      await generateMonthlyRecap(period);
      console.log('[Manual Trigger] Completed successfully.');
      process.exit(0);
    } catch (err: any) {
      console.error('[Manual Trigger] Failed:', err.message || err);
      process.exit(1);
    }
  })();
}
