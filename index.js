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

// --- État du client ---
let isConnected = false;
let isClientReady = false;
let isAuthenticated = false;
let lastQrCode = null;
let reconnecting = false;
let connectionTimeout = null;

// --- Initialisation du client WhatsApp ---
const client = new Client({
    authStrategy: new LocalAuth(),
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

// --- Gestion des événements WhatsApp ---
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

// Event handler for a successful connection
const handleReady = () => {
    console.log('✅ Client prêt et connecté.');
    isConnected = true;
    isClientReady = true;
    isAuthenticated = true;
    lastQrCode = null;
    if (connectionTimeout) clearTimeout(connectionTimeout);

    syncAllContacts();
    setInterval(syncAllContacts, 2 * 60 * 1000);
};

client.on('ready', handleReady);

// Event handler for authentication
client.on('authenticated', () => {
    console.log('🔐 Authentifié, en attente de ready...');
    isAuthenticated = true;
    // Ajout d'une logique de récupération robuste
    connectionTimeout = setTimeout(async () => {
        if (!isClientReady) {
            console.warn('⚠️ Bloqué après authentification (ready manquant). Forcing client re-initialization...');
            await safeDestroy();
            client.initialize();
        }
    }, 60000); // 60 secondes de délai
});

client.on('auth_failure', msg => {
    console.error('❌ Auth échouée:', msg);
    isConnected = false;
    isAuthenticated = false;
    lastQrCode = null;
});

client.on('disconnected', reason => {
    console.log('⚠️ Déconnecté:', reason);
    isConnected = false;
    isClientReady = false;
    isAuthenticated = false;
    if (connectionTimeout) clearTimeout(connectionTimeout);

    if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
            console.log('♻️ Tentative de reconnexion...');
            client.initialize();
            reconnecting = false;
        }, 5000);
    }
});

client.on('change_state', state => {
    console.log('État actuel:', state);
});

// --- ENDPOINTS API ---
app.get("/whatsapp-status", (req, res) => {
    res.json({ connected: isConnected, authenticated: isAuthenticated, hasQR: !!lastQrCode, qr: lastQrCode });
});

app.get("/whatsapp-diagnose", async (req, res) => {
    try {
        const clientState = await client.getState();
        res.json({
            isConnected,
            isAuthenticated,
            isClientReady,
            lastQrCode: !!lastQrCode,
            clientState
        });
    } catch (err) {
        res.status(500).json({
            isConnected,
            isAuthenticated,
            isClientReady,
            lastQrCode: !!lastQrCode,
            clientState: 'error',
            error: err.message
        });
    }
});

app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'Server is running', timestamp: new Date() });
});

async function safeDestroy() {
    try {
        await client.destroy();
    } catch (e) {
        console.warn('Erreur destroy, retry dans 2s:', e.message);
        await new Promise(res => setTimeout(res, 2000));
        await client.destroy();
    }
}

app.post("/whatsapp-disconnect", async (req, res) => {
    try {
        await safeDestroy();
        isConnected = false;
        isAuthenticated = false;
        isClientReady = false;
        lastQrCode = null;
        setTimeout(() => client.initialize(), 2000);
        res.json({ status: "disconnected" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/whatsapp-clear-session', async (req, res) => {
    try {
        console.log('🗑️ Suppression des sessions...');
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            rimraf.sync(sessionPath);
            console.log('✅ Sessions supprimées.');
        }
        await safeDestroy();
        isConnected = false;
        isAuthenticated = false;
        isClientReady = false;
        lastQrCode = null;
        client.initialize();
        res.json({ status: 'Session cleared, nouveau QR généré.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Messages entrants & Django ---
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';

async function processMessageAndSendToDjango(msg) {
    if (msg.fromMe) return;
    let messageBody = '';

    if (msg.hasMedia) {
        const typeMap = { image: 'Image', audio: 'Audio', video: 'Vidéo', document: 'Document', ptt: 'Voice Message', sticker: 'Sticker' };
        messageBody = typeMap[msg.type] || 'Other media';
    } else {
        const text = msg.body.trim();
        if (!text) return;
        messageBody = text;
    }

    try {
        const response = await axios.post(DJANGO_API_URL, { sender_number: msg.from, message_body: messageBody });
        console.log("✅ Envoyé à Django:", response.data);
    } catch (error) {
        console.error("❌ Erreur Django:", error.message);
    }
}

client.on('message', processMessageAndSendToDjango);

client.on('ready', async () => {
    console.log('🔍 Vérif des messages non lus...');
    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            if (chat.unreadCount > 0) {
                const messages = await chat.fetchMessages({ limit: chat.unreadCount });
                for (const msg of messages) await processMessageAndSendToDjango(msg);
                await chat.sendSeen();
            }
        }
    } catch (error) {
        console.error("❌ Erreur récupération non lus:", error);
    }
});

// --- Tâches planifiées ---
const sendRelancePayer = async () => {
    try {
        const response = await axios.get('https://ts.travel4you.ma/paiement-tours/clients-a-relancer/');
        for (const clientData of response.data) {
            const phone = clientData.client_phone.replace(/\D/g, '') + "@c.us";
            const message = `Bonjour ${clientData.client_name}, il vous reste ${clientData.balance_remaining} MAD à payer pour les services : ${clientData.tour_title}. Merci de régulariser.`;
            await client.sendMessage(phone, message);
        }
    } catch (err) {
        console.error('❌ Erreur relance:', err.message);
    }
};

app.get('/send-relance-payer', (req, res) => {
    sendRelancePayer();
    res.json({ status: 'Relances envoyées' });
});

app.post("/relance-pub", async (req, res) => {
    const { message, contacts } = req.body;
    if (!message || !contacts?.length) return res.status(400).json({ message: "Message et contacts requis." });

    let sent = [], failed = [];
    for (let number of contacts) {
        let phone = number.replace(/\D/g, "");
        if (!phone.endsWith("@c.us")) phone += "@c.us";
        try {
            await client.sendMessage(phone, message);
            sent.push(number);
        } catch {
            failed.push(number);
        }
    }
    res.json({ sentCount: sent.length, failedCount: failed.length, sent, failed });
});

// --- Sync des contacts ---
const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

const syncAllContacts = async () => {
    try {
        const chats = await client.getChats();
        const contactsToSync = chats.filter(c => !c.isGroup).map(c => ({ number: c.id.user, direction: "sync" }));
        if (contactsToSync.length > 0) {
            await axios.post(DJANGO_SYNC_CONTACTS_URL, contactsToSync);
            console.log(`✅ ${contactsToSync.length} contacts syncés.`);
        }
    } catch (err) {
        console.error('❌ Erreur sync contacts:', err.message);
    }
};

app.get('/whatsapp-sync-contacts', async (req, res) => {
    if (!isClientReady) return res.status(400).json({ status: 'error', message: 'Client non prêt. Scanner QR.' });
    await syncAllContacts();
    res.json({ status: 'Sync terminé.' });
});

// --- Lancement ---
client.initialize();
const actualPort = process.env.PORT || port;
app.listen(actualPort, () => console.log(`🚀 Serveur sur http://localhost:${actualPort}`));
