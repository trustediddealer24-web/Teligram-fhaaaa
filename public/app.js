// DOM refs
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
let isCameraOn = false, isConnected = false, isProcessingOCR = false;
let reconnectAttempts = 0, lastSentText = '';
const MAX_RECONNECT = 5;
let worker = null;

// ---- Tesseract Worker with BEST Settings ----
async function initTesseract() {
    try {
        if (worker) await worker.terminate();
        worker = await Tesseract.createWorker(langSelect.value || 'eng');
        // BEST SETTINGS FOR SMS TEXT
        await worker.setParameters({
            tessedit_pageseg_mode: '6',      // Assume single text block
            tessedit_ocr_engine_mode: '3',   // LSTM only (best accuracy)
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz :-.!@#$%^&*()+=?/.,;',
            tessedit_enable_dict: '0'        // Disable dictionary for better numbers/special chars
        });
        log('✅ OCR Engine (Ultra Mode) ready', 'system');
        return worker;
    } catch (err) {
        log('❌ OCR init error: ' + err.message, 'error');
        return null;
    }
}
initTesseract();

// ---- Logging ----
function log(msg, type = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${msg}`;
    logList.prepend(entry);
    if (logList.children.length > 50) logList.removeChild(logList.lastChild);
}

// ---- WebSocket ----
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen = () => {
        isConnected = true;
        reconnectAttempts = 0;
        statusBar.className = 'status online';
        statusIcon.textContent = '🟢';
        statusText.textContent = 'Connected';
        log('🔗 Server connected', 'system');
        if (!isCameraOn) startBtn.disabled = false;
    };
    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'status') {
                if (data.success) {
                    const preview = data.text.substring(0, 50) + (data.text.length > 50 ? '...' : '');
                    log(`✅ Sent: "${preview}"`, 'success');
                    ocrResult.textContent = `✅ ${preview}`;
                    ocrResult.style.color = '#2ecc71';
                } else {
                    log(`❌ Send failed: ${data.error}`, 'error');
                }
            }
        } catch (err) {
            log('⚠️ Invalid server data', 'error');
        }
    };
    ws.onclose = () => {
        isConnected = false;
        statusBar.className = 'status offline';
        statusIcon.textContent = '🔴';
        statusText.textContent = 'Disconnected';
        startBtn.disabled = true;
        stopBtn.disabled = true;
        captureBtn.disabled = true;
        flashBtn.disabled = true;
        if (reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            setTimeout(connectWebSocket, 3000 * reconnectAttempts);
        } else {
            log('❌ Max reconnect attempts', 'error');
        }
    };
}
connectWebSocket();

// ---- Camera ----
async function startCamera() {
    try {
        if (stream) stopCamera();
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15 }
            },
            audio: false
        });
        cameraVideo.srcObject = stream;
        await cameraVideo.play();
        isCameraOn = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        captureBtn.disabled = false;
        flashBtn.disabled = false;
        statusText.textContent = '📸 Live';
        log('📷 Camera started (Back)', 'system');
        ocrResult.textContent = '🔍 Point at SMS screen...';
        ocrResult.style.color = '#fff';
        if (autoScanToggle.checked) startAutoScan();
    } catch (err) {
        log('❌ Camera error: ' + err.message, 'error');
        alert('Camera error: ' + err.message);
        startBtn.disabled = false;
    }
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    cameraVideo.srcObject = null;
    isCameraOn = false;
    stopAutoScan();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    captureBtn.disabled = true;
    flashBtn.disabled = true;
    statusText.textContent = 'Stopped';
    log('⏹ Camera stopped', 'system');
    ocrResult.textContent = '📝 Camera off';
}

// ---- Torch ----
let flashOn = false;
flashBtn.addEventListener('click', () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track.getCapabilities().torch) {
        alert('Torch not supported');
        return;
    }
    flashOn = !flashOn;
    track.applyConstraints({ advanced: [{ torch: flashOn }] });
    flashBtn.textContent = flashOn ? '🔦 On' : '🔦 Off';
});

// ---- Auto Scan ----
function startAutoScan() {
    if (captureInterval) clearInterval(captureInterval);
    const interval = parseInt(intervalInput.value) || 1200;
    captureInterval = setInterval(() => {
        if (isCameraOn && !isProcessingOCR) performOCR();
    }, interval);
    log(`🔄 Auto-scan ${interval}ms`, 'system');
}
function stopAutoScan() {
    if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
        log('⏹ Auto-scan off', 'system');
    }
}

// ---- Manual Capture ----
captureBtn.addEventListener('click', () => {
    if (isCameraOn) performOCR();
    else alert('Start camera first.');
});

// ---- ⭐ SUPER FAST + ACCURATE OCR (With Image Enhancement) ----
async function performOCR() {
    if (!isCameraOn || !cameraVideo.videoWidth) {
        ocrResult.textContent = '⏳ Waiting for camera...';
        return;
    }
    if (!worker) {
        worker = await initTesseract();
        if (!worker) return;
    }

    isProcessingOCR = true;
    ocrResult.textContent = '⏳ Scanning...';
    ocrResult.style.color = '#f1c40f';

    try {
        const canvas = captureCanvas;
        const video = cameraVideo;
        // Use slightly higher resolution for better accuracy, but still fast
        canvas.width = Math.min(video.videoWidth, 640);
        canvas.height = Math.min(video.videoHeight, 480);
        const ctx = canvas.getContext('2d');

        // Draw video frame (No Mirror)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // 🔥 ADVANCED IMAGE PROCESSING for SMS
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // Step 1: Grayscale
        for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            data[i] = gray;
            data[i+1] = gray;
            data[i+2] = gray;
        }
        
        // Step 2: High Contrast (1.8x boost for dark mode SMS)
        const contrast = 1.8;
        for (let i = 0; i < data.length; i += 4) {
            let val = 128 + contrast * (data[i] - 128);
            val = Math.min(255, Math.max(0, val));
            data[i] = val;
            data[i+1] = val;
            data[i+2] = val;
        }
        
        // Step 3: Binarization (Optional - makes text crisp)
        // For dark mode SMS, we threshold at 100
        const threshold = 100;
        for (let i = 0; i < data.length; i += 4) {
            const val = data[i] > threshold ? 255 : 0;
            data[i] = val;
            data[i+1] = val;
            data[i+2] = val;
        }
        
        ctx.putImageData(imageData, 0, 0);

        const startTime = performance.now();
        const result = await worker.recognize(canvas);
        const text = result.data.text.trim();
        const elapsed = (performance.now() - startTime).toFixed(0);

        log(`⚡ OCR done in ${elapsed}ms`, 'system');

        if (text.length > 0) {
            const preview = text.substring(0, 60) + (text.length > 60 ? '...' : '');
            ocrResult.textContent = `📝 ${preview}`;
            ocrResult.style.color = '#2ecc71';

            // Send to server (only if different from last)
            if (text !== lastSentText) {
                lastSentText = text;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'text', payload: text }));
                    log(`📤 Sent ${text.length} chars to Server`, 'system');
                } else {
                    log('⚠️ WS not open', 'error');
                }
            } else {
                log(`🔄 Duplicate ignored`, 'system');
            }
        } else {
            ocrResult.textContent = '🔍 No text found';
            ocrResult.style.color = '#e74c3c';
        }
    } catch (err) {
        log('❌ OCR error: ' + err.message, 'error');
        ocrResult.textContent = '⚠️ OCR Error';
        ocrResult.style.color = '#e74c3c';
    } finally {
        isProcessingOCR = false;
    }
}

// ---- Toggle Auto-Scan ----
autoScanToggle.addEventListener('change', () => {
    if (autoScanToggle.checked && isCameraOn) startAutoScan();
    else stopAutoScan();
});

// ---- Language Change ----
langSelect.addEventListener('change', async () => {
    if (worker) await worker.terminate();
    worker = null;
    await initTesseract();
    log(`🔤 Language: ${langSelect.value}`, 'system');
});

// ---- Clear Log ----
clearLogBtn.addEventListener('click', () => {
    logList.innerHTML = '';
    log('🗑️ Log cleared', 'system');
});

// ---- Event Listeners ----
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

// ---- Keep Alive ----
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 25000);

// ---- Cleanup ----
window.addEventListener('beforeunload', () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (worker) worker.terminate();
    if (ws) ws.close();
});

log('🚀 ULTIMATE SMS SCANNER Ready! Point at SMS screen.', 'system');
