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

// Middleware setup
app.use(cors({ origin: 'https://backoff.travel4you.ma' }));
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connection state variables
let isConnected = false;
let isClientReady = false;
let isAuthenticated = false;
let lastQrCode = null;
let reconnecting = false;
let connectionTimeout = null;
let syncInterval = null;

// Initialize WhatsApp client
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

// --- WhatsApp Event Handlers ---

client.on('qr', qr => {
    console.log('QR Code received');
    QRCode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code:', err);
            lastQrCode = null;
        } else {
            lastQrCode = url;
            isConnected = false;
            isAuthenticated = false;
        }
    });
});

client.on('authenticated', () => {
    console.log('🔐 Successfully authenticated, waiting for ready...');
    isAuthenticated = true;
    connectionTimeout = setTimeout(() => {
        if (!isClientReady) {
            console.warn('⚠️ Client stuck after authentication (possible sync delay or network issue).');
        }
    }, 60000);
});

client.on('auth_failure', msg => {
    console.error('❌ Authentication failed', msg);
    isConnected = false;
    isAuthenticated = false;
    lastQrCode = null;
});

client.on('disconnected', reason => {
    console.log('⚠️ Disconnected from WhatsApp:', reason);
    isConnected = false;
    isClientReady = false;
    isAuthenticated = false;

    if (connectionTimeout) clearTimeout(connectionTimeout);
    if (syncInterval) clearInterval(syncInterval);

    if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
            console.log('Attempting to re-initialize client...');
            client.initialize();
            reconnecting = false;
        }, 5000);
    }
});

client.on('change_state', state => {
    console.log('Current state changed:', state);
});

client.on('ready', async () => {
    console.log('✅ Client is ready! Connection established.');
    isConnected = true;
    isClientReady = true;
    isAuthenticated = true;
    lastQrCode = null;

    if (connectionTimeout) clearTimeout(connectionTimeout);

    // Prevent multiple intervals
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(syncAllContacts, 2 * 60 * 1000);

    // Initial sync
    await syncAllContacts();

    // Process unread messages
    console.log('🔍 Checking for unread messages...');
    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            if (chat.unreadCount > 0) {
                console.log(`📥 ${chat.unreadCount} unread messages from ${chat.name} (${chat.id.user})`);
                const messages = await chat.fetchMessages({ limit: chat.unreadCount });
                for (const msg of messages) {
                    await processMessageAndSendToDjango(msg);
                }
                await chat.sendSeen();
                console.log(`✅ ${chat.name} marked as read.`);
            }
        }
    } catch (error) {
        console.error("❌ Error retrieving unread messages:", error);
    }
    console.log('✅ Ready processing finished.');
});

// --- API Endpoints ---

app.get("/whatsapp-status", (req, res) => {
    console.log("📡 Status request =>", { connected: isConnected, authenticated: isAuthenticated, hasQR: !!lastQrCode });
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
            clientState,
            message: "Detailed client state according to whatsapp-web.js."
        });
    } catch (err) {
        console.error('❌ Error getting client state:', err.message);
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

async function safeDestroy() {
    try {
        client.removeAllListeners();
        await client.destroy();
    } catch (e) {
        console.warn('Error during destroy, retrying in 2s:', e.message);
        await new Promise(res => setTimeout(res, 2000));
        client.removeAllListeners();
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
        console.log('🗑️ Clearing WhatsApp session files...');
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            rimraf.sync(sessionPath);
            console.log('✅ Session files removed successfully.');
        } else {
            console.log('⚠️ No session files found to clear.');
        }

        await safeDestroy();
        isConnected = false;
        isAuthenticated = false;
        isClientReady = false;
        lastQrCode = null;

        setTimeout(() => client.initialize(), 2000);
        res.json({ status: 'Session cleared. Restarting client...' });
    } catch (err) {
        console.error('❌ Error clearing session:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- Message Processing ---

const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';

async function processMessageAndSendToDjango(msg) {
    if (msg.fromMe) return;

    let messageBody = '';
    if (msg.hasMedia) {
        const typeMap = {
            image: 'Image',
            audio: 'Audio',
            video: 'Vidéo',
            document: 'Document',
            ptt: 'Voice Message',
            sticker: 'Sticker'
        };
        messageBody = typeMap[msg.type] || 'Other media';
        console.log(`📩 New media from ${msg.from}: ${msg.type}`);
    } else {
        const textMessage = msg.body.trim();
        if (!textMessage) return;
        messageBody = textMessage;
        console.log(`💬 New text from ${msg.from}: "${textMessage}"`);
    }

    try {
        const response = await axios.post(DJANGO_API_URL, {
            sender_number: msg.from,
            message_body: messageBody
        }, { headers: { 'Content-Type': 'application/json' } });
        console.log("✅ Sent to Django:", response.data);
    } catch (error) {
        if (error.response) {
            console.error(`❌ Django error ${error.response.status}:`, error.response.data);
        } else {
            console.error("❌ Django send failed:", error.message);
        }
    }
}

client.on('message', processMessageAndSendToDjango);

// --- Scheduled Tasks ---

const sendRelancePayer = async () => {
    try {
        const response = await axios.get('https://ts.travel4you.ma/paiement-tours/clients-a-relancer/');
        for (const c of response.data) {
            const phone = c.client_phone.replace(/\D/g, '');
            const msg = `Bonjour ${c.client_name}, il vous reste ${c.balance_remaining} MAD à payer pour : ${c.tour_title}. Merci de régulariser.`;
            try {
                await client.sendMessage(`${phone}@c.us`, msg);
                console.log(`✅ Reminder sent to ${phone}`);
            } catch (e) {
                console.error(`❌ Error sending reminder to ${phone}:`, e.message);
            }
        }
    } catch (err) {
        console.error('❌ Error retrieving reminder list:', err.message);
    }
};

app.get('/send-relance-payer', (req, res) => {
    sendRelancePayer();
    res.json({ status: 'Payment reminders triggered' });
});

app.post("/relance-pub", async (req, res) => {
    const { message, contacts } = req.body;
    if (!message?.trim() || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ message: "Message and contacts required" });
    }

    let sent = [], failed = [];
    for (let number of contacts) {
        let phone = number.replace(/\D/g, "");
        if (!phone.endsWith("@c.us")) phone = `${phone}@c.us`;
        try {
            await client.sendMessage(phone, message);
            sent.push(number);
            console.log(`✅ Sent to ${number}`);
        } catch (e) {
            failed.push(number);
            console.error(`❌ Failed to send to ${number}`, e.message);
        }
    }
    res.json({ message: "Broadcast finished", sentCount: sent.length, failedCount: failed.length, sent, failed });
});

// --- Contact Sync ---

const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

const syncAllContacts = async () => {
    console.log("🔄 Syncing contacts...");
    try {
        const chats = await client.getChats();
        const contacts = chats.filter(c => !c.isGroup).map(c => ({ number: c.id.user, direction: 'sync' }));
        if (contacts.length > 0) {
            await axios.post(DJANGO_SYNC_CONTACTS_URL, contacts, {
                headers: { "Content-Type": "application/json", "Accept": "application/json" }
            });
            console.log(`✅ Synced ${contacts.length} contacts.`);
        } else {
            console.log("No contacts to sync.");
        }
    } catch (err) {
        console.error('❌ Sync error:', err.message);
    }
};

app.get('/whatsapp-sync-contacts', async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ status: 'error', message: 'WhatsApp client not ready. Please scan QR.' });
    }
    await syncAllContacts();
    res.json({ status: 'Synchronization completed.' });
});

// --- Start Client + Server ---
client.initialize();
const actualPort = process.env.PORT || port;
app.listen(actualPort, () => {
    console.log(`🚀 Server listening on http://localhost:${actualPort}`);
});
