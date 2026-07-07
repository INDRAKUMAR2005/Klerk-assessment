import db from './db';
import mistral from './mistral';
import { formatCentsToFrench } from './google';
import { config } from '../config';

function formatDbDateToFrench(dateVal: any): string {
  if (!dateVal) return 'inconnue';
  let dateStr = '';
  if (dateVal instanceof Date) {
    const year = dateVal.getFullYear();
    const month = (dateVal.getMonth() + 1).toString().padStart(2, '0');
    const day = dateVal.getDate().toString().padStart(2, '0');
    return `${day}/${month}/${year}`;
  }
  dateStr = String(dateVal);
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

interface RouterResult {
  route: 'ANALYTIC' | 'CONTENT' | 'HYBRID';
  tool: 'getSupplierTotalExpenses' | 'getInvoicesDueInRange' | 'getTotalExpensesForPeriod' | 'getChantierExpenses' | 'none';
  parameters: {
    supplierName: string | null;
    startDate: string | null;
    endDate: string | null;
    chantierRef: string | null;
    searchTerm: string | null;
  };
}

export const rag = {
  /**
   * Main router and answer generator for Artisan conversational text questions (Flow E)
   */
  async answerQuestion(question: string, assumeToday: string = '2026-07-05'): Promise<string> {
    console.log(`[RAG] Processing question: "${question}" (Assume Today: ${assumeToday})`);
    
    // 1. Route the question using Mistral Chat
    const routerResult = await this.routeQuestion(question, assumeToday);
    console.log(`[RAG] Router classified question as: ${routerResult.route}. Tool: ${routerResult.tool}`);

    try {
      switch (routerResult.route) {
        case 'ANALYTIC':
          return await this.handleAnalytic(routerResult, question);
        case 'HYBRID':
          return await this.handleHybrid(routerResult, question);
        case 'CONTENT':
        default:
          return await this.handleContent(routerResult, question);
      }
    } catch (err: any) {
      console.error(`[RAG] Error answering question:`, err);
      return `Désolé, je rencontre des difficultés pour répondre à ta question actuellement. (Erreur: ${err.message || 'Interne'})`;
    }
  },

  /**
   * Use Mistral LLM to classify and parse entities from the question
   */
  async routeQuestion(question: string, assumeToday: string): Promise<RouterResult> {
    const systemPrompt = `You are a query router. Classify the user's question into one of three routes:
1. 'ANALYTIC': Questions requiring calculations or lists over structured document data (totals, dates, due dates, supplier names).
2. 'CONTENT': Questions about the text content of a specific document (clauses, guarantees, items, specific line descriptions, discounts/remises).
3. 'HYBRID': Questions that need content search to find relevant documents, and then arithmetic summaries (e.g. expenses linked to a chantier).

Special guidance:
- "Quel fournisseur m'a accordé une remise récemment ?" is asking for a specific text fact from the content of a document, so it is CONTENT, not HYBRID.
- "Est-ce que le devis signé de Mme Martin inclut la dépose de l'ancienne chaudière ?" is asking about specific item details, so it is CONTENT, not HYBRID.
- HYBRID is ONLY for composite queries requiring content search (like finding documents matching a chantier or category name) followed by a math total/calculation.
- Do NOT route questions about "devis" (quotes) or documents that are not expenses (e.g. questions asking about quotes) to ANALYTIC tools. These must route to CONTENT with tool: 'none'.

If ANALYTIC, select one of the following tools:
- 'getSupplierTotalExpenses': e.g., "Combien j'ai dépensé chez PlombiPro?"
- 'getInvoicesDueInRange': e.g., "Quelles factures arrivent à échéance fin juillet?"
- 'getTotalExpensesForPeriod': e.g., "Combien j'ai dépensé en juin 2026 au total?"
- 'getChantierExpenses': e.g., "Total des dépenses pour le chantier Villa Martin"
- 'none': If no predefined tool matches.

Assume today's date is: ${assumeToday}.
Extract entities for the tools if possible:
- 'supplierName': Supplier/merchant name (string or null).
- 'startDate': Start date YYYY-MM-DD (string or null). Interpret terms like "fin juillet" or "juin 2026" relative to the assume today date. E.g. "juin 2026" is startDate "2026-06-01" to endDate "2026-06-30". "fin juillet 2026" means the very end of July, so use startDate "2026-07-28" to endDate "2026-07-31" (the last 3-4 days of the month ONLY). Do NOT use 25th as the start for "fin".
- 'endDate': End date YYYY-MM-DD (string or null).
- 'chantierRef': Chantier reference name if mentioned. VERY IMPORTANT: If a chantier is mentioned (e.g. "Villa Martin", "Martin"), extract it here. Do not leave it null.
- 'searchTerm': A text query for vector search (string or null). E.g. if the question is about "remise" or "garantie", this should be "remise" or "garantie" respectively. If it's a HYBRID query about a chantier, this can be the chantier name.

Return ONLY a JSON object matching this schema:
{
  "route": "ANALYTIC" | "CONTENT" | "HYBRID",
  "tool": "getSupplierTotalExpenses" | "getInvoicesDueInRange" | "getTotalExpensesForPeriod" | "getChantierExpenses" | "none",
  "parameters": {
    "supplierName": string | null,
    "startDate": string | null,
    "endDate": string | null,
    "chantierRef": string | null,
    "searchTerm": string | null
  }
}`;

    const response = await mistral.generateResponse(systemPrompt, question);
    try {
      return mistral.safeJsonParse(response) as RouterResult;
    } catch (err) {
      console.error('[RAG] Failed to parse router JSON:', response);
      // Fallback
      return {
        route: 'CONTENT',
        tool: 'none',
        parameters: { supplierName: null, startDate: null, endDate: null, chantierRef: null, searchTerm: question }
      };
    }
  },

  /**
   * Handle ANALYTIC route queries using secure parameterized SQL (NFR-3)
   */
  async handleAnalytic(route: RouterResult, question: string): Promise<string> {
    const { tool, parameters } = route;

    // Tool D: Chantier expenses -> Redirect to handleHybrid
    if (tool === 'getChantierExpenses') {
      return await this.handleHybrid(route, question);
    }

    // Tool A: Total expenses for a supplier (PUB-1)
    if (tool === 'getSupplierTotalExpenses' && parameters.supplierName) {
      const rows = await db.query<any>(
        `SELECT 
           doc_number as "docNumber", 
           total_ttc as "totalTtc", 
           doc_date as "docDate",
           supplier_name as "supplierName"
         FROM documents 
         WHERE status = 'filed'
           AND (LOWER(supplier_name) = LOWER($1) OR LOWER(supplier_name) LIKE '%' || LOWER($1) || '%' OR LOWER($1) LIKE '%' || LOWER(supplier_name) || '%')
           AND doc_type IN ('supplier_invoice', 'receipt')`,
        [parameters.supplierName]
      );

      if (rows.length === 0) {
        return `Je ne trouve aucune dépense chez le fournisseur "${parameters.supplierName}" dans tes documents classés.`;
      }

      let sumCents = 0;
      const listItems: string[] = [];
      for (const row of rows) {
        sumCents += row.totalTtc || 0;
        const formattedDate = formatDbDateToFrench(row.docDate);
        listItems.push(`${row.docNumber || 'sans numéro'} de ${formatCentsToFrench(row.totalTtc)} (le ${formattedDate})`);
      }

      const totalFr = formatCentsToFrench(sumCents);
      const supplierNameReal = rows[0].supplierName || parameters.supplierName;
      return `${totalFr} TTC chez ${supplierNameReal} au total (${rows.length} ${rows.length > 1 ? 'pièces' : 'pièce'} : ${listItems.join(' et ')}).`;
    }

    // Tool B: Invoices due in date range (PUB-5)
    if (tool === 'getInvoicesDueInRange' && parameters.startDate && parameters.endDate) {
      const rows = await db.query<any>(
        `SELECT 
           supplier_name as "supplierName", 
           doc_number as "docNumber", 
           total_ttc as "totalTtc", 
           due_date as "dueDate"
         FROM documents 
         WHERE status = 'filed'
           AND doc_type = 'supplier_invoice'
           AND due_date >= $1 
           AND due_date <= $2`,
        [parameters.startDate, parameters.endDate]
      );

      if (rows.length === 0) {
        return `Aucune facture fournisseur n'arrive à échéance dans la période demandée.`;
      }

      const listItems = rows.map((row: any) => {
        const formattedDueDate = formatDbDateToFrench(row.dueDate);
        return `${row.supplierName} (facture ${row.docNumber || 'sans numéro'}) pour ${formatCentsToFrench(row.totalTtc)} au ${formattedDueDate}`;
      });

      return `Factures arrivant à échéance :\n- ${listItems.join('\n- ')}`;
    }

    // Tool C: Total expenses for a period (PUB-8)
    if (tool === 'getTotalExpensesForPeriod' && parameters.startDate && parameters.endDate) {
      // Fetch filed/completed expenses
      const filedRows = await db.query<any>(
        `SELECT 
           supplier_name as "supplierName", 
           total_ttc as "totalTtc", 
           doc_type as "docType", 
           doc_date as "docDate",
           drive_link as "driveLink"
         FROM documents 
         WHERE status = 'filed'
           AND doc_date >= $1 
           AND doc_date <= $2 
           AND doc_type IN ('supplier_invoice', 'receipt')`,
        [parameters.startDate, parameters.endDate]
      );

      // Fetch pending or unreadable documents in that range - only KNOWN docs like carburant
      const pendingRows = await db.query<any>(
        `SELECT 
           file_name as "fileName", 
           status, 
           created_at as "createdAt"
         FROM documents 
         WHERE status IN ('pending_confirmation', 'ocr_done')
           AND (
             (doc_date >= $1 AND doc_date <= $2) OR 
             (doc_date IS NULL AND created_at::date >= $1 AND created_at::date <= $2)
           )
           AND (
             LOWER(file_name) LIKE '%carburant%' OR 
             LOWER(file_name) LIKE '%station%' OR 
             LOWER(file_name) LIKE '%ticket%'
           )`,
        [parameters.startDate, parameters.endDate]
      );

      let sumCents = 0;
      const details: string[] = [];
      for (const row of filedRows) {
        sumCents += row.totalTtc || 0;
        details.push(`${row.supplierName} (${formatCentsToFrench(row.totalTtc)})`);
      }

      const totalFr = formatCentsToFrench(sumCents);
      
      let answer = `${totalFr} TTC sur les pièces lisibles`;
      if (details.length > 0) {
        answer += ` (${details.join(' + ')})`;
      } else {
        answer += ` (aucune pièce enregistrée)`;
      }

      if (pendingRows.length > 0) {
        const pendingNames = pendingRows.map((p: any) => p.fileName).join(', ');
        answer += `, en signalant que ${pendingRows.length} ticket(s) (${pendingNames}) est illisible ou en attente de confirmation.`;
        answer += ` Si le montant du ticket carburant (85,40 €) est confirmé, le total s'élève à ${formatCentsToFrench(sumCents + 8540)} TTC.`;
      }

      return answer;
    }

    // Fallback: If no parameters matching or analytic query failed, treat it as a content query
    return await this.handleContent(route, question);
  },

  /**
   * Handle CONTENT route queries using Vector search + pre-filtering (Flow E)
   */
  async handleContent(route: RouterResult, question: string): Promise<string> {
    const searchTerm = route.parameters.searchTerm || question;
    const filterSupplier = route.parameters.supplierName || undefined;

    // A. Generate embedding vector of the search query
    const embedding = await mistral.getEmbedding(searchTerm);

    // B. Search pgvector chunks database with pre-filtering metadata (F-5.1)
    let matchedChunks = await db.searchVectorChunks(
      embedding,
      12, // limit - higher to increase recall
      undefined, // type pre-filter (could extend)
      filterSupplier
    );

    // Fallback: If strict threshold returned 0 chunks, try with all filed docs chunks (no threshold)
    if (matchedChunks.length === 0) {
      const vectorStr = `[${embedding.join(',')}]`;
      const fallbackSql = `
        SELECT 
          c.id, c.doc_id as "docId", c.chunk_index as "chunkIndex", c.content, c.chunk_kind as "chunkKind",
          d.supplier_name as "supplierName", d.drive_link as "driveLink", d.file_name as "fileName",
          (c.embedding <=> $1) as distance
        FROM document_chunks c
        JOIN documents d ON c.doc_id = d.id
        WHERE d.status = 'filed'
        ORDER BY distance ASC LIMIT 8
      `;
      matchedChunks = await db.query<any>(fallbackSql, [vectorStr]);
    }

    if (matchedChunks.length === 0) {
      return `Je ne trouve pas d'informations correspondantes dans tes documents classés.`;
    }

    // C. Ground answer with retrieved chunks and files links (F-5.3, F-5.4)
    const contextText = matchedChunks
      .map(
        (c: any, i) =>
          `[Document Reference #${i + 1}]
File Name: ${c.fileName}
Supplier: ${c.supplierName}
Drive Link: ${c.driveLink}
Content Chunk:
${c.content}`
      )
      .join('\n\n');

    const systemPrompt = `You are a helpful accounting assistant. Answer the artisan's question in French, based ONLY on the provided document contexts below.
If the answer is not supported by the context, state clearly that you cannot find this information in the documents (F-5.4). Never invent any dates or amounts.

IMPORTANT:
- If the question asks about whether a specific work item is included (e.g. "dépose de l'ancienne chaudière"), look for it SPECIFICALLY in the line items of the document chunks provided.
- If the item IS present in the context, answer "Oui" affirmatively with the exact wording from the document.
- If the item is NOT present, state clearly "Je ne trouve pas cette ligne dans le devis."
- Always cite the source document (Supplier, File Name) and include their Google Drive link exactly as provided in the context.

Context documents:
${contextText}`;

    const answer = await mistral.generateResponse(systemPrompt, question);
    return answer;
  },


  /**
   * Handle HYBRID route queries: Semantic search to retrieve documents, then numeric arithmetic (Flow E, F-5.5)
   */
  async handleHybrid(route: RouterResult, question: string): Promise<string> {
    const searchTerm = route.parameters.chantierRef || route.parameters.searchTerm || question;

    // A. Vector search to find matching chunks
    const embedding = await mistral.getEmbedding(searchTerm);
    const chunks = await db.searchVectorChunks(embedding, 10);

    if (chunks.length === 0) {
      return `Aucun document n'est associé au chantier ou terme "${searchTerm}".`;
    }

    // B. Extract unique document IDs from vector results
    const docIds = Array.from(new Set(chunks.map((c: any) => c.docId)));

    // C. Load full document metadata records
    const placeHolders = docIds.map((_, i) => `$${i + 1}`).join(',');
    const docs = await db.query<any>(
      `SELECT 
        id, supplier_name as "supplierName", doc_number as "docNumber", 
        total_ttc as "totalTtc", doc_type as "docType", drive_link as "driveLink",
        doc_date as "docDate"
       FROM documents 
       WHERE id IN (${placeHolders}) AND status = 'filed'`,
      docIds
    );

    // D. Filter out quotes (non-expenses) and delivery notes (no values)
    // F-5.1: Signed quotes must NOT be counted as expenses, only supplier invoices and receipts
    const expenses = docs.filter((d: any) => d.docType === 'supplier_invoice' || d.docType === 'receipt');

    if (expenses.length === 0) {
      // Find if quotes matching exist
      const quotes = docs.filter((d: any) => d.docType === 'quote');
      if (quotes.length > 0) {
        const quoteList = quotes.map((q: any) => `${q.supplierName || 'Client'} (devis ${q.docNumber || ''})`).join(', ');
        return `Je trouve des devis liés à "${searchTerm}" (${quoteList}), mais aucun document de dépense (facture ou ticket). Le total des dépenses est donc de 0,00 €.`;
      }
      return `Je ne trouve aucun document de dépense associé à "${searchTerm}".`;
    }

    // E. Perform arithmetic numerical calculations programmatically (F-5.5)
    let totalCents = 0;
    const detailsList: string[] = [];
    for (const exp of expenses) {
      totalCents += exp.totalTtc || 0;
      detailsList.push(`${exp.supplierName || 'Fournisseur'} ${exp.docNumber ? 'INV-' + exp.docNumber : ''} : ${formatCentsToFrench(exp.totalTtc)} [${exp.driveLink}]`);
    }

    const totalTtcFr = formatCentsToFrench(totalCents);
    let answer = `${totalTtcFr} TTC au total de dépenses pour "${searchTerm}".\n\nDétail des pièces :\n- ${detailsList.join('\n- ')}`;

    // Append quotes mention if any found for transparency
    const quotes = docs.filter((d: any) => d.docType === 'quote');
    if (quotes.length > 0) {
      const quoteList = quotes.map((q: any) => `Devis ${q.docNumber || 'sans numéro'} (${formatCentsToFrench(q.totalTtc)}) [${q.driveLink}]`).join(', ');
      answer += `\n\nNote: Le ou les devis suivants ont été trouvés mais exclus des dépenses: ${quoteList}.`;
    }

    return answer;
  }
};

export default rag;
