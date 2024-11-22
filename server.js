// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Store connected devices and their WebSocket connections
const connectedDevices = new Map(); // key -> WebSocket connection
const pendingRequests = new Map(); // targetKey -> [{sourceKey, timestamp}]

// WebSocket connection handler
wss.on('connection', (ws) => {
    let deviceKey = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        handleWebSocketMessage(ws, data);
    });

    ws.on('close', () => {
        if (deviceKey) {
            connectedDevices.delete(deviceKey);
            // Clean up any pending requests
            pendingRequests.delete(deviceKey);
        }
    });
});

function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'register':
            handleDeviceRegistration(ws, data);
            break;
        case 'connection-request':
            handleConnectionRequest(ws, data);
            break;
        case 'connection-response':
            handleConnectionResponse(ws, data);
            break;
        case 'webrtc-signal':
            handleWebRTCSignal(ws, data);
            break;
        case 'disconnect':
            handleDisconnect(ws, data);
            break;
    }
}

function handleDeviceRegistration(ws, data) {
    const { deviceKey } = data;
    
    // Check if device key is already registered
    if (connectedDevices.has(deviceKey)) {
        ws.send(JSON.stringify({
            type: 'registration-error',
            message: 'Device key already in use'
        }));
        return;
    }

    // Register the device
    connectedDevices.set(deviceKey, ws);
    ws.deviceKey = deviceKey;

    ws.send(JSON.stringify({
        type: 'registration-success',
        deviceKey
    }));
}

function handleConnectionRequest(ws, data) {
    const { sourceKey, targetKey } = data;
    
    // Check if target device exists and is connected
    const targetWs = connectedDevices.get(targetKey);
    if (!targetWs) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Target device not found'
        }));
        return;
    }

    // Add to pending requests
    if (!pendingRequests.has(targetKey)) {
        pendingRequests.set(targetKey, []);
    }
    pendingRequests.get(targetKey).push({
        sourceKey,
        timestamp: Date.now()
    });

    // Send request to target device
    targetWs.send(JSON.stringify({
        type: 'connection-request',
        sourceKey
    }));
}

function handleConnectionResponse(ws, data) {
    const { sourceKey, targetKey, accepted } = data;
    
    const sourceWs = connectedDevices.get(sourceKey);
    if (!sourceWs) return;

    if (accepted) {
        // Remove from pending requests
        const requests = pendingRequests.get(targetKey) || [];
        pendingRequests.set(
            targetKey,
            requests.filter(req => req.sourceKey !== sourceKey)
        );

        // Notify both parties of successful connection
        sourceWs.send(JSON.stringify({
            type: 'connection-accepted',
            targetKey
        }));

        ws.send(JSON.stringify({
            type: 'connection-established',
            sourceKey
        }));
    } else {
        sourceWs.send(JSON.stringify({
            type: 'connection-rejected',
            targetKey
        }));
    }
}

function handleWebRTCSignal(ws, data) {
    const { signal, targetKey } = data;
    const targetWs = connectedDevices.get(targetKey);
    
    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'webrtc-signal',
            signal,
            sourceKey: ws.deviceKey
        }));
    }
}

function handleDisconnect(ws, data) {
    const { targetKey } = data;
    const targetWs = connectedDevices.get(targetKey);
    
    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'peer-disconnected',
            sourceKey: ws.deviceKey
        }));
    }
}

// Clean up expired pending requests periodically (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [targetKey, requests] of pendingRequests.entries()) {
        const validRequests = requests.filter(
            req => now - req.timestamp < 5 * 60 * 1000 // 5 minutes
        );
        if (validRequests.length === 0) {
            pendingRequests.delete(targetKey);
        } else {
            pendingRequests.set(targetKey, validRequests);
        }
    }
}, 5 * 60 * 1000);

// API endpoints
app.post('/api/validate-key', (req, res) => {
    const { deviceKey } = req.body;
    res.json({
        valid: /^[A-Z0-9]{10}$/.test(deviceKey) && !connectedDevices.has(deviceKey)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});