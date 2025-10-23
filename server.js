// server.js - SIMPLE VERSION
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing');
  process.exit(1);
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
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  serverId: { type: String, required: true },
  userId: mongoose.Schema.Types.ObjectId,
  username: String,
  nameColor: String,
  profilePhoto: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  seenBy: [{ userId: mongoose.Schema.Types.ObjectId, seenAt: Date }]
});

const verificationSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: String,
  createdAt: { type: Date, default: Date.now }
});

verificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI }),
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Mail
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// Helpers
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(e) {
  return (e || '').toString().trim().toLowerCase();
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
        text: `Doğrulama kodunuz: ${code}`
      });
      console.log(`✉️ Email sent to ${email}`);
      return res.json({ success: true });
    } else {
      console.log(`[DEV] Code for ${email}: ${code}`);
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
    if (!record) return res.json({ success: false, error: 'Invalid code' });

    let user = await User.findOne({ email });
    if (!user) {
      const username = email.split('@')[0];
      user = await User.create({
        email,
        username,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`,
        nameColor: '#4285F4'
      });
    }

    req.session.userId = user._id.toString();
    req.session.email = email;

    await Verification.deleteMany({ email });

    return res.json({ success: true, user: { _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// API: profile-setup
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor, country } = req.body;
    const sessionUserId = req.session.userId;

    if (!sessionUserId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const user = await User.findByIdAndUpdate(
      sessionUserId,
      {
        username: username || 'User',
        profilePhoto: profilePhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}`,
        nameColor: nameColor || '#4285F4',
        country: country || 'TR',
        server: country || 'TR'
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
    return res.status(500).json({ error: 'Server error' });
  }
});

// Socket.io
const roomUsers = new Map();

io.on('connection', (socket) => {
  socket.on('join-server', async (payload) => {
    const { serverId } = payload;
    if (!serverId) return;

    socket.join(serverId);

    if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Set());
    roomUsers.get(serverId).add(socket.id);

    io.to(serverId).emit('update-users', roomUsers.get(serverId).size);
  });

  socket.on('send-message', async (data) => {
    try {
      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date()
      });
      io.to(data.serverId).emit('new-message', msg);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;
      if (!msg.seenBy.some(s => s.userId?.toString() === userId?.toString())) {
        msg.seenBy.push({ userId, seenAt: new Date() });
        await msg.save();
        io.to(msg.serverId).emit('message-seen-update', { messageId: msg._id, seenCount: msg.seenBy.length });
      }
    } catch (err) {
      console.error('message-seen error', err);
    }
  });

  socket.on('disconnect', () => {
    for (const [serverId, users] of roomUsers) {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        io.to(serverId).emit('update-users', users.size);
        break;
      }
    }
  });
});

// Serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
