import axios from 'axios';
import { config } from '../config';

export const unipile = {
  /**
   * Send a WhatsApp message to a specific chat or phone JID (Flow A/B/C replies)
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      let targetChatId = chatId;

      // If chatId looks like a phone JID (e.g. contains @), resolve the actual Unipile chat ID or start a new chat
      if (chatId.includes('@')) {
        const resolvedId = await this.resolveChatId(chatId, text);
        if (resolvedId) {
          if (resolvedId === 'SENT_CREATION') {
            // Message was already sent during chat creation/initiation
            return;
          }
          targetChatId = resolvedId;
        }
      }

      const formData = new FormData();
      formData.append('text', text);

      const url = `${config.unipile.apiUrl}/api/v1/chats/${targetChatId}/messages`;
      
      const response = await axios.post(url, formData, {
        headers: {
          'X-API-KEY': config.unipile.apiKey,
          'accept': 'application/json',
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
   * Resolve a Unipile chat ID from a phone number JID. Initiates a chat if one does not exist.
   */
  async resolveChatId(jid: string, initialText?: string): Promise<string | null> {
    try {
      // 1. Fetch connected WhatsApp accounts to get the account ID
      const accountsUrl = `${config.unipile.apiUrl}/api/v1/accounts`;
      const accountsRes = await axios.get(accountsUrl, {
        headers: { 'X-API-KEY': config.unipile.apiKey, 'accept': 'application/json' },
      });
      const whatsappAccount = (accountsRes.data?.items || []).find((acc: any) => acc.type === 'WHATSAPP');
      if (!whatsappAccount) {
        console.warn('[Unipile Service] No connected WhatsApp account found.');
        return null;
      }
      const accountId = whatsappAccount.id;

      // Normalize JID format to compare digits
      const normalizeJid = (j: string) => j.replace(/[^0-9]/g, '').trim();
      const targetNorm = normalizeJid(jid);

      // 2. Fetch recent chats to check if we already have an active conversation
      const chatsUrl = `${config.unipile.apiUrl}/api/v1/chats?limit=50`;
      const chatsRes = await axios.get(chatsUrl, {
        headers: { 'X-API-KEY': config.unipile.apiKey, 'accept': 'application/json' },
      });
      const chats = chatsRes.data?.items || [];
      const existingChat = chats.find((c: any) => {
        const pId = c.provider_id || '';
        const appI = c.attendee_public_identifier || '';
        return (pId && normalizeJid(pId) === targetNorm) || (appI && normalizeJid(appI) === targetNorm);
      });

      if (existingChat) {
        console.log(`[Unipile Service] Resolved existing chat ID: ${existingChat.id} for JID: ${jid}`);
        return existingChat.id;
      }

      // 3. No existing chat found: create a new one using POST /chats
      console.log(`[Unipile Service] Creating new WhatsApp chat for JID: ${jid} on account: ${accountId}`);
      
      let attendeeJid = jid;
      if (!attendeeJid.includes('@')) {
        attendeeJid = `${attendeeJid}@s.whatsapp.net`;
      } else if (attendeeJid.endsWith('@c.us')) {
        attendeeJid = attendeeJid.replace(/@c\.us$/i, '@s.whatsapp.net');
      }

      const payload: any = {
        account_id: accountId,
        attendees_ids: [attendeeJid],
      };
      if (initialText) {
        payload.text = initialText;
      }

      const createChatUrl = `${config.unipile.apiUrl}/api/v1/chats`;
      const createRes = await axios.post(createChatUrl, payload, {
        headers: {
          'X-API-KEY': config.unipile.apiKey,
          'Content-Type': 'application/json',
          'accept': 'application/json',
        },
      });

      if (createRes.status === 201 || createRes.status === 200) {
        console.log(`[Unipile Service] Successfully created/started chat. ID: ${createRes.data?.id}`);
        return initialText ? 'SENT_CREATION' : createRes.data?.id;
      }

      return null;
    } catch (err: any) {
      console.error('[Unipile Service] Failed to resolve or create chat:', err?.response?.data || err.message);
      return null;
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
