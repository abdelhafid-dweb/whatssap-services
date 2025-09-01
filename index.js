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
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Connection state variables
let isConnected = false;
let isClientReady = false;
let isAuthenticated = false;
let lastQrCode = null;
let reconnecting = false;
let connectionTimeout = null;

// Initialize WhatsApp client with headless Puppeteer for container environments
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
            // Arguments supplémentaires pour résoudre les problèmes de synchronisation et de performance dans les conteneurs
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disk-cache-size=0'
        ]
    }
});

// Event handler for QR code generation
client.on('qr', qr => {
    console.log('QR Code received:', qr);
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

// Event handler for a successful connection
client.on('ready', () => {
    console.log('✅ Client is ready! Connection established. Setting status to connected.');
    isConnected = true;
    isClientReady = true;
    isAuthenticated = true; // The client is also authenticated at this point
    lastQrCode = null;
    if (connectionTimeout) clearTimeout(connectionTimeout);
    syncAllContacts();
    // Schedule periodic contact sync
    setInterval(syncAllContacts, 2 * 60 * 1000);
});

// Event handler for authentication
client.on('authenticated', () => {
    console.log('🔐 Successfully authenticated, waiting for client ready event...');
    isAuthenticated = true;
    // Set a timeout to check if the client gets stuck after authentication
    connectionTimeout = setTimeout(() => {
        if (!isClientReady) {
            console.warn('⚠️ Le client est bloqué après l\'authentification. Il se peut qu\'il y ait un problème de réseau ou un long délai de synchronisation.');
        }
    }, 60000); // 60 seconds
});

// Event handler for authentication failure
client.on('auth_failure', msg => {
    console.error('❌ Authentication failed', msg);
    isConnected = false;
    isAuthenticated = false;
    lastQrCode = null;
});

// Event handler for disconnection
client.on('disconnected', reason => {
    console.log('⚠️ Disconnected from WhatsApp', reason);
    isConnected = false;
    isClientReady = false;
    isAuthenticated = false;
    if (connectionTimeout) clearTimeout(connectionTimeout);

    if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
            console.log('Attempting to re-initialize client...');
            client.initialize();
            reconnecting = false;
        }, 5000); // Wait for 5 seconds before re-initializing
    }
});
client.on('change_state', state => {
    console.log('Current state changed:', state);
});
// --- API Endpoints ---

// Endpoint to get WhatsApp connection status and QR code
app.get("/whatsapp-status", (req, res) => {
    console.log("📡 Status request =>", { connected: isConnected, authenticated: isAuthenticated, hasQR: !!lastQrCode });
    res.json({ connected: isConnected, authenticated: isAuthenticated, hasQR: !!lastQrCode, qr: lastQrCode });
});

/**
 * NEW: Endpoint for detailed diagnostics
 */
app.get("/whatsapp-diagnose", async (req, res) => {
    try {
        const clientState = await client.getState();
        res.json({
            isConnected,
            isAuthenticated,
            isClientReady,
            lastQrCode: !!lastQrCode,
            clientState,
            message: "This endpoint provides more detailed state information. The 'clientState' is the current state of the client according to the library itself."
        });
    } catch (err) {
        console.error('❌ Error getting client state:', err.message);
        res.status(500).json({
            isConnected,
            isAuthenticated,
            isClientReady,
            lastQrCode: !!lastQrCode,
            clientState: 'error',
            error: err.message,
            message: "Could not retrieve client state. The client might be uninitialized."
        });
    }
});

// Function to safely destroy the client instance
async function safeDestroy() {
    try {
        await client.destroy();
    } catch (e) {
        console.warn('Error during destroy, retrying in 2s', e.message);
        await new Promise(res => setTimeout(res, 2000));
        await client.destroy();
    }
}

// Endpoint to manually disconnect the WhatsApp client
app.post("/whatsapp-disconnect", async (req, res) => {
    try {
        await safeDestroy();
        isConnected = false;
        isAuthenticated = false;
        isClientReady = false;
        lastQrCode = null;
        setTimeout(() => {
            client.initialize();
        }, 2000);
        res.json({ status: "disconnected" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NEW ENDPOINT: Clear session files to force a new QR code login
app.post('/whatsapp-clear-session', async (req, res) => {
    try {
        console.log('🗑️ Clearing WhatsApp session files...');
        // The default session path for LocalAuth is ./.wwebjs_auth
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        
        // Remove the session directory
        if (fs.existsSync(sessionPath)) {
             rimraf.sync(sessionPath);
            console.log('✅ Session files removed successfully.');
        } else {
            console.log('⚠️ No session files found to clear.');
        }

        // Restart the client to generate a new QR code
        await safeDestroy();
        isConnected = false;
        isAuthenticated = false;
        isClientReady = false;
        lastQrCode = null;
        client.initialize();

        res.json({ status: 'Session cleared. Client is restarting to generate a new QR code.' });
    } catch (err) {
        console.error('❌ Error clearing session:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// Django API URL
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';

// Process and forward incoming messages to Django
async function processMessageAndSendToDjango(msg) {
    if (msg.fromMe) return;

    let messageBody = '';

    if (msg.hasMedia) {
        const mediaType = msg.type;
        console.log(`📩 New media received from ${msg.from}. Type: ${mediaType}`);
        const typeMap = {
            image: 'Image',
            audio: 'Audio',
            video: 'Vidéo',
            document: 'Document',
            ptt: 'Voice Message',
            sticker: 'Sticker'
        };
        messageBody = typeMap[mediaType] || 'Other media';
    } else {
        const textMessage = msg.body.trim();
        if (!textMessage) {
            console.log(`⚠️ Empty message received from ${msg.from}. Ignored.`);
            return;
        }
        console.log(`💬 New text received from ${msg.from}: "${textMessage}"`);
        messageBody = textMessage;
    }

    try {
        const response = await axios.post(DJANGO_API_URL, {
            sender_number: msg.from,
            message_body: messageBody
        }, { headers: { 'Content-Type': 'application/json' } });

        if (response.status >= 200 && response.status < 300) {
            console.log("✅ Sent to Django:", response.data);
        } else {
            console.warn(`⚠️ Unexpected status ${response.status}:`, response.data);
        }
    } catch (error) {
        if (error.response) {
            console.error(`❌ Django error ${error.response.status}:`, error.response.data);
        } else if (error.request) {
            console.error(`❌ Django connection failed:`, error.message);
        } else {
            console.error("❌ Unexpected error:", error.message);
        }
    }
}

// Listen to all incoming messages
client.on('message', processMessageAndSendToDjango);

// On ready, process unread messages
client.on('ready', async () => {
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
    console.log('✅ Processing finished.');
});

// --- Scheduled Tasks and Endpoints ---

// Endpoint to send payment reminders
const sendRelancePayer = async () => {
    try {
        const response = await axios.get('https://ts.travel4you.ma/paiement-tours/clients-a-relancer/');
        const clientsToRemind = response.data;

        for (const clientData of clientsToRemind) {
            const phoneNumber = clientData.client_phone.replace(/\D/g, '');
            const message = `Bonjour ${clientData.client_name}, il vous reste ${clientData.balance_remaining} MAD à payer pour les services : ${clientData.tour_title}. Merci de régulariser votre situation.`;

            try {
                await client.sendMessage(`${phoneNumber}@c.us`, message);
                console.log(`✅ Message sent to ${phoneNumber}`);
            } catch (err) {
                console.error(`❌ Error sending message to ${phoneNumber}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ Error retrieving payment data:', err.message);
    }
};

app.get('/send-relance-payer', (req, res) => {
    sendRelancePayer();
    res.json({ status: 'Payment reminders sent' });
});

// Endpoint to send a mass marketing message
app.post("/relance-pub", async (req, res) => {
    const { message, contacts } = req.body;
    
    if (!message || !message.trim()) {
        return res.status(400).json({ message: "Message is required." });
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ message: "No contacts provided." });
    }
    
    console.log(`📢 Sending message to ${contacts.length} contacts...`);
    
    let sent = [];
    let failed = [];
    
    for (let number of contacts) {
        let phone = number.replace(/\D/g, ""); // Remove all non-digits
        if (!phone.endsWith("@c.us")) {
            phone = `${phone}@c.us`;
        }
    
        try {
            await client.sendMessage(phone, message);
            console.log(`✅ Message sent to ${number}`);
            sent.push(number);
        } catch (err) {
            console.error(`❌ Failed to send to ${number}`, err.message);
            failed.push(number);
        }
    }
    
    return res.json({
        message: "Message sending completed",
        sentCount: sent.length,
        failedCount: failed.length,
        sent,
        failed,
    });
});

const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

/**
 * Syncs all WhatsApp chats to the Django API.
 */
const syncAllContacts = async () => {
    console.log("Starting WhatsApp contact synchronization...");
    try {
        const chats = await client.getChats();
        const contactsToSync = [];

        for (const chat of chats) {
            if (chat.isGroup) continue;
            
            const number = chat.id.user;
            contactsToSync.push({
                number: number,
                direction: "sync"
            });
        }

        if (contactsToSync.length > 0) {
            console.log(`Sending ${contactsToSync.length} contacts to the Django server...`);
            await axios.post(
                DJANGO_SYNC_CONTACTS_URL,
                contactsToSync,
                { headers: { "Content-Type": "application/json" ,"Accept": "application/json"} }
            );
            console.log(`✅ Synchronization complete.`);
        } else {
            console.log("No contacts to sync.");
        }
    } catch (err) {
        console.error('❌ Global synchronization error:', err.message);
    }
};

// Endpoint to manually trigger contact synchronization
app.get('/whatsapp-sync-contacts', async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({
            status: 'error',
            message: 'WhatsApp client not ready. Please scan the QR code.'
        });
    }
    await syncAllContacts();
    res.json({ status: 'Synchronization completed.' });
});

// Start the WhatsApp client
client.initialize();

// Start the server
const actualPort = process.env.PORT || port;
app.listen(actualPort, () => {
    console.log(`🚀 Server listening on http://localhost:${actualPort}`);
    console.log(`Access the QR code at http://localhost:${actualPort}`);
});
