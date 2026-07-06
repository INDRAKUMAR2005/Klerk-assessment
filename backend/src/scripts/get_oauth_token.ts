import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';
import path from 'path';

// Load client secret if available
dotenv.config({ path: path.join(__dirname, '../../.env') });

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Erreur: Veuillez renseigner GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans votre fichier .env avant de lancer ce script.');
  process.exit(1);
}

// Redirect URI configured in Google Developer Console (use standard out-of-band redirect)
const redirectUri = 'https://developers.google.com/oauthplayground';

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

// Define scopes required for Klerk
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets'
];

async function main() {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // crucial for getting refresh token
    scope: SCOPES,
    prompt: 'consent' // forces refresh token generation
  });

  console.log('\n==================================================');
  console.log('OBTENIR LE REFRESH TOKEN GOOGLE CLOUD');
  console.log('==================================================');
  console.log('1. Copiez et ouvrez cette URL dans votre navigateur :\n');
  console.log(authUrl);
  console.log('\n2. Connectez-vous avec votre compte Gmail de test Klerk.');
  console.log('3. Après autorisation, vous serez redirigé vers l\'OAuth Playground.');
  console.log('4. Copiez le paramètre "code" situé dans l\'URL de votre navigateur.');
  console.log('   (ex: https://developers.google.com/oauthplayground/?code=4/0AdGGJW...)');
  console.log('==================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Collez le code d\'autorisation ici: ', async (code) => {
    rl.close();
    try {
      console.log('\nÉchange du code contre les tokens...');
      const { tokens } = await oauth2Client.getToken(code.trim());
      
      console.log('\n==================================================');
      console.log('SUCCÈS ! REFRESH TOKEN OBTENU :');
      console.log('==================================================');
      console.log(tokens.refresh_token);
      console.log('==================================================');
      console.log('Copiez cette clé dans votre fichier .env sous: GOOGLE_REFRESH_TOKEN\n');
      process.exit(0);
    } catch (err: any) {
      console.error('\nErreur lors de l\'échange du code:', err.message || err);
      process.exit(1);
    }
  });
}

main();
