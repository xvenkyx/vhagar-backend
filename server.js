require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "vhagar_super_secret_key_2026";
const SESSION_DURATION = "6h";

// AWS Configuration
const dynamoConfig = {
    region: process.env.AWS_REGION || 'ap-south-1',
};

// If running locally, you might have ENV vars. Otherwise, SDK falls back to ~/.aws/credentials or IAM Roles
const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();

if (accessKeyId && secretAccessKey) {
    dynamoConfig.credentials = {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
    };
} else {
    console.warn("⚠️ No AWS_ACCESS_KEY_ID found in environment. Relying on default AWS profile.");
}

const dynamoClient = new DynamoDBClient(dynamoConfig);
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const USERS_TABLE = "VhagarUsers";

console.log("🚀 Vhagar Unified Backend Booting Up...");

// ==========================================
// 1. WEBSOCKET RELAY (The "Proximity" Engine)
// ==========================================
wss.on('connection', (ws, req) => {
    console.log('[+] New WebSocket client connected!');

    // Optional: Parse JWT from URL queries if you want to strictly secure the WS tunnel
    // const url = new URL(req.url, `http://${req.headers.host}`);
    // const token = url.searchParams.get('token');

    ws.on('message', (message) => {
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => console.log('[-] WebSocket client disconnected.'));
});

// ==========================================
// 2. AUTHENTICATION & LICENSING (REST API)
// ==========================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, role = "client" } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });

        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
        if (getRes.Item) return res.status(400).json({ error: "User already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            email,
            password: hashedPassword,
            role,
            hardwareId: null,
            isPaid: false,
            createdAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: newUser }));
        
        const token = jwt.sign({ email, role }, JWT_SECRET, { expiresIn: SESSION_DURATION });
        res.status(201).json({ message: "Registered", token, user: { email, role, isPaid: false } });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ error: "Internal Error" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
        if (!getRes.Item) return res.status(401).json({ error: "Invalid credentials" });

        const user = getRes.Item;
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign({ email, role: user.role, isPaid: user.isPaid }, JWT_SECRET, { expiresIn: SESSION_DURATION });
        res.json({ message: "Login successful", token, user: { email: user.email, role: user.role, isPaid: user.isPaid } });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Internal Error" });
    }
});

app.post('/api/auth/bind-device', async (req, res) => {
    try {
        const { token, hardwareId } = req.body;
        if (!token || !hardwareId) return res.status(400).json({ error: "Missing parameters" });

        const decoded = jwt.verify(token, JWT_SECRET);
        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email: decoded.email } }));
        const user = getRes.Item;

        if (!user) return res.status(404).json({ error: "User not found" });

        // Anti-Piracy Check
        if (user.hardwareId && user.hardwareId !== hardwareId) {
            return res.status(403).json({ error: "License violation: Account bound to another machine.", bound: false });
        }

        // Bind new device
        if (!user.hardwareId) {
            await docClient.send(new UpdateCommand({
                TableName: USERS_TABLE,
                Key: { email: decoded.email },
                UpdateExpression: "set hardwareId = :h",
                ExpressionAttributeValues: { ":h": hardwareId }
            }));
        }
        res.json({ message: "Device authorized", bound: true });
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
});

app.post('/api/auth/verify', (req, res) => {
    try {
        const decoded = jwt.verify(req.body.token, JWT_SECRET);
        res.json({ valid: true, user: decoded });
    } catch (e) {
        res.status(401).json({ valid: false });
    }
});


// Health Check
app.get('/health', (req, res) => res.json({ status: "OK", service: "Vhagar Backend" }));

server.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📡 REST API active at http://localhost:${PORT}/api/auth`);
    console.log(`🔌 WebSocket Relay active at ws://localhost:${PORT}`);
});
