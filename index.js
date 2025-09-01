const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: 'https://backoff.travel4you.ma' }));
app.use(express.json());
app.use(bodyParser.json());

// Connection state
let isConnected = false;
let isClientReady = false;
let lastQrCode = null;

const authPath = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);


// Init WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "default" }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote'
        ]
    }
});

// QR Code generated
client.on('qr', qr => {
    console.log('📌 QR Code reçu, scanner avec WhatsApp :');
    qrcodeTerminal.generate(qr, { small: true });
    QRCode.toDataURL(qr, (err, url) => {
        if (err) console.error('❌ Erreur génération QR code:', err);
        else lastQrCode = url;
    });
});
client.on('authenticated', () => {
    console.log('🔐 Authentifié avec succès');
});
// Auth failure
client.on('auth_failure', msg => {
    console.error('❌ Échec d\'authentification:', msg);
    isConnected = false;
    lastQrCode = null;
});

// Ready
client.on('ready', async () => {
    console.log('✅ Le client est prêt ! Connexion établie.');
    isConnected = true;
    isClientReady = true;
    lastQrCode = null;

    try {
        await syncAllContacts();
        console.log('🔄 Synchronisation initiale terminée.');
    } catch (err) {
        console.error('❌ Erreur syncAllContacts:', err.message);
    }

    // Process unread messages
    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            if (chat.unreadCount > 0) {
                const messages = await chat.fetchMessages({ limit: chat.unreadCount });
                for (const msg of messages) await processMessageAndSendToDjango(msg);
                await chat.sendSeen();
            }
        }
        console.log('📩 Messages non lus traités.');
    } catch (err) {
        console.error('❌ Erreur traitement messages non lus:', err);
    }

    // Sync contacts every 2 minutes
    setInterval(syncAllContacts, 2 * 60 * 1000);
});



client.on('disconnected', reason => {
    console.log('⚠️ Déconnecté de WhatsApp:', reason);
    isConnected = false;
    isClientReady = false;
    setTimeout(() => client.initialize(), 5000);
});

// Status endpoint
app.get("/whatsapp-status", (req, res) => {
    console.log("📡 Status request =>", { connected: isConnected, hasQR: !!lastQrCode });
    res.json({ connected: isConnected, hasQR: !!lastQrCode, qr: lastQrCode });
});

async function safeDestroy() {
    try {
        await client.destroy();
    } catch (e) {
        console.warn('Erreur lors de destroy, tentative dans 2s', e.message);
        await new Promise(res => setTimeout(res, 2000));
        await client.destroy();
    }
}

// Disconnect endpoint
app.post("/whatsapp-disconnect", async (req, res) => {
    try {
        await safeDestroy();
        isConnected = false;
        lastQrCode = null;
        setTimeout(() => {
            client.initialize();
        }, 2000); // 2 secondes, ajustable
        res.json({ status: "disconnected" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Django API URL
const DJANGO_API_URL = 'https://ts.travel4you.ma/api/receive-message/';

// Process and forward incoming messages
async function processMessageAndSendToDjango(msg) {
    if (msg.fromMe) return;

    // Ajout d'un log pour confirmer que la fonction est appelée
    console.log(`[processMessageAndSendToDjango] Traitement d'un message de ${msg.from}`);

    let messageBody = '';

    if (msg.hasMedia) {
        const mediaType = msg.type;
        console.log(`📩 Nouveau média reçu de ${msg.from}. Type: ${mediaType}`);
        const typeMap = {
            image: 'Image',
            audio: 'Audio',
            video: 'Vidéo',
            document: 'Document',
            ptt: 'Message vocal',
            sticker: 'Sticker'
        };
        messageBody = typeMap[mediaType] || 'Autre média';
    } else {
        const textMessage = msg.body.trim();
        if (!textMessage) {
            console.log(`⚠️ Message vide reçu de ${msg.from}. Ignoré.`);
            return;
        }
        console.log(`💬 Nouveau texte reçu de ${msg.from}: "${textMessage}"`);
        messageBody = textMessage;
    }

    try {
        const response = await axios.post(DJANGO_API_URL, {
            sender_number: msg.from,
            message_body: messageBody
        }, { headers: { 'Content-Type': 'application/json' } });

        if (response.status >= 200 && response.status < 300) {
            console.log("✅ Envoyé à Django:", response.data);
        } else {
            console.warn(`⚠️ Statut inattendu ${response.status}:`, response.data);
        }
    } catch (error) {
        if (error.response) {
            console.error(`❌ Django error ${error.response.status}:`, error.response.data);
        } else if (error.request) {
            console.error(`❌ Connexion Django échouée:`, error.message);
        } else {
            console.error("❌ Erreur inattendue:", error.message);
        }
    }
}

// Listen to messages
client.on('message', processMessageAndSendToDjango);

// On ready, process unread messages
client.on('ready', async () => {
    console.log('🔍 Recherche des messages non lus...');
    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            if (chat.unreadCount > 0) {
                console.log(`📥 ${chat.unreadCount} messages non lus de ${chat.name} (${chat.id.user})`);
                const messages = await chat.fetchMessages({ limit: chat.unreadCount });
                for (const msg of messages) {
                    await processMessageAndSendToDjango(msg);
                }
                await chat.sendSeen();
                console.log(`✅ ${chat.name} marqué comme lu.`);
            }
        }
    } catch (error) {
        console.error("❌ Erreur récupération messages non lus:", error);
    }
    console.log('✅ Traitement terminé.');
});

// Relance paiement
const sendRelancePayer = async () => {
    try {
        const response = await axios.get('https://ts.travel4you.ma/paiement-tours/clients-a-relancer/');
        const clients = response.data;

        for (const clientData of clients) {
            const numero = clientData.client_phone.replace(/\D/g, '');
            const message = `Bonjour ${clientData.client_name}, il vous reste ${clientData.balance_remaining} MAD à payer pour les services : ${clientData.tour_title}. Merci de régulariser votre situation.`;

            try {
                await client.sendMessage(`${numero}@c.us`, message);
                console.log(`✅ Message envoyé à ${numero}`);
            } catch (err) {
                console.error(`❌ Erreur envoi ${numero}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ Erreur récupération paiement:', err.message);
    }
};

app.get('/send-relance-payer', (req, res) => {
    sendRelancePayer();
    res.json({ status: 'Relances paiement envoyées' });
});

app.post("/relance-pub", async (req, res) => {
    const { message, contacts } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ message: "Le message est requis." });
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ message: "Aucun contact fourni." });
    }

    console.log(`📢 Envoi relance à ${contacts.length} contacts...`);

    let sent = [];
    let failed = [];

    for (let number of contacts) {
        // Formatage international si nécessaire
        let phone = number.replace(/\D/g, ""); // supprimer tout sauf chiffres
        if (!phone.endsWith("@c.us")) {
            phone = `${phone}@c.us`;
        }

        try {
            await client.sendMessage(phone, message);
            console.log(`✅ Message envoyé à ${number}`);
            sent.push(number);
        } catch (err) {
            console.error(`❌ Échec envoi à ${number}, err.message`);
            failed.push(number);
        }
    }

    return res.json({
        message: "Relance terminée",
        sentCount: sent.length,
        failedCount: failed.length,
        sent,
        failed,
    });
});

const DJANGO_SYNC_CONTACTS_URL = 'https://ts.travel4you.ma/api/sync_contacts/sync_contacts/';

/**
 * Synchronise tous les chats de la liste WhatsApp vers l'API Django.
 * L'API Django est censée gérer l'ajout et la mise à jour des contacts.
 */
const syncAllContacts = async () => {
    console.log("Démarrage de la synchronisation des contacts WhatsApp...");
    // Ajouter cette vérification pour éviter l'erreur
    if (!client || !client.info) {
        console.error("❌ Le client n'est pas prêt pour la synchronisation.");
        return;
    }
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
        console.log("Type envoyé à Django:", Array.isArray(contactsToSync));
        console.log("Premier contact:", contactsToSync[0]);

        if (contactsToSync.length > 0) {
            console.log(`Envoi de ${contactsToSync.length} contacts au serveur Django...`);

            const response = await axios.post(
                DJANGO_SYNC_CONTACTS_URL,
                contactsToSync,
                { headers: { "Content-Type": "application/json", "Accept": "application/json" } }
            );

            console.log(`✅ Synchronisation terminée.`, response.data);
        } else {
            console.log("Aucun contact à synchroniser.");
        }
    } catch (err) {
        console.error('❌ Erreur de synchronisation globale:', err.message);
    }
};

// Endpoint pour déclencher manuellement la synchronisation
app.get('/whatsapp-sync-contacts', async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({
            status: 'error',
            message: 'Client WhatsApp non prêt. Veuillez scanner le QR code.'
        });
    }
    await syncAllContacts();
    res.json({ status: 'Synchronization completed.' });
});
// Start WhatsApp client
client.initialize();

// Start server
const actualPort = process.env.PORT || 3000;
app.listen(actualPort, () => {
    console.log(`🚀 Serveur écoute sur http://localhost:${actualPort}`);
    console.log(`Listening on port ${actualPort}`);
});
