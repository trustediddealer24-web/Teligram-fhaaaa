require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('❌ FATAL: Missing .env variables');
    process.exit(1);
}

// ---------- 🔥 ULTIMATE SMS PARSER (Only Your Format) ----------
function parseSmsFormat(rawText) {
    // Step 1: Clean the text (remove extra spaces, newlines)
    const clean = rawText.replace(/\s+/g, ' ').trim();
    
    // Step 2: Try to find "To:" and "Message:" patterns
    // Pattern 1: "To: 1234567890" (with optional colon and space)
    const toMatch = clean.match(/To\s*:\s*(\d{10,15})/i);
    
    // Pattern 2: "Message: some text" (case insensitive, handles "Message:", "MESSAGE:", etc.)
    // Also handles OCR errors like "$D Message" -> we use a more flexible pattern
    const msgMatch = clean.match(/(?:[a-zA-Z]+\s+)?Message\s*:\s*([^\n]+)/i);
    
    // Pattern 3: Sometimes OCR splits "Message:" into two lines, so try to find it differently
    if (!msgMatch) {
        // Try to find text after "Message:" even if there's a newline
        const altMatch = clean.match(/Message\s*:\s*([\w\s\-!@#$%^&*()+=?.,;:{}|<>\/]+)/i);
        if (altMatch) {
            return {
                to: toMatch ? toMatch[1] : null,
                message: altMatch[1].trim(),
                found: true
            };
        }
    }
    
    if (toMatch && msgMatch) {
        return {
            to: toMatch[1],
            message: msgMatch[1].trim(),
            found: true
        };
    }
    
    // If not found, return null (means it's not an SMS screen)
    return { found: false };
}

// ---------- Format Message Exactly as You Wanted ----------
function formatTelegramMessage(to, message) {
    if (!to || !message) return null;
    
    return `📱 SMS TOKEN 🖤 @anynomuospapa 
━━━━━━━━━━━━━━━
📞 To: ${to}
💬 Message: ${message}

📋 One-tap copy:
${to} | ${message}`;
}

// ---------- Telegram Queue ----------
class TelegramQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxRetries = 3;
    }
    async add(message) {
        return new Promise((resolve, reject) => {
            this.queue.push({ message, resolve, reject, attempts: 0 });
            this.process();
        });
    }
    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const item = this.queue.shift();
        try {
            const success = await this.sendToTelegram(item.message);
            if (success) item.resolve({ success: true, text: item.message });
            else throw new Error('Send failed');
        } catch (err) {
            if (item.attempts < this.maxRetries) {
                item.attempts++;
                this.queue.unshift(item);
                setTimeout(() => this.process(), 1000 * item.attempts);
            } else {
                item.reject(err);
            }
        } finally {
            this.processing = false;
            if (this.queue.length > 0) setTimeout(() => this.process(), 100);
        }
    }
    async sendToTelegram(text) {
        if (!text || text.trim().length === 0) return false;
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        try {
            const response = await axios.post(url, {
                chat_id: CHANNEL_ID,
                text: text.trim(),
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }, { timeout: 5000 });
            return response.data.ok === true;
        } catch (error) {
            console.error('Telegram Error:', error.message);
            throw error;
        }
    }
}

const telegramQueue = new TelegramQueue();

// ---------- WebSocket ----------
wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`✅ Client ${clientId} connected`);
    ws.send(JSON.stringify({ type: 'connected', clientId }));

    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw);
            if (data.type === 'text' && data.payload) {
                const rawText = data.payload.trim();
                if (!rawText) return;

                console.log(`📝 [${clientId}] Raw OCR (${rawText.length} chars): "${rawText.substring(0, 80)}..."`);

                // ⭐ Step 1: Parse the SMS format
                const parsed = parseSmsFormat(rawText);
                
                let finalMessage = null;
                let statusType = 'raw';

                if (parsed.found && parsed.to && parsed.message) {
                    // ✅ SMS Format Found!
                    finalMessage = formatTelegramMessage(parsed.to, parsed.message);
                    statusType = 'sms';
                    console.log(`✅ PARSED SMS: To=${parsed.to}, Msg=${parsed.message}`);
                } else {
                    // ❌ Not an SMS screen - send a clear message
                    finalMessage = `⚠️ Format not recognized.\n\nPlease scan an SMS screen with "To:" and "Message:" fields.\n\nRaw text (first 100 chars):\n${rawText.substring(0, 100)}...`;
                    statusType = 'error';
                    console.log(`❌ Parser failed - not an SMS screen`);
                }

                // Send to Telegram
                try {
                    await telegramQueue.add(finalMessage);
                    ws.send(JSON.stringify({
                        type: 'status',
                        success: true,
                        text: finalMessage,
                        statusType: statusType,
                        timestamp: Date.now()
                    }));
                } catch (err) {
                    ws.send(JSON.stringify({
                        type: 'status',
                        success: false,
                        text: rawText,
                        error: err.message,
                        timestamp: Date.now()
                    }));
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (err) {
            console.error('Parse error:', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
    });

    ws.on('close', () => console.log(`❌ Client ${clientId} disconnected`));
});

setInterval(() => {
    console.log(`💚 Active clients: ${wss.clients.size}`);
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`🤖 Bot: ${BOT_TOKEN ? '✅' : '❌'}`);
    console.log(`📢 Channel: ${CHANNEL_ID}`);
    console.log(`🧠 ULTIMATE SMS PARSER is ACTIVE!`);
    console.log(`📱 Only "To:" and "Message:" format will be sent.\n`);
});
