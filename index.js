// FULL CODE v3 — whatsapp-web.js server hardened
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const rimraf = require('rimraf');

const app = express();
const port = 3000;

// Middleware
app.use(cors({ origin: 'https://backoff.travel4you.ma' }));
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- État global ---
let isConnected = false;
let isClientReady = false;
let isAuthenticated = false;
let lastQrCode = null;

let reconnecting = false;
let connectionTimeout = null; // watchdog de 60s post-auth
let syncInterval = null;      // interval de sync contacts
let authRecoveryTriggered = false; // éviter multiples recoveries

// --- Client WhatsApp (avec version pin) ---
const client = new Client({
  authStrategy: new LocalAuth(),
  // ⚠️ Pinner la version de WhatsApp Web réduit les bugs d'événements
  // Plus d'infos: docs de RemoteWebCache (placeholder {version})
  // https://docs.wwebjs.dev/webCache_RemoteWebCache.js.html
  webVersion: '2.2412.54', // mets ici une version stable qui marche chez toi
  webVersionCache: {
    type: 'remote',
    // Le placeholder {version} sera remplacé par webVersion ci-dessus
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    strict: false // si indisponible, la lib tentera la dernière connue
  },
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disk-cache-size=0'
    ]
  }
});

// --- Helpers ---
async function safeDestroy() {
  try {
    client.removeAllListeners();
    await client.destroy();
  } catch (e) {
    console.warn('Destroy error, retry in 2s:', e.message);
    await new Promise(res => setTimeout(res, 2000));
    client.removeAllListeners();
    await client.destroy();
  }
}

function resetFlags() {
  isConnected = false;
  isClientReady = false;
  isAuthenticated = false;
  lastQrCode = null;
  authRecoveryTriggered = false;
  if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// --- Événements WhatsApp ---
client.on('qr', qr => {
  console.log('QR Code reçu.');
  QRCode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Erreur QR:', err);
      lastQrCode = null;
    } else {
      lastQrCode = url;
      isConnected = false;
      isAuthenticated = false;
    }
  });
});

client.on('authenticated', () => {
  console.log('🔐 Authentifié, attente de ready...');
  isAuthenticated = true;
  authRecoveryTriggered = false;

  if (connectionTimeout) clearTimeout(connectionTimeout);
  connectionTimeout = setTimeout(async () => {
    if (!isClientReady && !authRecoveryTriggered) {
      console.warn('⚠️ Ready manquant 60s après authenticated → re-init');
      authRecoveryTriggered = true;
      await safeDestroy();
      // petite pause pour laisser Chromium se fermer proprement
      setTimeout(() => client.initialize(), 2000);
    }
  }, 60000);
});

client.on('auth_failure', msg => {
  console.error('❌ Auth échouée:', msg);
  resetFlags();
});

client.on('disconnected', reason => {
  console.log('⚠️ Déconnecté:', reason);
  resetFlags();

  if (!reconnecting) {
    reconnecting = true;
    setTimeout(() => {
      console.log('♻️ Ré-initialisation du client…');
      client.initialize();
      reconnecting = false;
    }, 5000);
  }
});

client.on('change_state', state => {
  console.log('État actuel:', state);
});

// ✅ Un SEUL handler `ready` (sync + traitement des non lus)
client.on('ready', async () => {
  console.log('✅ Client prêt et connecté.');
  isConnected = true;
  isClientReady = true;
  isAuthenticated = true;
  lastQrCode = null;

  if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
  authRecoveryTriggered = false;

  // (re)planifier la sync proprement
  if (syncInterval) clearInterval(syncInterval);
  await syncAllContacts();
  syncInterval = setInterval(syncAllContacts, 2 * 60 * 1000);

  // Traiter les messages non lus
  console.log('🔍 Vérif des messages non lus…');
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.unreadCount > 0) {
        const messages = await chat.fetchMessages({ limit: chat.unreadCount });
        for (const msg of messages) await processMessageAndSendToDjango(msg);
        await chat.sendSeen();
        console.log(`✅ ${chat.name} marqué comme lu.`);
      }
    }
  } catch (err) {
    console.error('❌ Erreur récupération non lus:', err);
  }
  console.log('✅ Ready handler terminé.');
});

// --- API ---
app.get('/whatsapp-status', (req, res) => {
  res.json({ connected: isConnected, authenticated: isAuthenticated, hasQR: !!lastQrCode, qr: lastQrCode });
});

app.get('/whatsapp-diagnose', async (req, res) => {
  try {
    const clientState = await client.getState();
    res.json({ isConnected, isAuthenticated, isClientReady, lastQrCode: !!lastQrCode, clientState });
  } catch (err) {
    res.status(500).json({ isConnected, isAuthenticated, isClientReady, lastQrCode: !!lastQrCode, clientState: 'error', error: err.message });
  }
});

app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'Server is running', timestamp: new Date() });
});

app.post('/whatsapp-disconnect', async (req, res) => {
  try {
    await safeDestroy();
    resetFlags();
    setTimeout(() => client.initialize(), 2000);
    res.json({ status: 'disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/whatsapp-clear-session', async (req, res) => {
  try {
    console.log('🗑️ Suppression des sessions…');
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) {
      rimraf.sync(sessionPath);
      console.log('✅ Sessions supprimées.');
    } else {
      console.log('ℹ️ Aucune session à supprimer.');
    }
    await safeDestroy();
    resetFlags();
    setTimeout(() => client.initialize(), 2000);
    res.json({ status: 'Session cleared, nouveau QR généré.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Messages & Django ---
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';

async function processMessageAndSendToDjango(msg) {
  if (msg.fromMe) return;

  let messageBody = '';
  if (msg.hasMedia) {
    const typeMap = { image: 'Image', audio: 'Audio', video: 'Vidéo', document: 'Document', ptt: 'Voice Message', sticker: 'Sticker' };
    messageBody = typeMap[msg.type] || 'Other media';
    console.log(`📩 Média de ${msg.from}: ${msg.type}`);
  } else {
    const text = (msg.body || '').trim();
    if (!text) return;
    messageBody = text;
    console.log(`💬 Texte de ${msg.from}: "${text}"`);
  }

  try {
    const resp = await axios.post(DJANGO_API_URL, { sender_number: msg.from, message_body: messageBody }, { headers: { 'Content-Type': 'application/json' } });
    console.log('✅ Envoyé à Django:', resp.data);
  } catch (err) {
    if (err.response) console.error(`❌ Django ${err.response.status}:`, err.response.data);
    else console.error('❌ Erreur Django:', err.message);
  }
}

client.on('message', processMessageAndSendToDjango);

// --- Sync contacts ---
const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

async function syncAllContacts() {
  console.log('🔄 Sync contacts…');
  try {
    const chats = await client.getChats();
    const contacts = chats.filter(c => !c.isGroup).map(c => ({ number: c.id.user, direction: 'sync' }));
    if (contacts.length > 0) {
      await axios.post(DJANGO_SYNC_CONTACTS_URL, contacts, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } });
      console.log(`✅ ${contacts.length} contacts synchronisés.`);
    } else {
      console.log('Aucun contact à synchroniser.');
    }
  } catch (err) {
    console.error('❌ Erreur sync contacts:', err.message);
  }
}

// --- Lancement ---
client.initialize();
const actualPort = process.env.PORT || port;
app.listen(actualPort, () => console.log(`🚀 Serveur sur http://localhost:${actualPort}`));
