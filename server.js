// server.js - FIXED VERSION
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const geoip = require('geoip-lite');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_in_env';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env');
  process.exit(1);
}

// Cloudinary Config (optional - for avatar upload)
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

// Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: String,
  profilePhoto: String,
  nameColor: { type: String, default: '#4285F4' },
  country: String,
  server: String,
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  serverId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  nameColor: String,
  profilePhoto: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  edited: { type: Boolean, default: false },
  editedAt: Date,
  seenBy: [{ userId: mongoose.Schema.Types.ObjectId, seenAt: Date }]
});

const verificationSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  code: String,
  createdAt: { type: Date, default: Date.now }
});

// TTL index for verification
verificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// Session
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI }),
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io session
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Mail transporter
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  transporter.verify().then(() => console.log('✅ SMTP ready')).catch(e => console.warn('⚠️ SMTP verify failed:', e.message));
} else {
  console.log('ℹ️ SMTP not configured - codes will print to console');
}

// Multer setup for avatar upload
const storage = process.env.CLOUDINARY_CLOUD_NAME
  ? new CloudinaryStorage({
      cloudinary: cloudinary,
      params: { folder: 'avatars', allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp'] }
    })
  : multer.diskStorage({
      destination: './public/uploads/',
      filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    });

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Helpers
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

function getCountryFromIp(ip) {
  if (!ip) return 'TR';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  const geo = geoip.lookup(ip);
  return (geo && geo.country) ? geo.country : 'TR';
}

function serverForCountry(country) {
  const mapping = { TR: 'TR', US: 'US', GB: 'GB', DE: 'DE', FR: 'FR', KR: 'KR', JP: 'JP', CN: 'CN' };
  return mapping[country] || country || 'TR';
}

// API: send-code
app.post('/api/send-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.json({ success: false, error: 'Missing email' });

    await Verification.deleteMany({ email });

    const code = genCode();
    await Verification.create({ email, code });

    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: 'Global Chat - Doğrulama Kodu',
        text: `Doğrulama kodunuz: ${code} (5 dakika geçerli)`
      });
      console.log(`✉️ Sent verification email to ${email}`);
      return res.json({ success: true });
    } else {
      console.log(`[DEV] Verification code for ${email}: ${code}`);
      return res.json({ success: true, devCode: code });
    }
  } catch (err) {
    console.error('send-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// API: verify-code
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();

    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    const record = await Verification.findOne({ email, code });
    if (!record) {
      return res.json({ success: false, error: 'Invalid or expired code' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      const usernameBase = email.split('@')[0];
      user = await User.create({
        email,
        username: usernameBase,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(usernameBase)}&background=667eea&color=fff`,
        nameColor: '#4285F4'
      });
    }

    req.session.userId = user._id.toString();
    req.session.email = email;

    await Verification.deleteMany({ email });

    console.log(`✅ Verified: ${email}`);
    return res.json({ success: true, user: { _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// API: upload avatar
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    
    const url = req.file.path || `/uploads/${req.file.filename}`;
    return res.json({ success: true, url });
  } catch (err) {
    console.error('upload-avatar error', err);
    return res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// API: profile-setup
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor, country } = req.body;
    const sessionUserId = req.session.userId;
    const email = req.session.email;

    if (!sessionUserId || !email) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const detectedCountry = country || getCountryFromIp(req.ip);
    const serverCode = serverForCountry(detectedCountry);

    const user = await User.findByIdAndUpdate(
      sessionUserId,
      {
        username: username || email.split('@')[0],
        profilePhoto: profilePhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}&background=667eea&color=fff`,
        nameColor: nameColor || '#4285F4',
        country: detectedCountry,
        server: serverCode,
        lastSeen: new Date()
      },
      { new: true }
    );

    return res.json({ success: true, user });
  } catch (err) {
    console.error('profile-setup error', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: current user
app.get('/api/user', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    return res.json({ user });
  } catch (err) {
    console.error('api/user error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// API: messages
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const msgs = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: 1 })
      .limit(100);
    return res.json(msgs);
  } catch (err) {
    console.error('api/messages error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// API: logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Socket.io
const roomUsers = new Map();
const socketToMeta = new Map();

io.on('connection', (socket) => {
  const sessionUserId = socket.request.session?.userId;
  
  if (!sessionUserId) {
    socket.disconnect();
    return;
  }

  socket.on('join-server', async (payload) => {
    try {
      const { serverId } = payload;
      if (!serverId) return;

      const user = await User.findById(sessionUserId);
      if (!user) return;

      socket.join(serverId);
      socketToMeta.set(socket.id, { userId: sessionUserId, roomId: serverId });

      if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Map());
      roomUsers.get(serverId).set(sessionUserId, socket.id);

      // Unique user count
      const uniqueCount = roomUsers.get(serverId).size;
      io.to(serverId).emit('update-users', uniqueCount);

      await User.findByIdAndUpdate(sessionUserId, { lastSeen: new Date(), server: serverId });
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      const user = await User.findById(sessionUserId);
      if (!user) return;

      const m = await Message.create({
        serverId: data.serverId,
        userId: sessionUserId,
        username: user.username,
        nameColor: user.nameColor,
        profilePhoto: user.profilePhoto,
        message: data.message,
        timestamp: new Date()
      });

      io.to(data.serverId).emit('new-message', m);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  socket.on('message-seen', async ({ messageId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;

      if (!msg.seenBy.some(s => s.userId?.toString() === sessionUserId?.toString())) {
        msg.seenBy.push({ userId: sessionUserId, seenAt: new Date() });
        await msg.save();
        io.to(msg.serverId).emit('message-seen-update', { messageId: msg._id, seenCount: msg.seenBy.length });
      }
    } catch (err) {
      console.error('message-seen error', err);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketToMeta.get(socket.id);
    if (meta) {
      const { userId, roomId } = meta;
      socketToMeta.delete(socket.id);

      if (roomUsers.has(roomId)) {
        roomUsers.get(roomId).delete(userId);
        io.to(roomId).emit('update-users', roomUsers.get(roomId).size);
      }
    }
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
