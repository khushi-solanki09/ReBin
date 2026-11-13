const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Pickup = require('./models/Pickup');
const Collector = require('./models/Collector');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const { spawn } = require('child_process');

// ── ML server (Flask/YOLO). Optional: the rest of the app keeps working if it can't start ──
function startMlServer() {
  const py = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const ml = spawn(py, ['app.py'], { cwd: __dirname });
  ml.on('error', (err) => console.error(`❌ ML server could not start (${py}): ${err.message}. Waste classification will be unavailable.`));
  ml.on('exit', (code) => { if (code) console.error(`⚠️ ML server exited with code ${code}`); });
  ml.stdout.on('data', d => console.log(`[ML Server] ${d}`));
  ml.stderr.on('data', d => console.error(`[ML Server] ${d}`));
}
if (process.env.START_ML !== 'false') startMlServer();

// ── Routes ──
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const pickupRoutes = require('./routes/pickup');
const leaderboardRoutes = require('./routes/leaderboard');
const contactRoutes = require('./routes/contact');

const app = express();
// Behind Render's proxy: use the real visitor IP (needed for correct rate limiting)
app.set('trust proxy', 1);
const server = http.createServer(app);

// ── Socket.IO ──
// Frontend is served by this same server, so same-origin only unless CLIENT_ORIGIN is set.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || false;
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }
});

// ── Middleware ──
// CSP is off for now: the pages use inline scripts and CDN libraries (Leaflet, Socket.IO)
// COOP must allow popups, otherwise the Google sign-in popup can't talk back to the page
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
app.use(cors({ origin: CLIENT_ORIGIN }));
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);
const heavyLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' } });
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Ensure uploads dir exists ──
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

// ── Serve frontend static files ──
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── API Routes ──
app.use('/api/auth', authRoutes);
app.use('/api', profileRoutes);
app.use('/api', pickupRoutes);
app.use('/api', leaderboardRoutes);
app.use('/api/contact', heavyLimiter);
app.use('/api', contactRoutes);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Proxy for ML Model ──
app.post('/api/predict', heavyLimiter, (req, res) => {
  const options = {
    hostname: '127.0.0.1',
    port: 5000,
    path: '/predict',
    method: 'POST',
    headers: req.headers
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    console.error('ML Proxy Error:', e.message);
    res.status(500).json({ error: 'ML server is down' });
  });
  req.pipe(proxyReq);
});

// ══════════════════════════════════════
//  SOCKET.IO — Real-Time Tracking (JWT-authenticated, room access checked in DB)
// ══════════════════════════════════════
const trackingNamespace = io.of('/tracking');

trackingNamespace.use((socket, next) => {
  try {
    const raw = socket.handshake.auth && socket.handshake.auth.token;
    if (!raw) return next(new Error('No token'));
    const decoded = jwt.verify(String(raw).replace(/^Bearer /, ''), process.env.JWT_SECRET);
    socket.data.userId = String(decoded.id);
    socket.data.role = decoded.role;
    socket.data.pickups = new Set(); // pickup ids this socket is allowed to use
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

// Is this user the customer, or the assigned collector, of this pickup?
async function canAccessPickup(userId, pickupId) {
  if (!mongoose.Types.ObjectId.isValid(pickupId)) return null;
  const pickup = await Pickup.findById(pickupId).select('userId collectorId status');
  if (!pickup) return null;
  if (String(pickup.userId) === userId) return { role: 'user', pickup };
  if (pickup.collectorId) {
    const c = await Collector.findById(pickup.collectorId).select('userId');
    if (c && String(c.userId) === userId) return { role: 'collector', pickup };
  }
  return null;
}

trackingNamespace.on('connection', (socket) => {
  socket.on('join-pickup-room', async (pickupId) => {
    try {
      const access = await canAccessPickup(socket.data.userId, pickupId);
      if (!access) return;
      socket.data.pickups.add(String(pickupId));
      socket.join(`pickup-${pickupId}`);
    } catch (e) { /* ignore */ }
  });

  const validCoords = (d) =>
    d && Number.isFinite(d.lat) && Number.isFinite(d.lng) &&
    Math.abs(d.lat) <= 90 && Math.abs(d.lng) <= 180;

  // Only the assigned collector can publish collector location
  socket.on('collector:location-update', async (data) => {
    if (socket.data.role !== 'collector' || !validCoords(data)) return;
    const id = String(data.pickupId);
    const access = await canAccessPickup(socket.data.userId, id);
    if (!access || access.role !== 'collector' || !['assigned', 'in_transit'].includes(access.pickup.status)) return;
    trackingNamespace.to(`pickup-${id}`).emit('collector:location', {
      lat: data.lat, lng: data.lng, timestamp: Date.now()
    });
  });

  // Only the customer can publish their location
  socket.on('user:location-update', (data) => {
    if (socket.data.role !== 'user' || !validCoords(data)) return;
    const id = String(data.pickupId);
    if (!socket.data.pickups.has(id)) return;
    trackingNamespace.to(`pickup-${id}`).emit('user:location', {
      lat: data.lat, lng: data.lng, timestamp: Date.now()
    });
  });
});

// Make io accessible to routes if needed
app.set('io', io);

// ══════════════════════════════════════
//  CONNECT TO MONGODB & START SERVER
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  family: 4 // Force IPv4 to avoid TLS alerts on mixed IPv4/IPv6 networks
})
  .then(async () => {
    console.log('✅ Connected to MongoDB Atlas');
    server.listen(PORT, () => {
      console.log(`🚀 ReBin server running at http://localhost:${PORT}`);
      console.log(`📱 Frontend: http://localhost:${PORT}/index.html`);
      console.log(`🔌 Socket.IO tracking at ws://localhost:${PORT}/tracking`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    console.error('💡 Make sure to update MONGO_URI in server/.env with your MongoDB Atlas connection string');
    process.exit(1);
  });
