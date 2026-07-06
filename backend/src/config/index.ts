import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY || '',
    model: process.env.MISTRAL_CHAT_MODEL || 'mistral-large-latest',
    embeddingModel: process.env.MISTRAL_EMBEDDING_MODEL || 'mistral-embed',
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    dbUrl: process.env.DATABASE_URL || '', // Direct PG connection string
  },
  unipile: {
    apiKey: process.env.UNIPILE_API_KEY || '',
    apiUrl: process.env.UNIPILE_API_URL || '',
    artisanWhatsappId: process.env.ARTISAN_WHATSAPP_ID || '', // Julien's WhatsApp ID
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
  },
  accountant: {
    email: process.env.ACCOUNTANT_EMAIL || 'accountant@example.com',
  },
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.75'),
  env: process.env.NODE_ENV || 'development',
};

// Check for required configuration (skip check in test environment if needed, but alert in dev)
export function validateConfig() {
  const missing: string[] = [];
  if (!config.mistral.apiKey) missing.push('MISTRAL_API_KEY');
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.supabase.dbUrl) missing.push('DATABASE_URL');
  if (!config.unipile.apiKey) missing.push('UNIPILE_API_KEY');
  if (!config.unipile.apiUrl) missing.push('UNIPILE_API_URL');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');

  if (missing.length > 0) {
    console.warn(`[Config Warning] Missing required environment variables: ${missing.join(', ')}`);
  }
}
