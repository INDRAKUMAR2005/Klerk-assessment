import axios from 'axios';
import { config } from '../config';

export const unipile = {
  /**
   * Send a WhatsApp message to a specific chat (e.g. Julien's chat)
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      // Build form-data using native Node.js FormData (available globally in Node 18+)
      const formData = new FormData();
      formData.append('text', text);

      const url = `${config.unipile.apiUrl}/api/v1/chats/${chatId}/messages`;
      
      const response = await axios.post(url, formData, {
        headers: {
          'X-API-KEY': config.unipile.apiKey,
          'accept': 'application/json',
          // axios automatically sets boundary for FormData when passed as request body
        },
      });

      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`Unipile returned status ${response.status}`);
      }
    } catch (error: any) {
      console.error('[Unipile Service] Failed to send message:', error?.response?.data || error.message);
      throw error;
    }
  },

  /**
   * Download message attachment binary
   */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<{ data: Buffer; fileName: string; mimeType: string }> {
    try {
      const url = `${config.unipile.apiUrl}/api/v1/messages/${messageId}/attachments/${attachmentId}`;
      
      const response = await axios.get(url, {
        headers: {
          'X-API-KEY': config.unipile.apiKey,
        },
        responseType: 'arraybuffer',
      });

      // Extract filename and mime type from headers if possible
      const contentDisposition = response.headers['content-disposition'];
      let fileName = `attachment_${attachmentId}`;
      if (contentDisposition) {
        const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(contentDisposition);
        if (matches && matches[1]) {
          fileName = matches[1].replace(/['"]/g, '');
        }
      }

      const mimeType = (response.headers['content-type'] as string) || 'application/octet-stream';

      return {
        data: Buffer.from(response.data),
        fileName,
        mimeType,
      };
    } catch (error: any) {
      console.error('[Unipile Service] Failed to download attachment:', error?.response?.data || error.message);
      throw error;
    }
  }
};

export default unipile;
