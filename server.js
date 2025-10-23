// server.js
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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_in_env';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env — set it and restart.');
  process.exit(1);
}

// ---------- MongoDB ----------
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

// ---------- Schemas ----------
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
  createdAt: { type: Date, default: Date.now, expires: 300 } // 5 minutes TTL
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// ---------- Session (stored in Mongo) ----------
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

// Make express use json & static
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Attach session to socket requests
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ---------- Mail transporter (optional) ----------
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  transporter.verify().then(()=>console.log('✅ SMTP ready')).catch(e=>console.warn('⚠️ SMTP verify failed:', e.message));
} else {
  console.log('ℹ️ SMTP not configured — verification codes will be printed to server console (dev fallback).');
}

// ---------- Helpers ----------
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit string
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
  const mapping = { TR:'TR', US:'US', GB:'GB', DE:'DE', FR:'FR', KR:'KR', JP:'JP', CN:'CN' };
  return mapping[country] || country || 'TR';
}

// ---------- API: send-code ----------
app.post('/api/send-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.json({ success: false, error: 'Missing email' });

    // Remove old codes
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
      console.log(`Sent verification email to ${email}`);
      return res.json({ success: true });
    } else {
      console.log(`[DEV] Verification code for ${email}: ${code}`);
      // dev-debug: include devCode so client testing is easy (remove in prod)
      return res.json({ success: true, devCode: code });
    }
  } catch (err) {
    console.error('send-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ---------- API: verify-code ----------
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    console.log(`[VERIFY ATTEMPT] email=${email} code=${code} ip=${req.ip}`);

    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    const record = await Verification.findOne({ email, code });
    if (!record) {
      const existing = await Verification.find({ email }).lean();
      console.log(`[VERIFY FAIL] existing codes for ${email}:`, existing);
      return res.json({ success: false, error: 'Invalid code' });
    }

    // success: fetch/create user placeholder
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

    // put into session
    req.session.userId = user._id.toString();
    req.session.email = email;

    // delete verification records
    await Verification.deleteMany({ email });

    console.log(`[VERIFY SUCCESS] ${email} -> userId=${user._id}`);
    return res.json({ success: true, user: { _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ---------- API: profile-setup ----------
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
    console.error('api/user error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- API: messages ----------
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const msgs = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: -1 })
      .limit(100);
    return res.json(msgs.reverse());
  } catch (err) {
    console.error('api/messages error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Logout ----------
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Socket.io: rooms & messaging ----------
const roomUsers = new Map(); // room -> Set of socket ids
const socketToMeta = new Map(); // socket.id -> { userId, roomId }

io.on('connection', (socket) => {
  // join-server: payload { userId, serverId, username, nameColor, profilePhoto }
  socket.on('join-server', (payload) => {
    try {
      const { userId, serverId } = payload;
      if (!userId || !serverId) return;
      socket.join(serverId);
      socketToMeta.set(socket.id, { userId, roomId: serverId });

      if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Set());
      roomUsers.get(serverId).add(socket.id);

      const count = roomUsers.get(serverId).size;
      io.to(serverId).emit('update-users', count);

      // update lastSeen asynchronously
      User.findByIdAndUpdate(userId, { lastSeen: new Date(), server: serverId }).catch(()=>{});
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      // create message
      const m = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date()
      });
      io.to(data.serverId).emit('new-message', m);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const msg = await Message.findByIdAndUpdate(messageId, { message: newMessage, edited: true, editedAt: new Date() }, { new: true });
      if (msg) io.to(msg.serverId).emit('message-edited', { messageId: msg._id, newMessage: msg.message, edited: true });
    } catch (err) {
      console.error('edit-message error', err);
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
    const meta = socketToMeta.get(socket.id);
    if (meta) {
      const { roomId } = meta;
      socketToMeta.delete(socket.id);
      if (roomUsers.has(roomId)) {
        roomUsers.get(roomId).delete(socket.id);
        io.to(roomId).emit('update-users', roomUsers.get(roomId).size);
      }
    }
  });
});

// serve index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// start
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
