const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    // Add WebSocket specific CORS
    verifyClient: (info) => {
        const allowedOrigins = [
            'https://yourapp.com',
            'http://localhost:3000',
            'http://localhost:19000',
            'http://localhost:19006'
        ];
        const origin = info.origin || info.req.headers.origin;
        return allowedOrigins.includes(origin) || !origin;
    }
});

// Constants
const HEARTBEAT_INTERVAL = 30000;
const CONNECTION_TIMEOUT = 60000;
const CLEANUP_INTERVAL = 300000;

// Enhanced logging function
const log = (type, message, data = {}) => {
    console.log(`[${new Date().toISOString()}] [${type}] ${message}`, data);
};

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Store connected devices and their WebSocket connections
const connectedDevices = new Map();
const activeConnections = new Map();

function sendWSMessage(ws, message) {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            const messageStr = JSON.stringify(message);
            ws.send(messageStr);
            log('WEBSOCKET_SEND', 'Message sent successfully', { type: message.type });
            return true;
        }
        log('WEBSOCKET_ERROR', 'WebSocket not open');
        return false;
    } catch (error) {
        log('WEBSOCKET_ERROR', 'Error sending message', { error: error.message });
        return false;
    }
}

wss.on('connection', (ws) => {
    log('WEBSOCKET', 'New connection established');
    
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            log('WEBSOCKET_RECEIVE', 'Message received', { type: data.type });
            await handleWebSocketMessage(ws, data);
        } catch (error) {
            log('WEBSOCKET_ERROR', 'Error handling message', { error: error.message });
            sendWSMessage(ws, {
                type: 'error',
                message: 'Failed to process message'
            });
        }
    });

    ws.on('close', () => {
        if (ws.deviceKey) {
            log('WEBSOCKET', 'Connection closed', { deviceKey: ws.deviceKey });
            handleDeviceDisconnection(ws.deviceKey);
        }
    });

    ws.on('error', (error) => {
        log('WEBSOCKET_ERROR', 'WebSocket error', { error: error.message });
        if (ws.deviceKey) {
            handleDeviceDisconnection(ws.deviceKey);
        }
    });
});

async function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'register':
            await handleDeviceRegistration(ws, data);
            break;
        case 'connection-request':
            await handleConnectionRequest(ws, data);
            break;
        case 'connection-response':
            await handleConnectionResponse(ws, data);
            break;
        case 'offer':
            await handleWebRTCOffer(ws, data);
            break;
        case 'answer':
            await handleWebRTCAnswer(ws, data);
            break;
        case 'ice-candidate':
            await handleICECandidate(ws, data);
            break;
        default:
            log('WEBSOCKET_WARNING', 'Unknown message type', { type: data.type });
            break;
    }
}

async function handleDeviceRegistration(ws, data) {
    const { deviceKey } = data;
    
    if (!deviceKey) {
        log('REGISTRATION_ERROR', 'No device key provided');
        sendWSMessage(ws, {
            type: 'error',
            message: 'Device key is required'
        });
        return;
    }

    if (connectedDevices.has(deviceKey)) {
        const existingDevice = connectedDevices.get(deviceKey);
        if (existingDevice?.ws && existingDevice.ws !== ws) {
            log('REGISTRATION_WARNING', 'Device already registered, disconnecting old session', { deviceKey });
            sendWSMessage(existingDevice.ws, {
                type: 'forced-disconnect',
                message: 'Another device has connected with this key'
            });
            existingDevice.ws.close();
        }
    }

    ws.deviceKey = deviceKey;
    connectedDevices.set(deviceKey, {
        ws,
        lastHeartbeat: Date.now()
    });

    log('REGISTRATION_SUCCESS', 'Device registered successfully', { deviceKey });
    sendWSMessage(ws, {
        type: 'registration-success',
        deviceKey
    });
}

async function handleConnectionRequest(ws, data) {
    const { sourceKey, targetKey, offer } = data;
    
    if (!sourceKey || !targetKey || !offer) {
        log('CONNECTION_ERROR', 'Missing required fields', { sourceKey, targetKey });
        sendWSMessage(ws, {
            type: 'error',
            message: 'Invalid connection request'
        });
        return;
    }

    const targetDevice = connectedDevices.get(targetKey);
    if (!targetDevice?.ws) {
        log('CONNECTION_ERROR', 'Target device not found', { targetKey });
        sendWSMessage(ws, {
            type: 'error',
            message: 'Target device not found or offline'
        });
        return;
    }

    const connectionKey = `${sourceKey}_${targetKey}`;
    activeConnections.set(connectionKey, {
        offer,
        timestamp: Date.now(),
        candidates: []
    });

    log('CONNECTION_REQUEST', 'Forwarding connection request', { sourceKey, targetKey });
    sendWSMessage(targetDevice.ws, {
        type: 'connection-request',
        sourceKey,
        offer
    });
}

async function handleWebRTCOffer(ws, data) {
    const { targetKey, offer } = data;
    const sourceKey = ws.deviceKey;

    if (!targetKey || !offer) {
        log('WEBRTC_ERROR', 'Invalid offer data');
        return;
    }

    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        const connectionKey = `${sourceKey}_${targetKey}`;
        activeConnections.set(connectionKey, {
            offer,
            timestamp: Date.now(),
            candidates: []
        });

        log('WEBRTC_OFFER', 'Forwarding WebRTC offer', { sourceKey, targetKey });
        sendWSMessage(targetDevice.ws, {
            type: 'offer',
            sourceKey,
            offer
        });
    }
}

async function handleWebRTCAnswer(ws, data) {
    const { targetKey, answer } = data;
    const sourceKey = ws.deviceKey;

    if (!targetKey || !answer) {
        log('WEBRTC_ERROR', 'Invalid answer data');
        return;
    }

    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        const connectionKey = `${targetKey}_${sourceKey}`;
        const connection = activeConnections.get(connectionKey);
        
        if (connection) {
            connection.answer = answer;
            log('WEBRTC_ANSWER', 'Forwarding WebRTC answer', { sourceKey, targetKey });
            sendWSMessage(targetDevice.ws, {
                type: 'answer',
                sourceKey,
                answer
            });

            // Forward any stored ICE candidates
            if (connection.candidates.length > 0) {
                connection.candidates.forEach(candidate => {
                    sendWSMessage(targetDevice.ws, {
                        type: 'ice-candidate',
                        sourceKey,
                        candidate
                    });
                });
            }
        }
    }
}

async function handleICECandidate(ws, data) {
    const { targetKey, candidate } = data;
    const sourceKey = ws.deviceKey;

    if (!targetKey || !candidate) {
        log('WEBRTC_ERROR', 'Invalid ICE candidate data');
        return;
    }

    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        const connectionKey = `${sourceKey}_${targetKey}`;
        const connection = activeConnections.get(connectionKey);
        
        if (connection) {
            // Store the candidate
            connection.candidates.push(candidate);
            
            log('WEBRTC_ICE', 'Forwarding ICE candidate', { sourceKey, targetKey });
            sendWSMessage(targetDevice.ws, {
                type: 'ice-candidate',
                sourceKey,
                candidate
            });
        }
    }
}

function handleDeviceDisconnection(deviceKey) {
    if (!deviceKey) return;

    log('DISCONNECT', 'Device disconnecting', { deviceKey });
    connectedDevices.delete(deviceKey);
    
    // Clean up active connections
    for (const [connectionKey, connection] of activeConnections) {
        const [sourceKey, targetKey] = connectionKey.split('_');
        if (sourceKey === deviceKey || targetKey === deviceKey) {
            const otherKey = sourceKey === deviceKey ? targetKey : sourceKey;
            const otherDevice = connectedDevices.get(otherKey);
            
            if (otherDevice?.ws) {
                sendWSMessage(otherDevice.ws, {
                    type: 'peer-disconnected',
                    deviceKey
                });
            }
            activeConnections.delete(connectionKey);
        }
    }
}

// Heartbeat and cleanup intervals
const intervals = {
    heartbeat: setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                if (ws.deviceKey) {
                    handleDeviceDisconnection(ws.deviceKey);
                }
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping(() => {});
        });
    }, HEARTBEAT_INTERVAL),

    cleanup: setInterval(() => {
        const now = Date.now();
        
        // Clean up stale connections
        for (const [connectionKey, connection] of activeConnections) {
            if (now - connection.timestamp > CONNECTION_TIMEOUT) {
                activeConnections.delete(connectionKey);
                log('CLEANUP', 'Removing stale connection', { connectionKey });
            }
        }
    }, CLEANUP_INTERVAL)
};

// Graceful shutdown
process.on('SIGTERM', () => {
    log('SERVER', 'Shutting down gracefully');
    
    Object.values(intervals).forEach(clearInterval);
    
    wss.clients.forEach((ws) => {
        ws.terminate();
    });
    
    server.close(() => {
        log('SERVER', 'Server stopped');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log('SERVER', `Server running on port ${PORT}`);
});