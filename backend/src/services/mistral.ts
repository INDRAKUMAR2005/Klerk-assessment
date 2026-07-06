import axios from 'axios';
import { config } from '../config';
import { DocType, ExtractedMetadata, ConfidenceScores } from '../models/types';

// Helper for sleeping (for retries)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an API call with exponential backoff and jitter for 429/5xx errors (NFR-2)
 */
async function callWithRetry<T>(fn: () => Promise<T>, retries = 10, baseDelay = 1000): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      const status = error?.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if (attempt >= retries || (!isRateLimit && !isServerError)) {
        console.error(`[Mistral Service] Call failed after ${attempt} attempts. Status: ${status}`);
        throw error;
      }

      // Calculate delay: for rate limit, wait 15 seconds per attempt to allow quota reset.
      // Otherwise, use exponential backoff: baseDelay * 2^(attempt-1) + random jitter (0-1000ms)
      const delay = isRateLimit 
        ? 15000 * attempt 
        : baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;

      console.warn(
        `[Mistral Service] Rate limit or server error (${status}) encountered. Retrying attempt ${attempt}/${retries} in ${Math.round(
          delay
        )}ms...`
      );
      await sleep(delay);
    }
  }
}

export const mistral = {
  /**
   * Run OCR on a document using the Mistral OCR API
   */
  async ocrDocument(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    const base64Data = fileBuffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    
    // Determine type: images are image_url, PDFs or other files are document_url
    const isImage = mimeType.startsWith('image/');
    const docPayload = isImage
      ? { type: 'image_url', image_url: dataUri }
      : { type: 'document_url', document_url: dataUri };

    const payload = {
      model: 'mistral-ocr-latest',
      document: docPayload,
      include_image_base64: false,
    };

    return callWithRetry(async () => {
      const response = await axios.post(
        'https://api.mistral.ai/v1/ocr',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.mistral.apiKey}`,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      const pages = response.data?.pages || [];
      if (pages.length === 0) {
        throw new Error('Mistral OCR returned zero pages.');
      }

      // Concatenate markdown content from all pages
      return pages.map((page: any) => page.markdown).join('\n\n');
    });
  },

  /**
   * Generate text embedding vector (dimension = 1024)
   */
  async getEmbedding(text: string): Promise<number[]> {
    const payload = {
      model: config.mistral.embeddingModel,
      input: [text],
    };

    return callWithRetry(async () => {
      const response = await axios.post(
        'https://api.mistral.ai/v1/embeddings',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.mistral.apiKey}`,
          },
        }
      );

      const embedding = response.data?.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error('Mistral embedding request failed to return vector.');
      }
      return embedding;
    });
  },

  /**
   * Classify a document type from its raw OCR text
   */
  async classifyDocumentType(ocrText: string): Promise<DocType> {
    const systemPrompt = `You are an expert system. Classify the following document OCR content into one of these types:
- 'supplier_invoice': A bill or invoice from a supplier for items purchased. Look for keywords like "Facture", "Invoice", "FA-", "INV-", "Due Date", "A payer".
- 'receipt': A sales receipt or cash ticket, usually from a retail store or fuel station. Look for "Ticket de caisse", "Cash Receipt", "Ticket carburant", "Supermarché".
- 'quote': A quotation or proposal sent to a client. Look for "Devis", "Proposition", "Estimation", "Quote", "Bon pour accord".
- 'delivery_note': A document listing delivered items. Look for "Bon de livraison", "Delivery Note", "BL-", "Livraison".
- 'other': If it does not fit the above category.

Return ONLY a JSON object with a single key "docType" containing one of the 5 strings.`;

    const payload = {
      model: config.mistral.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: ocrText.slice(0, 15000) }, // Limit input context
      ],
      response_format: { type: 'json_object' },
    };

    return callWithRetry(async () => {
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

      const jsonStr = response.data?.choices?.[0]?.message?.content;
      const parsed = this.safeJsonParse(jsonStr);
      const type = parsed.docType as DocType;
      
      const validTypes: DocType[] = ['supplier_invoice', 'receipt', 'quote', 'delivery_note', 'other'];
      return validTypes.includes(type) ? type : 'other';
    });
  },

  /**
   * Extract structured metadata and confidence scores from raw OCR content
   */
  async extractMetadata(
    ocrText: string,
    docType: DocType
  ): Promise<{
    extracted: ExtractedMetadata;
    confidence: ConfidenceScores;
    minConfidence: number;
    vatAnomaly: boolean;
  }> {
    const systemPrompt = `You are an expert document parser. Extract structured details from the following French financial document OCR text.
The document type is classified as: ${docType}.

You must return a JSON object containing the following keys:
1. "supplierName": Name of the supplier/merchant (string or null).
2. "supplierSirenVat": SIREN/SIRET number or VAT registration number of the supplier if present (string or null).
3. "docNumber": Invoice number, receipt number, quote number, or delivery note number if present (string or null).
4. "docDate": Date of the document in YYYY-MM-DD format (string or null). Parse French dates (e.g. "12 juin 2026" or "12/06/2026" or "2026-06-12").
5. "dueDate": Due date of payment in YYYY-MM-DD format. Required for supplier_invoice if written. If not present, default to null.
6. "totalHt": Total amount before taxes (HT) in EUR cents (integer or null, e.g. 100.50 € HT = 10050).
7. "totalVat": Total VAT amount in EUR cents (integer or null, e.g. 20.10 € TVA = 2010).
8. "totalTtc": Total amount including taxes (TTC) in EUR cents (integer or null, e.g. 120.60 € TTC = 12060).
9. "chantierRef": French job-site / project reference if present (e.g. "Chantier Villa Martin" or "Villa Martin", look for keywords like "chantier", "ref:", "adresse:", "job-site") (string or null).
10. "vatRates": An array of numbers listing the VAT rates applicable (e.g., [20, 5.5]). Empty array if none.
11. "lineItems": An array of objects representing line items, each with:
    - "label": Description/name of the item (string).
    - "qty": Quantity (number or null).
    - "unitPrice": Unit price in EUR cents (integer or null).
    - "totalPrice": Total price in EUR cents (integer or null).
12. "confidenceScores": A JSON object estimating your extraction confidence (between 0.00 and 1.00) for these critical fields:
    - "docType": Confidence of classification.
    - "supplierName": Confidence of supplierName.
    - "totalTtc": Confidence of totalTtc.
    - "docDate": Confidence of docDate.
    - "dueDate": Confidence of dueDate (set to 1.0 if there is no due date needed or present).

Guidelines:
- All financial amounts must be converted from French float formatting (e.g., "1 246,80 €") to integer cents.
- Do NOT invent or make up any fields. If a field is not printed or is completely unreadable, return null.
- CRITICAL: Never multiply quantities or calculate total amounts yourself if they are NOT written on the receipt. If the total TTC is not explicitly printed in the text (e.g. only lists quantity and unit price but no final sum), you MUST set "totalTtc" to null, and set the "totalTtc" confidence score to 0.0.
- For confidenceScores, reflect how readable and clear the text is. If it is blurry, faded, or absent, give a low score (< 0.70). If it is perfectly clear, give >= 0.90.`;

    const payload = {
      model: config.mistral.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: ocrText.slice(0, 15000) },
      ],
      response_format: { type: 'json_object' },
    };

    return callWithRetry(async () => {
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

      const jsonStr = response.data?.choices?.[0]?.message?.content;
      const parsed = this.safeJsonParse(jsonStr);

      const extracted: ExtractedMetadata = {
        docType: docType,
        supplierName: parsed.supplierName || null,
        supplierSirenVat: parsed.supplierSirenVat || null,
        docNumber: parsed.docNumber || null,
        docDate: parsed.docDate || null,
        dueDate: parsed.dueDate || null,
        totalHt: parsed.totalHt !== undefined ? parsed.totalHt : null,
        totalVat: parsed.totalVat !== undefined ? parsed.totalVat : null,
        totalTtc: parsed.totalTtc !== undefined ? parsed.totalTtc : null,
        chantierRef: parsed.chantierRef || null,
        vatRates: parsed.vatRates || [],
        lineItems: parsed.lineItems || [],
      };

      const confidence: ConfidenceScores = parsed.confidenceScores || {};
      
      // Calculate minimum confidence across key fields
      const keyFields: (keyof ConfidenceScores)[] = ['docType', 'supplierName', 'totalTtc', 'docDate'];
      if (docType === 'supplier_invoice' && extracted.dueDate) {
        keyFields.push('dueDate');
      }

      let minConfidence = 1.0;
      for (const field of keyFields) {
        const val = confidence[field];
        if (val !== undefined && val < minConfidence) {
          minConfidence = val;
        }
      }

      // VAT anomaly sanity check: F-3.4
      // |HT * rate - VAT| > 0.05 EUR (5 cents)
      let vatAnomaly = false;
      if (
        extracted.totalHt !== null &&
        extracted.totalVat !== null &&
        extracted.vatRates.length > 0
      ) {
        // Use the first rate or check if any rate matches
        const mainRate = extracted.vatRates[0] / 100; // e.g. 20% -> 0.20
        const expectedVat = Math.round(extracted.totalHt * mainRate);
        if (Math.abs(expectedVat - extracted.totalVat) > 5) {
          vatAnomaly = true;
        }
      }

      return {
        extracted,
        confidence,
        minConfidence,
        vatAnomaly,
      };
    });
  },

  /**
   * Direct prompt response for RAG or analytics queries
   */
  async generateResponse(systemPrompt: string, userMessage: string): Promise<string> {
    const payload = {
      model: config.mistral.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    };

    return callWithRetry(async () => {
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
    });
  },

  /**
   * Safely parse JSON returned by LLM, removing markdown code blocks if necessary
   */
  safeJsonParse(str: string): any {
    if (!str) {
      throw new Error("Empty input to safeJsonParse");
    }
    
    let cleaned = str.trim();
    
    // Remove markdown code blocks if present
    const codeBlockRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
    const match = cleaned.match(codeBlockRegex);
    if (match) {
      cleaned = match[1].trim();
    }
    
    // Fallback: extract first '{' to last '}'
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      } else {
        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
          cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        }
      }
    }

    return JSON.parse(cleaned);
  }
};
export default mistral;
