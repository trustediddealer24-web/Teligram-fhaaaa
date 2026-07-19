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

wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`✅ Client ${clientId} connected`);
    ws.send(JSON.stringify({ type: 'connected', clientId }));
    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw);
            if (data.type === 'text' && data.payload) {
                const text = data.payload.trim();
                if (!text) return;
                console.log(`📝 [${clientId}] Text: "${text}"`);
                try {
                    await telegramQueue.add(text);
                    ws.send(JSON.stringify({ type: 'status', success: true, text }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'status', success: false, text, error: err.message }));
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (err) {
            console.error('Parse error:', err);
        }
    });
    ws.on('close', () => console.log(`❌ Client ${clientId} disconnected`));
});

setInterval(() => {
    console.log(`💚 Active clients: ${wss.clients.size}`);
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🤖 Bot: ${BOT_TOKEN ? '✅' : '❌'}`);
    console.log(`📢 Channel: ${CHANNEL_ID}`);
});
