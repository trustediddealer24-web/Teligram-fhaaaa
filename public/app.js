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
const modeCamera = document.getElementById('modeCamera');
const modeScreen = document.getElementById('modeScreen');

let ws = null, stream = null, captureInterval = null;
let isCameraOn = false, isConnected = false, isProcessingOCR = false;
let reconnectAttempts = 0, lastSentText = '';
const MAX_RECONNECT = 5;
let worker = null;
let currentMode = 'camera'; // 'camera' or 'screen'

// ---- Tesseract Worker ----
async function initTesseract() {
    try {
        if (worker) await worker.terminate();
        worker = await Tesseract.createWorker(langSelect.value || 'eng');
        await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_ocr_engine_mode: '3',
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz :-.!@#$%^&*()+=?/.,;',
            tessedit_enable_dict: '0'
        });
        log('✅ OCR Engine ready', 'system');
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

// ---- Mode Switching ----
modeCamera.addEventListener('click', () => {
    if (currentMode === 'camera') return;
    currentMode = 'camera';
    modeCamera.classList.add('active');
    modeScreen.classList.remove('active');
    stopCamera(); // stop current stream
    log('📷 Switched to Camera mode', 'system');
    // enable start button
    if (isConnected) startBtn.disabled = false;
});

modeScreen.addEventListener('click', () => {
    if (currentMode === 'screen') return;
    currentMode = 'screen';
    modeScreen.classList.add('active');
    modeCamera.classList.remove('active');
    stopCamera(); // stop current stream
    log('🖥️ Switched to Screen Share mode', 'system');
    if (isConnected) startBtn.disabled = false;
});

// ---- Start/Stop ----
async function startCamera() {
    try {
        if (stream) stopCamera();

        let constraints;
        if (currentMode === 'camera') {
            constraints = {
                video: {
                    facingMode: 'environment',
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 15 }
                },
                audio: false
            };
        } else { // screen share
            constraints = {
                video: {
                    displaySurface: 'monitor',
                    frameRate: { ideal: 15 }
                },
                audio: false,
                preferCurrentTab: true
            };
        }

        // For screen share, use getDisplayMedia; for camera use getUserMedia
        if (currentMode === 'camera') {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } else {
            stream = await navigator.mediaDevices.getDisplayMedia(constraints);
            // Handle user cancel
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                stopCamera();
                log('🖥️ Screen share stopped by user', 'system');
            });
        }

        cameraVideo.srcObject = stream;
        await cameraVideo.play();
        isCameraOn = true;

        startBtn.disabled = true;
        stopBtn.disabled = false;
        captureBtn.disabled = false;
        if (currentMode === 'camera') flashBtn.disabled = false;
        else flashBtn.disabled = true; // torch not available in screen share

        statusText.textContent = currentMode === 'camera' ? '📸 Live (Camera)' : '🖥️ Live (Screen)';
        log(`📷 ${currentMode === 'camera' ? 'Camera' : 'Screen Share'} started`, 'system');
        ocrResult.textContent = currentMode === 'camera' ? '🔍 Point at SMS screen...' : '🖥️ Share the screen with SMS...';
        ocrResult.style.color = '#fff';

        if (autoScanToggle.checked) startAutoScan();
    } catch (err) {
        log('❌ Start error: ' + err.message, 'error');
        alert('Error: ' + err.message);
        startBtn.disabled = false;
        stopBtn.disabled = true;
        captureBtn.disabled = true;
        flashBtn.disabled = true;
    }
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
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
    log('⏹ Stream stopped', 'system');
    ocrResult.textContent = '📝 Off';
}

// ---- Torch (only in camera mode) ----
let flashOn = false;
flashBtn.addEventListener('click', () => {
    if (!stream || currentMode !== 'camera') return;
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
    else alert('Start the stream first.');
});

// ---- ⭐ OCR Function (Same for both modes) ----
async function performOCR() {
    if (!isCameraOn || !cameraVideo.videoWidth) {
        ocrResult.textContent = '⏳ Waiting for stream...';
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
        canvas.width = Math.min(video.videoWidth, 640);
        canvas.height = Math.min(video.videoHeight, 480);
        const ctx = canvas.getContext('2d');

        // Draw the current frame (no mirror for both)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Image processing (grayscale + contrast) helps both modes
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            data[i] = gray;
            data[i+1] = gray;
            data[i+2] = gray;
        }
        // Contrast boost
        const contrast = 1.8;
        for (let i = 0; i < data.length; i += 4) {
            let val = 128 + contrast * (data[i] - 128);
            val = Math.min(255, Math.max(0, val));
            data[i] = val;
            data[i+1] = val;
            data[i+2] = val;
        }
        // Binarization
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

log('🚀 ULTIMATE SMS SCANNER Ready! Choose mode & start.', 'system');
