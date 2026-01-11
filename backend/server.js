const WebSocket = require('ws');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const common = require('oci-common');
const objectstorage = require('oci-objectstorage');

const PORT = process.env.PORT || 8080;
const USER_IMAGES_BUCKET = process.env.USER_IMAGES_BUCKET || 'GameStateDataBucket';
const OCI_REGION = process.env.OCI_REGION || process.env.OCI_CLI_REGION || 'il-jerusalem-1';
const OCI_NAMESPACE = process.env.OCI_NAMESPACE || '';

let objectStorageClient;
let cachedNamespace = OCI_NAMESPACE;

async function getObjectStorageClient() {
    if (objectStorageClient) {
        return objectStorageClient;
    }
    const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
    client.region = common.Region.fromRegionId(OCI_REGION);
    objectStorageClient = client;
    return client;
}

async function getNamespaceName() {
    if (cachedNamespace) {
        return cachedNamespace;
    }
    const client = await getObjectStorageClient();
    const response = await client.getNamespace({});
    cachedNamespace = response.value;
    return cachedNamespace;
}

async function uploadImageToBucket(localPath, objectName, contentType) {
    const client = await getObjectStorageClient();
    const namespaceName = await getNamespaceName();
    const stream = fs.createReadStream(localPath);
    await client.putObject({
        namespaceName,
        bucketName: USER_IMAGES_BUCKET,
        objectName,
        putObjectBody: stream,
        contentType
    });
}

// Game constants
const ROUND_DURATION = 10000; // 10 seconds
const SYNC_INTERVAL = 5000; // 5 seconds
const ZOMBIE_TIMEOUT = 60000; // 60 seconds
const MAX_CPS = 15; // Maximum clicks per second
const MAX_CLICKS_PER_ROUND = MAX_CPS * 10; // 150 clicks max per round
const MIN_ROUND_TIME = 9500; // 9.5 seconds minimum before accepting report
const CLICK_TO_VELOCITY_MULTIPLIER = 0.1; // Convert clicks to velocity boost

// Game state
const sessions = new Map(); // token -> session
const cards = new Map(); // cardId -> card data
let nextCardId = 1;

// Container bounds (will be set from first client)
let containerWidth = 0;
let containerHeight = 0;
let containerInitialized = false;
const CARD_WIDTH = 200;
const CARD_HEIGHT = 260;
const MIN_CONTAINER_PADDING = 40; // ensure space larger than card to avoid permanent corner states

function setContainerSize(width, height) {
    if (!width || !height) return;
    const w = Math.max(width, CARD_WIDTH + MIN_CONTAINER_PADDING);
    const h = Math.max(height, CARD_HEIGHT + MIN_CONTAINER_PADDING);
    if (!containerInitialized) {
        containerWidth = w;
        containerHeight = h;
        containerInitialized = true;
    } else {
        // Only grow to larger sizes to avoid zoom-based shrink exploits
        containerWidth = Math.max(containerWidth, w);
        containerHeight = Math.max(containerHeight, h);
    }
    clampAllCardsToBounds();
}

function clampCardToBounds(card) {
    const maxX = Math.max(0, containerWidth - CARD_WIDTH);
    const maxY = Math.max(0, containerHeight - CARD_HEIGHT);
    card.x = Math.max(0, Math.min(card.x, maxX));
    card.y = Math.max(0, Math.min(card.y, maxY));
}

function clampAllCardsToBounds() {
    cards.forEach((card) => clampCardToBounds(card));
}

// Initialize database
const db = new sqlite3.Database('users.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Database connected');
        // Create users table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            image_path TEXT,
            token TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Create Express app
const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.json());
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir)); // Serve frontend over HTTP
// Serve uploaded images from Object Storage
app.get('/uploads/:objectName', async (req, res) => {
    try {
        const client = await getObjectStorageClient();
        const namespaceName = await getNamespaceName();
        const objectName = req.params.objectName;
        const response = await client.getObject({
            namespaceName,
            bucketName: USER_IMAGES_BUCKET,
            objectName
        });
        if (response.contentType) {
            res.setHeader('Content-Type', response.contentType);
        }
        response.value.pipe(res);
    } catch (err) {
        console.error('Failed to fetch image from bucket:', err);
        res.status(404).send('Not found');
    }
});

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

class Card {
    constructor(id, token, name, imageSrc) {
        this.id = id;
        this.token = token;
        this.name = name;
        this.imageSrc = imageSrc;
        this.x = Math.random() * (containerWidth - CARD_WIDTH);
        this.y = Math.random() * (containerHeight - CARD_HEIGHT);
        this.vx = (Math.random() - 0.5) * 6;
        this.vy = (Math.random() - 0.5) * 6;
        this.savedVx = null; // Preserve velocity when tab goes inactive
        this.savedVy = null;
        this.lastSyncTime = Date.now();
        this.lastPositionUpdate = Date.now();
        this.disconnected = false;
        this.disconnectTime = null;
        this.roundStartTime = Date.now();
        this.roundNumber = 0;
        this.inactive = false; // Tab inactive state
        this.cornerHits = 0;
        this.lastCornerHitTime = 0;
        this.lastCornerLabel = null;
    }

    checkBounds() {
        if (this.x < 0) this.x = 0;
        if (this.x + CARD_WIDTH > containerWidth) this.x = containerWidth - CARD_WIDTH;
        if (this.y < 0) this.y = 0;
        if (this.y + CARD_HEIGHT > containerHeight) this.y = containerHeight - CARD_HEIGHT;
    }
}

class Session {
    constructor(token, ws, cardId) {
        this.token = token;
        this.ws = ws;
        this.cardId = cardId;
        this.lastPing = Date.now();
    }
}

// API Routes

// Register new user
app.post('/api/register', upload.single('image'), async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    let imagePath = null;
    if (req.file) {
        try {
            await uploadImageToBucket(req.file.path, req.file.filename, req.file.mimetype);
            fs.unlink(req.file.path, () => {});
            imagePath = `/uploads/${req.file.filename}`;
        } catch (err) {
            console.error('Failed to upload image:', err);
            return res.status(500).json({ error: 'Image upload failed' });
        }
    }
    const token = generateUUID();
    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(
        'INSERT INTO users (username, password, image_path, token) VALUES (?, ?, ?, ?)',
        [username, hashedPassword, imagePath, token],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint')) {
                    return res.status(400).json({ error: 'Username already exists' });
                }
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ 
                success: true, 
                token: token,
                userId: this.lastID,
                imagePath: imagePath
            });
        }
    );
});

// Login user
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            if (!row) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Support both hashed (new) and legacy plaintext passwords
            const isHashed = row.password.startsWith('$2');
            const passwordMatches = isHashed ? bcrypt.compareSync(password, row.password) : row.password === password;

            if (!passwordMatches) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            res.json({ 
                success: true, 
                token: row.token,
                userId: row.id,
                username: row.username,
                imagePath: row.image_path
            });
        }
    );
});

// Get user by token
app.get('/api/user', (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }

    db.get(
        'SELECT id, username, image_path, token FROM users WHERE token = ?',
        [token],
        (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            if (!row) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json(row);
        }
    );
});

// Update user image
app.post('/api/update-image', upload.single('image'), async (req, res) => {
    const token = req.body.token;
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'Image file required' });
    }

    let imagePath;
    try {
        await uploadImageToBucket(req.file.path, req.file.filename, req.file.mimetype);
        fs.unlink(req.file.path, () => {});
        imagePath = `/uploads/${req.file.filename}`;
    } catch (err) {
        console.error('Failed to upload image:', err);
        return res.status(500).json({ error: 'Image upload failed' });
    }

    // Get old image path to delete it
    db.get('SELECT image_path FROM users WHERE token = ?', [token], (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Delete old image if it exists
        if (row.image_path) {
            const oldPath = path.join(__dirname, row.image_path);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        // Update database
        db.run(
            'UPDATE users SET image_path = ? WHERE token = ?',
            [imagePath, token],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                // Update card in game if user is connected
                const session = sessions.get(token);
                if (session) {
                    const card = cards.get(session.cardId);
                    if (card) {
                        card.imageSrc = imagePath;
                        broadcast({
                            type: 'CARD_UPDATED',
                            id: card.id,
                            name: card.name,
                            imageSrc: card.imageSrc
                        });
                    }
                }

                res.json({ success: true, imagePath: imagePath });
            }
        );
    });
});

// Broadcast to all connected clients
function broadcast(message, excludeToken = null) {
    const data = JSON.stringify(message);
    sessions.forEach((session, token) => {
        if (token !== excludeToken && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(data);
        }
    });
}

// Send to specific client
function sendToClient(token, message) {
    const session = sessions.get(token);
    if (session && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(message));
    }
}

// Get full game state
function getFullState() {
    return Array.from(cards.values()).map(card => {
        // Ensure positions are in bounds before sending
        const maxX = containerWidth - CARD_WIDTH;
        const maxY = containerHeight - CARD_HEIGHT;
        let clampedX = Math.max(0, Math.min(card.x, maxX));
        let clampedY = Math.max(0, Math.min(card.y, maxY));
        
        // Prevent sending exact corner positions (which can cause stuck state)
        // Move slightly away from corners
        if (clampedX <= 1 && clampedY <= 1) {
            clampedX = Math.max(5, clampedX);
            clampedY = Math.max(5, clampedY);
        } else if (clampedX >= maxX - 1 && clampedY <= 1) {
            clampedX = Math.min(maxX - 5, clampedX);
            clampedY = Math.max(5, clampedY);
        } else if (clampedX <= 1 && clampedY >= maxY - 1) {
            clampedX = Math.max(5, clampedX);
            clampedY = Math.min(maxY - 5, clampedY);
        } else if (clampedX >= maxX - 1 && clampedY >= maxY - 1) {
            clampedX = Math.min(maxX - 5, clampedX);
            clampedY = Math.min(maxY - 5, clampedY);
        }
        
        return {
            id: card.id,
            name: card.name,
            imageSrc: card.imageSrc,
            x: clampedX,
            y: clampedY,
            vx: card.inactive ? 0 : card.vx, // Don't send velocity if inactive
            vy: card.inactive ? 0 : card.vy,
            roundNumber: card.roundNumber,
            roundStartTime: card.roundStartTime,
            inactive: card.inactive,
            cornerHits: card.cornerHits
        };
    });
}

// Handle CPS report with anti-cheat
function handleCPSReport(token, clicks, roundNumber) {
    const session = sessions.get(token);
    if (!session) return;

    const card = cards.get(session.cardId);
    if (!card) return;

    const now = Date.now();
    const roundAge = now - card.roundStartTime;

    if (roundNumber !== card.roundNumber) {
        console.log(`[${token}] Round number mismatch: expected ${card.roundNumber}, got ${roundNumber}`);
        return;
    }

    if (roundAge < MIN_ROUND_TIME) {
        console.log(`[${token}] CPS report too early: ${roundAge}ms`);
        return;
    }

    const validatedClicks = Math.min(clicks, MAX_CLICKS_PER_ROUND);
    if (clicks !== validatedClicks) {
        console.log(`[${token}] Clamped clicks from ${clicks} to ${validatedClicks}`);
    }

    const velocityBoost = validatedClicks * CLICK_TO_VELOCITY_MULTIPLIER;
    const speed = Math.sqrt(card.vx * card.vx + card.vy * card.vy);
    
    if (speed > 0) {
        const factor = 1 + velocityBoost;
        card.vx *= factor;
        card.vy *= factor;
    } else {
        const angle = Math.random() * Math.PI * 2;
        card.vx = Math.cos(angle) * velocityBoost * 10;
        card.vy = Math.sin(angle) * velocityBoost * 10;
    }

    const maxVel = 20;
    const currentSpeed = Math.sqrt(card.vx * card.vx + card.vy * card.vy);
    if (currentSpeed > maxVel) {
        const scale = maxVel / currentSpeed;
        card.vx *= scale;
        card.vy *= scale;
    }

    card.roundNumber++;
    card.roundStartTime = now;

    // Update position when velocity changes (estimate based on current position)
    // Position will be corrected by client position updates
    const maxX = containerWidth - CARD_WIDTH;
    const maxY = containerHeight - CARD_HEIGHT;
    card.x = Math.max(0, Math.min(card.x, maxX));
    card.y = Math.max(0, Math.min(card.y, maxY));
    
    broadcast({
        type: 'VECTOR_UPDATE',
        id: card.id,
        vx: card.vx,
        vy: card.vy,
        x: card.x,
        y: card.y,
        t0: now
    });

    console.log(`[${token}] CPS: ${validatedClicks} clicks, new velocity: (${card.vx.toFixed(2)}, ${card.vy.toFixed(2)})`);
}

// Periodic global sync
// Note: Server doesn't run physics, it only tracks velocity
// Position sync is for reference only - clients do actual physics
setInterval(() => {
    const now = Date.now();
    const state = getFullState();
    
    // Don't update positions on server - clients handle physics
    // Server only tracks velocity which is authoritative
    // Position in sync is just last known position, clients will correct if needed

    broadcast({
        type: 'GLOBAL_SYNC',
        cards: state,
        timestamp: now
    });
}, SYNC_INTERVAL);

// Cleanup zombie cards
setInterval(() => {
    const now = Date.now();
    const toRemove = [];

    cards.forEach((card, id) => {
        if (card.disconnected && card.disconnectTime) {
            if (now - card.disconnectTime > ZOMBIE_TIMEOUT) {
                toRemove.push(id);
            }
        }
    });

    toRemove.forEach(id => {
        const card = cards.get(id);
        if (card) {
            cards.delete(id);
            sessions.delete(card.token);
            broadcast({
                type: 'CARD_REMOVED',
                id: id
            });
            console.log(`Removed zombie card ${id}`);
        }
    });
}, 5000);

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    let token = null;
    let session = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.type) {
                case 'HANDSHAKE':
                    token = data.token || generateUUID();
                    setContainerSize(data.containerWidth, data.containerHeight);
                    
                    // Load user data from database if token exists
                    if (token && token !== 'anonymous') {
                        db.get('SELECT username, image_path FROM users WHERE token = ?', [token], (err, user) => {
                            if (!err && user) {
                                // Use user data
                                const name = user.username;
                                const imageSrc = user.image_path || './default.jpeg';
                                
                                if (sessions.has(token)) {
                                    const existingSession = sessions.get(token);
                                    const existingCard = cards.get(existingSession.cardId);
                                    
                                    if (existingCard) {
                                        existingCard.disconnected = false;
                                        existingCard.disconnectTime = null;
                                        existingSession.ws = ws;
                                        session = existingSession;
                                        console.log(`[${token}] Reconnected to card ${existingCard.id}`);
                                    } else {
                                        session = createNewSession(token, ws, name, imageSrc);
                                    }
                                } else {
                                    session = createNewSession(token, ws, name, imageSrc);
                                }

                                sendToClient(token, {
                                    type: 'INIT_STATE',
                                    token: token,
                                    cardId: session.cardId,
                                    cards: getFullState(),
                                    containerWidth: containerWidth,
                                    containerHeight: containerHeight,
                                    roundDuration: ROUND_DURATION
                                });
                            } else {
                                // Token not found, create anonymous session
                                session = createNewSession(token, ws, data.name || 'Anonymous', data.imageSrc || './default.jpeg');
                                sendToClient(token, {
                                    type: 'INIT_STATE',
                                    token: token,
                                    cardId: session.cardId,
                                    cards: getFullState(),
                                    containerWidth: containerWidth,
                                    containerHeight: containerHeight,
                                    roundDuration: ROUND_DURATION
                                });
                            }
                        });
                    } else {
                        // Anonymous session
                        session = createNewSession(token, ws, data.name || 'Anonymous', data.imageSrc || './default.jpeg');
                        sendToClient(token, {
                            type: 'INIT_STATE',
                            token: token,
                            cardId: session.cardId,
                            cards: getFullState(),
                            containerWidth: containerWidth,
                            containerHeight: containerHeight,
                            roundDuration: ROUND_DURATION
                        });
                    }
                    break;

                case 'CPS_REPORT':
                    if (!token) break;
                    handleCPSReport(token, data.clicks, data.roundNumber);
                    break;

                case 'UPDATE_CARD':
                    if (!token || !session) break;
                    const card = cards.get(session.cardId);
                    if (card) {
                        if (data.name) card.name = data.name;
                        if (data.imageSrc) card.imageSrc = data.imageSrc;
                        broadcast({
                            type: 'CARD_UPDATED',
                            id: card.id,
                            name: card.name,
                            imageSrc: card.imageSrc
                        });
                    }
                    break;

                case 'REQUEST_FULL_STATE':
                    if (!token) break;
                    const requestSession = sessions.get(token);
                    if (requestSession) {
                        sendToClient(token, {
                            type: 'INIT_STATE',
                            token: token,
                            cardId: requestSession.cardId,
                            cards: getFullState(),
                            containerWidth: containerWidth,
                            containerHeight: containerHeight,
                            roundDuration: ROUND_DURATION
                        });
                    }
                    break;

                case 'CONTAINER_UPDATE':
                    if (!data.width || !data.height) break;
                    setContainerSize(data.width, data.height);
                    broadcast({
                        type: 'BOUNDS_UPDATE',
                        containerWidth,
                        containerHeight,
                        cards: getFullState()
                    });
                    break;

                case 'POSITION_UPDATE':
                    if (!token || !session) break;
                    const positionCard = cards.get(session.cardId);
                    if (positionCard && data.x !== undefined && data.y !== undefined) {
                        // Update server's position tracking with anti-teleport validation
                        const now = Date.now();
                        const dt = Math.max(1, now - (positionCard.lastPositionUpdate || positionCard.lastSyncTime));
                        const maxX = containerWidth - CARD_WIDTH;
                        const maxY = containerHeight - CARD_HEIGHT;
                        let clampedX = Math.max(0, Math.min(data.x, maxX));
                        let clampedY = Math.max(0, Math.min(data.y, maxY));
                        const nearLeft = clampedX <= 1;
                        const nearRight = clampedX >= maxX - 1;
                        const nearTop = clampedY <= 1;
                        const nearBottom = clampedY >= maxY - 1;
                        const dx = clampedX - positionCard.x;
                        const dy = clampedY - positionCard.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        const speed = Math.sqrt(positionCard.vx * positionCard.vx + positionCard.vy * positionCard.vy);
                        // Allowable move: current speed * time + small cushion (prevents teleporting to corners)
                        const allowedDistance = (speed * (dt / 1000)) * 2 + 50;
                        if (distance > allowedDistance) {
                            console.log(`[${token}] Rejected POSITION_UPDATE teleport attempt: dist=${distance.toFixed(1)} allowed=${allowedDistance.toFixed(1)} dt=${dt}ms`);
                            break;
                        }
                        
                        // Calculate card edges for wall collision detection
                        const rightEdge = clampedX + CARD_WIDTH;
                        const bottomEdge = clampedY + CARD_HEIGHT;
                        const prevX = positionCard.x;
                        const prevY = positionCard.y;
                        const prevVx = positionCard.vx;
                        const prevVy = positionCard.vy;
                        let bounced = false;
                        
                        // Detect wall collisions based on position change
                        // If card is at a boundary, it likely bounced
                        const EPSILON = 0.1;
                        
                        // Right wall: card is at right edge
                        if (rightEdge >= containerWidth - EPSILON && prevVx > 0) {
                            positionCard.vx = -Math.abs(positionCard.vx);
                            console.log(`[${token}] Server detected RIGHT wall bounce, flipped vx: ${prevVx.toFixed(2)} -> ${positionCard.vx.toFixed(2)}`);
                            bounced = true;
                        }
                        // Left wall: card is at left edge
                        if (clampedX <= EPSILON && prevVx < 0) {
                            positionCard.vx = Math.abs(positionCard.vx);
                            console.log(`[${token}] Server detected LEFT wall bounce, flipped vx: ${prevVx.toFixed(2)} -> ${positionCard.vx.toFixed(2)}`);
                            bounced = true;
                        }
                        // Bottom wall: card is at bottom edge
                        if (bottomEdge >= containerHeight - EPSILON && prevVy > 0) {
                            positionCard.vy = -Math.abs(positionCard.vy);
                            console.log(`[${token}] Server detected BOTTOM wall bounce, flipped vy: ${prevVy.toFixed(2)} -> ${positionCard.vy.toFixed(2)}`);
                            bounced = true;
                        }
                        // Top wall: card is at top edge
                        if (clampedY <= EPSILON && prevVy < 0) {
                            positionCard.vy = Math.abs(positionCard.vy);
                            console.log(`[${token}] Server detected TOP wall bounce, flipped vy: ${prevVy.toFixed(2)} -> ${positionCard.vy.toFixed(2)}`);
                            bounced = true;
                        }
                        
                        // Prevent storing exact corner positions (which can cause stuck state)
                        // Move slightly away from corners
                        if (clampedX <= 1 && clampedY <= 1) {
                            clampedX = Math.max(5, clampedX);
                            clampedY = Math.max(5, clampedY);
                        } else if (clampedX >= maxX - 1 && clampedY <= 1) {
                            clampedX = Math.min(maxX - 5, clampedX);
                            clampedY = Math.max(5, clampedY);
                        } else if (clampedX <= 1 && clampedY >= maxY - 1) {
                            clampedX = Math.max(5, clampedX);
                            clampedY = Math.min(maxY - 5, clampedY);
                        } else if (clampedX >= maxX - 1 && clampedY >= maxY - 1) {
                            clampedX = Math.min(maxX - 5, clampedX);
                            clampedY = Math.min(maxY - 5, clampedY);
                        }
                        
                        positionCard.x = clampedX;
                        positionCard.y = clampedY;
                        positionCard.lastSyncTime = Date.now();
                        positionCard.lastPositionUpdate = now;

                        // Corner tracking (server-authoritative)
                        if (bounced && (nearLeft || nearRight) && (nearTop || nearBottom)) {
                            // Avoid awarding corners when the container is too small (card always touching)
                            const hasRoom = (containerWidth > CARD_WIDTH + MIN_CONTAINER_PADDING) && (containerHeight > CARD_HEIGHT + MIN_CONTAINER_PADDING);
                            const prevNearLeft = prevX <= 1;
                            const prevNearRight = prevX >= maxX - 1;
                            const prevNearTop = prevY <= 1;
                            const prevNearBottom = prevY >= maxY - 1;
                            const wasInCorner = (prevNearLeft || prevNearRight) && (prevNearTop || prevNearBottom);
                            const cornerLabel = `${nearLeft ? 'L' : 'R'}${nearTop ? 'T' : 'B'}`;
                            const nowMs = Date.now();
                            const cornerCooldownOk = nowMs - (positionCard.lastCornerHitTime || 0) > 800;
                            
                            if (hasRoom && !wasInCorner && cornerCooldownOk && positionCard.lastCornerLabel !== cornerLabel) {
                                positionCard.cornerHits = (positionCard.cornerHits || 0) + 1;
                                positionCard.lastCornerHitTime = nowMs;
                                positionCard.lastCornerLabel = cornerLabel;
                                broadcast({
                                    type: 'CORNER_HIT',
                                    id: positionCard.id,
                                    cornerHits: positionCard.cornerHits
                                });
                            }
                        }

                        // Broadcast authoritative velocity after bounce to resync clients
                        if (bounced) {
                            broadcast({
                                type: 'VECTOR_UPDATE',
                                id: positionCard.id,
                                vx: positionCard.vx,
                                vy: positionCard.vy,
                                x: positionCard.x,
                                y: positionCard.y,
                                t0: now
                            });
                        }
                    }
                    break;

                case 'TAB_INACTIVE':
                    if (!token || !session) break;
                    const inactiveCard = cards.get(session.cardId);
                    if (inactiveCard) {
                        inactiveCard.inactive = true;
                        // Preserve velocity so it can be restored when returning
                        inactiveCard.savedVx = inactiveCard.vx;
                        inactiveCard.savedVy = inactiveCard.vy;
                        // Freeze the card by setting velocity to 0
                        inactiveCard.vx = 0;
                        inactiveCard.vy = 0;
                        console.log(`[${token}] Card ${inactiveCard.id} marked as inactive`);
                        // Broadcast to all other clients
                        broadcast({
                            type: 'CARD_INACTIVE',
                            id: inactiveCard.id
                        }, token);
                    }
                    break;

                case 'TAB_ACTIVE':
                    if (!token || !session) break;
                    const activeCard = cards.get(session.cardId);
                    if (activeCard) {
                        activeCard.inactive = false;
                        // Restore preserved velocity if available
                        if (activeCard.savedVx !== null && activeCard.savedVy !== null) {
                            activeCard.vx = activeCard.savedVx;
                            activeCard.vy = activeCard.savedVy;
                            activeCard.savedVx = null;
                            activeCard.savedVy = null;
                            broadcast({
                                type: 'VECTOR_UPDATE',
                                id: activeCard.id,
                                vx: activeCard.vx,
                                vy: activeCard.vy,
                                x: activeCard.x,
                                y: activeCard.y,
                                t0: Date.now()
                            });
                        }
                        console.log(`[${token}] Card ${activeCard.id} marked as active`);
                        // Broadcast to all other clients
                        broadcast({
                            type: 'CARD_ACTIVE',
                            id: activeCard.id
                        }, token);
                    }
                    break;

                case 'PING':
                    if (token && session) {
                        session.lastPing = Date.now();
                        sendToClient(token, { type: 'PONG' });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        if (token && session) {
            const card = cards.get(session.cardId);
            if (card) {
                card.disconnected = true;
                card.disconnectTime = Date.now();
                console.log(`[${token}] Disconnected, card ${card.id} marked as zombie`);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function createNewSession(token, ws, name, imageSrc) {
    const cardId = nextCardId++;
    const card = new Card(cardId, token, name, imageSrc);
    cards.set(cardId, card);
    
    const session = new Session(token, ws, cardId);
    sessions.set(token, session);
    
    console.log(`[${token}] New session created, card ${cardId}`);
    
    broadcast({
        type: 'CARD_ADDED',
        id: card.id,
        name: card.name,
        imageSrc: card.imageSrc,
        x: card.x,
        y: card.y,
        vx: card.vx,
        vy: card.vy,
        roundNumber: card.roundNumber,
        roundStartTime: card.roundStartTime,
        inactive: card.inactive,
        cornerHits: card.cornerHits
    }, token);
    
    return session;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
});
