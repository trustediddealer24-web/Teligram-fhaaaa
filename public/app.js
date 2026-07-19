const statusBar = document.getElementById('status-bar');
const statusIcon = document.getElementById('status-icon');
const statusText = document.getElementById('status-text');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const captureBtn = document.getElementById('captureBtn');
const flashBtn = document.getElementById('flashBtn');
const intervalInput = document.getElementById('intervalInput');
const langSelect = document.getElementById('langSelect');
const autoScanToggle = document.getElementById('autoScanToggle');
const cameraVideo = document.getElementById('cameraVideo');
const captureCanvas = document.getElementById('captureCanvas');
const ocrResult = document.getElementById('ocrResult');
const logList = document.getElementById('logList');
const clearLogBtn = document.getElementById('clearLogBtn');

let ws = null, stream = null, captureInterval = null;
let isCameraOn = false, isConnected = false;
let reconnectAttempts = 0, lastSentText = '', isProcessingOCR = false;
const MAX_RECONNECT = 5;
let worker = null;

async function initTesseract() {
    try {
        if (worker) await worker.terminate();
        worker = await Tesseract.createWorker(langSelect.value || 'eng');
        log('✅ OCR Ready', 'system');
    } catch (err) { log('❌ OCR Error: ' + err.message, 'error'); }
}
initTesseract();

function log(msg, type = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logList.prepend(entry);
    if (logList.children.length > 50) logList.removeChild(logList.lastChild);
}

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen = () => {
        isConnected = true; reconnectAttempts = 0;
        statusBar.className = 'status online';
        statusIcon.textContent = '🟢'; statusText.textContent = 'Connected';
        log('🔗 Server Connected', 'system');
        if (!isCameraOn) startBtn.disabled = false;
    };
    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'status') {
                if (data.success) {
                    log(`✅ Sent: "${data.text}"`, 'success');
                    ocrResult.textContent = `✅ ${data.text}`;
                    ocrResult.style.color = '#2ecc71';
                } else log(`❌ Failed: ${data.error}`, 'error');
            }
        } catch(err) { log('⚠️ Invalid data', 'error'); }
    };
    ws.onclose = () => {
        isConnected = false;
        statusBar.className = 'status offline';
        statusIcon.textContent = '🔴'; statusText.textContent = 'Disconnected';
        startBtn.disabled = true; stopBtn.disabled = true; captureBtn.disabled = true; flashBtn.disabled = true;
        if (reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            setTimeout(connectWebSocket, 3000 * reconnectAttempts);
        }
    };
}
connectWebSocket();

async function startCamera() {
    try {
        if (stream) stopCamera();
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } }
        });
        cameraVideo.srcObject = stream;
        await cameraVideo.play();
        isCameraOn = true;
        startBtn.disabled = true; stopBtn.disabled = false; captureBtn.disabled = false; flashBtn.disabled = false;
        statusText.textContent = '📸 Live';
        log('📷 Camera Started', 'system');
        if (autoScanToggle.checked) startAutoScan();
    } catch (err) {
        log('❌ Camera Error: ' + err.message, 'error');
        alert('Camera error: ' + err.message);
        startBtn.disabled = false;
    }
}

function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    cameraVideo.srcObject = null;
    isCameraOn = false; stopAutoScan();
    startBtn.disabled = false; stopBtn.disabled = true; captureBtn.disabled = true; flashBtn.disabled = true;
    statusText.textContent = 'Stopped';
    log('⏹ Camera Stopped', 'system');
}

let flashOn = false;
flashBtn.addEventListener('click', () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track.getCapabilities().torch) { alert('Torch not supported'); return; }
    flashOn = !flashOn;
    track.applyConstraints({ advanced: [{ torch: flashOn }] });
    flashBtn.textContent = flashOn ? '🔦 On' : '🔦 Off';
});

function startAutoScan() {
    if (captureInterval) clearInterval(captureInterval);
    const interval = parseInt(intervalInput.value) || 1500;
    captureInterval = setInterval(() => { if (isCameraOn && !isProcessingOCR) performOCR(); }, interval);
    log(`🔄 Auto-scan ${interval}ms`, 'system');
}
function stopAutoScan() { if (captureInterval) { clearInterval(captureInterval); captureInterval = null; log('⏹ Auto-scan stopped', 'system'); } }

captureBtn.addEventListener('click', () => { if (isCameraOn) performOCR(); else alert('Start camera first.'); });

async function performOCR() {
    if (!isCameraOn || !cameraVideo.videoWidth) return;
    if (!worker) { worker = await initTesseract(); if (!worker) return; }
    isProcessingOCR = true;
    ocrResult.textContent = '⏳ Scanning...';
    ocrResult.style.color = '#f1c40f';
    try {
        const canvas = captureCanvas;
        const video = cameraVideo;
        canvas.width = Math.min(video.videoWidth, 480);
        canvas.height = Math.min(video.videoHeight, 360);
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const result = await worker.recognize(canvas);
        const text = result.data.text.trim();
        if (text.length > 0) {
            ocrResult.textContent = `📝 ${text}`;
            ocrResult.style.color = '#2ecc71';
            if (text !== lastSentText) {
                lastSentText = text;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'text', payload: text }));
                    log(`📤 Sent: "${text}"`, 'system');
                } else log('⚠️ WS not open', 'error');
            } else log(`🔄 Duplicate ignored`, 'system');
        } else {
            ocrResult.textContent = '🔍 No text found';
            ocrResult.style.color = '#e74c3c';
        }
    } catch (err) { log('❌ OCR Error: ' + err.message, 'error'); }
    finally { isProcessingOCR = false; }
}

autoScanToggle.addEventListener('change', () => {
    if (autoScanToggle.checked && isCameraOn) startAutoScan(); else stopAutoScan();
});
langSelect.addEventListener('change', async () => {
    if (worker) await worker.terminate();
    worker = null; await initTesseract();
    log(`🔤 Language: ${langSelect.value}`, 'system');
});
clearLogBtn.addEventListener('click', () => { logList.innerHTML = ''; log('🗑️ Cleared', 'system'); });
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
window.addEventListener('beforeunload', () => { if (stream) stream.getTracks().forEach(t => t.stop()); if (worker) worker.terminate(); if (ws) ws.close(); });
log('🚀 App Ready. Start Camera!', 'system');
