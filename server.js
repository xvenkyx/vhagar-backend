require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

// --- Configuration ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "vhagar_super_secret_key_2026";
const SESSION_DURATION = "12h"; // Extended for better usability

// AWS Configuration
const dynamoConfig = {
    region: process.env.AWS_REGION || 'ap-south-1',
};

const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();

if (accessKeyId && secretAccessKey) {
    dynamoConfig.credentials = { accessKeyId, secretAccessKey };
} else {
    console.warn("⚠️ No AWS_ACCESS_KEY_ID found. Using default provider.");
}

const dynamoClient = new DynamoDBClient(dynamoConfig);
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ec2Client = new EC2Client(dynamoConfig);
const USERS_TABLE = "VhagarUsers";

console.log("🚀 Vhagar Unified Backend Booting Up....");

// ==========================================
// MIDDLEWARE: Admin Protection
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(403).json({ error: "Invalid or expired token." });
    }
};

const adminOnly = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized. Admin access required." });
        }
        next();
    });
};

// ==========================================
// 1. WEBSOCKET RELAY (Authenticated & Bound)
// ==========================================
wss.on('connection', async (ws, req) => {
    try {
        const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const token = urlParams.searchParams.get('token');
        const hardwareId = urlParams.searchParams.get('hwid');
        const type = urlParams.searchParams.get('type') || 'overlay';

        if (!token) throw new Error("Missing Token");
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email: decoded.email } }));
        const user = getRes.Item;

        if (!user) throw new Error("User unauthorized");

        // --- RULE: ADMIN BYPASS ---
        // Admins don't need HWID binding or payment checks
        const isAdmin = user.role === 'admin';

        if (!isAdmin) {
            // Check Payment Status for clients
            if (!user.isPaid) {
                ws.send(JSON.stringify({ error: "Subscription required for relay access." }));
                ws.close(4002, "Payment Required");
                return;
            }

            // HWID Check for clients on Desktop App ('overlay')
            if (type === 'overlay' && hardwareId) {
                if (user.hardwareId && user.hardwareId !== hardwareId) {
                    console.warn(`🛑 Machine mismatch: ${decoded.email}`);
                    ws.send(JSON.stringify({ error: "Access Denied: Machine mismatch." }));
                    ws.close(4003, "Machine mismatch");
                    return;
                }
                if (!user.hardwareId) {
                    await docClient.send(new UpdateCommand({
                        TableName: USERS_TABLE, Key: { email: decoded.email },
                        UpdateExpression: "set hardwareId = :h", ExpressionAttributeValues: { ":h": hardwareId }
                    }));
                    console.log(`✅ Machine Fused: ${decoded.email}`);
                }
            }
        } else {
            console.log(`⚡ Admin Override: ${decoded.email} connected with zero restrictions.`);
        }

        console.log(`🔌 [${type}] Authorized: ${decoded.email} (${user.role})`);

        ws.on('message', (message) => {
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        });

        ws.on('close', () => console.log(`[-] [${type}] Connection closed for ${decoded.email}`));

    } catch (err) {
        console.error("⛔ WebSocket Auth Error:", err.message);
        ws.send(JSON.stringify({ error: "Unauthorized" }));
        ws.close(4001, "Unauthorized");
    }
});

// ==========================================
// 2. AUTHENTICATION & USER MANAGEMENT
// ==========================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, role = "client" } = req.body;
        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
        if (getRes.Item) return res.status(400).json({ error: "User already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            email, password: hashedPassword, role,
            hardwareId: null, isPaid: role === 'admin', // Admins are auto-paid
            createdAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: newUser }));
        const token = jwt.sign({ email, role: newUser.role, isPaid: newUser.isPaid }, JWT_SECRET, { expiresIn: SESSION_DURATION });
        res.status(201).json({ message: "Registered", token, user: { email, role: newUser.role, isPaid: newUser.isPaid } });
    } catch (err) {
        res.status(500).json({ error: "Registration failed" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const getRes = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
        if (!getRes.Item) return res.status(401).json({ error: "User not found" });

        const user = getRes.Item;
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).json({ error: "Incorrect password" });

        const token = jwt.sign({ email, role: user.role, isPaid: user.isPaid }, JWT_SECRET, { expiresIn: SESSION_DURATION });
        res.json({ token, user: { email: user.email, role: user.role, isPaid: user.isPaid, hardwareId: user.hardwareId } });
    } catch (err) {
        res.status(500).json({ error: "Login failed" });
    }
});

// --- ADMIN CONTROL PANEL ENDPOINTS ---

// List all users
app.get('/api/admin/users', adminOnly, async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: USERS_TABLE }));
        // Clean data: don't send passwords
        const users = data.Items.map(({ password, ...cleanUser }) => cleanUser);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// Update user details (Payment, Hardware Reset, Role)
app.post('/api/admin/update-user', adminOnly, async (req, res) => {
    try {
        const { targetEmail, isPaid, resetHardware, role } = req.body;
        
        let updateExp = "set isPaid = :p";
        let attrValues = { ":p": isPaid };

        if (resetHardware) {
            updateExp += ", hardwareId = :h";
            attrValues[":h"] = null;
        }
        if (role) {
            updateExp += ", #r = :role";
            attrValues[":role"] = role;
        }

        await docClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { email: targetEmail },
            UpdateExpression: updateExp,
            ExpressionAttributeValues: attrValues,
            ExpressionAttributeNames: role ? { "#r": "role" } : undefined
        }));

        res.json({ success: true, message: `User ${targetEmail} updated successfully.` });
    } catch (err) {
        res.status(500).json({ error: "Failed to update user" });
    }
});

// Delete user
app.post('/api/admin/delete-user', adminOnly, async (req, res) => {
    try {
        const { targetEmail } = req.body;
        await docClient.send(new DeleteCommand({ TableName: USERS_TABLE, Key: { email: targetEmail } }));
        res.json({ success: true, message: `User ${targetEmail} deleted.` });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete user" });
    }
});

// ==========================================
// 3. AWS INFRASTRUCTURE (Admin Protected)
// ==========================================
app.get('/status/:instanceId', adminOnly, async (req, res) => {
    try {
        const { instanceId } = req.params;
        const command = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
        const data = await ec2Client.send(command).catch(err => { throw new Error(err.message) });
        const state = data.Reservations[0].Instances[0].State.Name;
        res.json({ success: true, status: state.charAt(0).toUpperCase() + state.slice(1) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/action', adminOnly, async (req, res) => {
    try {
        const { action, instanceId } = req.body;
        let command;
        if (action === 'start') command = new StartInstancesCommand({ InstanceIds: [instanceId] });
        else if (action === 'stop') command = new StopInstancesCommand({ InstanceIds: [instanceId] });
        else throw new Error("Unknown action");

        await ec2Client.send(command);
        res.json({ success: true, message: `Instance ${action}ing` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: "OK", service: "Vhagar Backend" }));

server.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📡 Admin API active at http://localhost:${PORT}/api/admin`);
});
