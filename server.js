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
        // Add your allowed origins here
        const allowedOrigins = [
            'https://yourapp.com',
            'http://localhost:3000',
            'http://localhost:19000', // Expo dev client
            'http://localhost:19006'  // Expo web
        ];
        const origin = info.origin || info.req.headers.origin;
        return allowedOrigins.includes(origin) || !origin; // Allow null origin for mobile apps
    }
});

// Constants
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds
const CLEANUP_INTERVAL = 300000;  // 5 minutes

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Store connected devices and their WebSocket connections
const connectedDevices = new Map(); // deviceKey -> { ws, lastHeartbeat }
const pendingRequests = new Map(); // targetKey -> [{sourceKey, timestamp}]
const activeConnections = new Map(); // sourceKey_targetKey -> { offer, answer, candidates }

// Utility function to send WebSocket messages with error handling
function sendWSMessage(ws, message) {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error sending WebSocket message:', error);
        return false;
    }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    let deviceKey = null;
    
    // Set up heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(ws, data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
            sendWSMessage(ws, {
                type: 'error',
                message: 'Invalid message format'
            });
        }
    });

    ws.on('close', () => {
        if (deviceKey) {
            handleDeviceDisconnection(deviceKey);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        if (deviceKey) {
            handleDeviceDisconnection(deviceKey);
        }
    });
});

function handleDeviceDisconnection(deviceKey) {
    connectedDevices.delete(deviceKey);
    pendingRequests.delete(deviceKey);
    
    // Notify connected peers about disconnection
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
        case 'offer':
            handleWebRTCOffer(ws, data);
            break;
        case 'answer':
            handleWebRTCAnswer(ws, data);
            break;
        case 'ice-candidate':
            handleICECandidate(ws, data);
            break;
        case 'heartbeat':
            handleHeartbeat(ws);
            break;
        case 'disconnect':
            handleDisconnect(ws, data);
            break;
    }
}

function handleDeviceRegistration(ws, data) {
    const { deviceKey } = data;
    
    if (connectedDevices.has(deviceKey)) {
        // Close existing connection if any
        const existingDevice = connectedDevices.get(deviceKey);
        if (existingDevice?.ws && existingDevice.ws !== ws) {
            sendWSMessage(existingDevice.ws, {
                type: 'forced-disconnect',
                message: 'Another device has connected with this key'
            });
            existingDevice.ws.close();
        }
    }

    connectedDevices.set(deviceKey, {
        ws,
        lastHeartbeat: Date.now()
    });
    ws.deviceKey = deviceKey;

    sendWSMessage(ws, {
        type: 'registration-success',
        deviceKey
    });
}

function handleConnectionRequest(ws, data) {
    const { sourceKey, targetKey, offer } = data;
    
    const targetDevice = connectedDevices.get(targetKey);
    if (!targetDevice?.ws) {
        sendWSMessage(ws, {
            type: 'error',
            message: 'Target device not found'
        });
        return;
    }

    // Store the connection details
    const connectionKey = `${sourceKey}_${targetKey}`;
    activeConnections.set(connectionKey, {
        offer,
        candidates: new Map()
    });

    sendWSMessage(targetDevice.ws, {
        type: 'connection-request',
        sourceKey,
        offer
    });
}

function handleWebRTCOffer(ws, data) {
    const { targetKey, offer } = data;
    const sourceKey = ws.deviceKey;
    
    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        const connectionKey = `${sourceKey}_${targetKey}`;
        activeConnections.set(connectionKey, {
            offer,
            candidates: new Map()
        });

        sendWSMessage(targetDevice.ws, {
            type: 'offer',
            sourceKey,
            offer
        });
    }
}

function handleWebRTCAnswer(ws, data) {
    const { targetKey, answer } = data;
    const sourceKey = ws.deviceKey;
    
    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        const connectionKey = `${targetKey}_${sourceKey}`;
        const connection = activeConnections.get(connectionKey);
        if (connection) {
            connection.answer = answer;
            
            sendWSMessage(targetDevice.ws, {
                type: 'answer',
                sourceKey,
                answer
            });
        }
    }
}

function handleICECandidate(ws, data) {
    const { targetKey, candidate } = data;
    const sourceKey = ws.deviceKey;
    
    const targetDevice = connectedDevices.get(targetKey);
    if (targetDevice?.ws) {
        sendWSMessage(targetDevice.ws, {
            type: 'ice-candidate',
            sourceKey,
            candidate
        });
    }
}

function handleHeartbeat(ws) {
    if (ws.deviceKey && connectedDevices.has(ws.deviceKey)) {
        const device = connectedDevices.get(ws.deviceKey);
        device.lastHeartbeat = Date.now();
    }
}

// Heartbeat interval
const heartbeatInterval = setInterval(() => {
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
}, HEARTBEAT_INTERVAL);

// Cleanup interval for stale connections and pending requests
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    
    // Clean up stale device connections
    for (const [deviceKey, device] of connectedDevices) {
        if (now - device.lastHeartbeat > CONNECTION_TIMEOUT) {
            handleDeviceDisconnection(deviceKey);
        }
    }
    
    // Clean up expired pending requests
    for (const [targetKey, requests] of pendingRequests) {
        const validRequests = requests.filter(
            req => now - req.timestamp < CONNECTION_TIMEOUT
        );
        if (validRequests.length === 0) {
            pendingRequests.delete(targetKey);
        } else {
            pendingRequests.set(targetKey, validRequests);
        }
    }
}, CLEANUP_INTERVAL);

// Cleanup on server shutdown
process.on('SIGTERM', () => {
    clearInterval(heartbeatInterval);
    clearInterval(cleanupInterval);
    
    wss.clients.forEach((ws) => {
        ws.terminate();
    });
    
    server.close(() => {
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});