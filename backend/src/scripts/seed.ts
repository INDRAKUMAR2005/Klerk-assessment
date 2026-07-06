import fs from 'fs';
import path from 'path';
import db from '../services/db';
import googleService from '../services/google';

async function seed() {
  try {
    console.log('[Seed] Reading migration.sql...');
    const sqlPath = path.join(__dirname, 'migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('[Seed] Executing SQL migrations on database...');
    // Execute SQL script
    await db.query(sql);
    console.log('[Seed] Database tables, enums, indexes and pgvector configured successfully.');

    // Pre-create Gmail labels
    try {
      console.log('[Seed] Pre-creating required Gmail labels...');
      await googleService.getOrCreateLabel('Klerk/Processed');
      await googleService.getOrCreateLabel('Klerk/Ignored');
      console.log('[Seed] Gmail labels "Klerk/Processed" and "Klerk/Ignored" are set up.');
    } catch (googleErr: any) {
      console.warn('[Seed Warning] Google credentials not fully configured yet. Skipping Gmail label pre-creation.', googleErr.message);
    }

    console.log('[Seed] Database and environment seeding completed successfully.');
    process.exit(0);
  } catch (err: any) {
    console.error('[Seed Error] Migration seeding failed:', err.message || err);
    process.exit(1);
  }
}

seed();
