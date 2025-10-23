// server.js - Explanations inline where important
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
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // adjust origin for production
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// ---------- MongoDB ----------
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env');
  process.exit(1);
}
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('✅ MongoDB Connected'))
  .catch(err=>{ console.error('❌ MongoDB Error:', err); process.exit(1); });

// ---------- Schemas ----------
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true, unique: true },
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
  createdAt: { type: Date, default: Date.now, expires: 300 } // expires in 5 minutes
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// ---------- Session store ----------
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

// Make session available in socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Mail transporter ----------
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  // verify transporter (non-blocking)
  transporter.verify().then(()=>console.log('✅ SMTP ready')).catch(err=>console.warn('⚠️ SMTP not ready:', err.message));
} else {
  console.log('ℹ️ SMTP not configured — codes will be printed to console (for testing).');
}

// ---------- Helpers ----------
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}
function getCountryFromIp(ip) {
  if (!ip) return 'TR';
  // x-forwarded-for may contain comma list
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  // remove ipv6 prefix
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  const geo = geoip.lookup(ip);
  return (geo && geo.country) ? geo.country : 'TR';
}
function serverForCountry(country) {
  // map some countries to server codes — extend as needed
  const mapping = {
    'TR': 'TR',
    'US': 'US',
    'GB': 'GB',
    'DE': 'DE',
    'FR': 'FR',
    'KR': 'KR',
    'JP': 'JP',
    'CN': 'CN'
  };
  return mapping[country] || country || 'TR';
}

// ---------- API: send code ----------
app.post('/api/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false, error: 'Missing email' });

    // remove existing code for this email
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
    } else {
      console.log(`[DEV] Verification code for ${email}: ${code}`);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('send-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ---------- API: verify code ----------
app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    const record = await Verification.findOne({ email, code });
    if (!record) return res.json({ success: false, error: 'Invalid code' });

    // Create or fetch a user placeholder (email only) but don't force username yet
    let user = await User.findOne({ email });
    if (!user) {
      // generate basic avatar via ui-avatars or pravatar
      user = await User.create({
        email,
        username: email.split('@')[0],
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(email.split('@')[0])}&background=667eea&color=fff`,
        country: null,
        server: null
      });
    }

    // put userId in session for persistence
    req.session.userId = user._id.toString();
    req.session.email = email;

    // delete used code
    await Verification.deleteMany({ email });

    return res.json({ success: true, user: { _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ---------- API: profile setup ----------
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor, country } = req.body;
    const sessionUserId = req.session.userId;
    const email = req.session.email;

    if (!sessionUserId || !email) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const serverCode = serverForCountry(country || getCountryFromIp(req.ip));

    const user = await User.findByIdAndUpdate(sessionUserId, {
      username,
      profilePhoto: profilePhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`,
      nameColor: nameColor || '#4285F4',
      country,
      server: serverCode,
      lastSeen: new Date()
    }, { new: true, upsert: true });

    // keep userId in session
    req.session.userId = user._id.toString();

    return res.json({ success: true, user });
  } catch (err) {
    console.error('profile-setup error', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- API: current user ----------
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

// ---------- API: messages for server ----------
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const messages = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: -1 })
      .limit(100);
    return res.json(messages.reverse());
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Logout ----------
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ---------- Socket.io logic ----------
/*
  - rooms = serverId (like 'TR', 'US', etc.)
  - track online counts per room
*/
const roomUsers = new Map(); // roomId -> Set(socket.id)
const socketUserMap = new Map(); // socket.id -> { userId, roomId }

io.on('connection', (socket) => {
  // When client joins a server (room)
  socket.on('join-server', async (payload) => {
    try {
      // payload expected: { userId, serverId, username, nameColor, profilePhoto }
      const { userId, serverId } = payload;
      if (!serverId || !userId) return;

      socket.join(serverId);
      socketUserMap.set(socket.id, { userId, roomId: serverId });

      if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Set());
      roomUsers.get(serverId).add(socket.id);

      // emit online count to room
      const count = roomUsers.get(serverId).size;
      io.to(serverId).emit('update-users', count);

      // update user's lastSeen in DB (fire and forget)
      User.findByIdAndUpdate(userId, { lastSeen: new Date(), server: serverId }).catch(()=>{});
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  // send-message
  socket.on('send-message', async (data) => {
    try {
      // data: { serverId, userId, username, nameColor, profilePhoto, message, timestamp }
      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: data.timestamp || new Date()
      });

      io.to(data.serverId).emit('new-message', msg);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  // edit message
  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const msg = await Message.findByIdAndUpdate(messageId, { message: newMessage, edited: true, editedAt: new Date() }, { new: true });
      if (msg) io.to(msg.serverId).emit('message-edited', { messageId: msg._id, newMessage: msg.message, edited: true });
    } catch (err) {
      console.error('edit-message error', err);
    }
  });

  // message-seen
  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;
      const already = msg.seenBy.some(s => s.userId?.toString() === userId?.toString());
      if (!already) {
        msg.seenBy.push({ userId, seenAt: new Date() });
        await msg.save();
        io.to(msg.serverId).emit('message-seen-update', { messageId: msg._id, seenCount: msg.seenBy.length });
      }
    } catch (err) {
      console.error('message-seen error', err);
    }
  });

  // disconnect
  socket.on('disconnect', () => {
    const mapping = socketUserMap.get(socket.id);
    if (mapping) {
      const { roomId } = mapping;
      socketUserMap.delete(socket.id);
      if (roomUsers.has(roomId)) {
        roomUsers.get(roomId).delete(socket.id);
        io.to(roomId).emit('update-users', roomUsers.get(roomId).size);
      }
    }
  });
});

// ---------- Serve index.html ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Start ----------
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
