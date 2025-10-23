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
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// --- sanity checks
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing. Add it to .env and restart.');
  process.exit(1);
}

// --- MongoDB connect
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

// --- Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: String,
  profilePhoto: String, // store dataURL or external URL
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
  createdAt: { type: Date, default: Date.now, expires: 300 } // TTL 5 minutes
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// --- session (stored in mongo)
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

// allow socket access to session
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// --- middleware
app.use(express.json({ limit: '5mb' })); // allow base64 avatar uploads
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- nodemailer transporter (optional)
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
  console.log('ℹ️ SMTP not configured — verification codes printed to server console (dev fallback).');
}

// --- helpers
function genCode() { return Math.floor(100000 + Math.random()*900000).toString(); }
function normalizeEmail(e){ return (e||'').toString().trim().toLowerCase(); }
function ipToCountry(ip){
  if(!ip) return 'TR';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:','');
  const geo = geoip.lookup(ip);
  return geo && geo.country ? geo.country : 'TR';
}
function serverForCountry(code){
  const map = { TR:'TR', US:'US', GB:'GB', DE:'DE', FR:'FR', KR:'KR', JP:'JP', CN:'CN' };
  return map[code] || code || 'TR';
}

// --- API: send verification code
app.post('/api/send-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.json({ success:false, error:'Missing email' });

    // remove existing codes
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
      console.log(`✉️ Sent code to ${email}`);
      return res.json({ success:true });
    } else {
      console.log(`[DEV] Code for ${email}: ${code}`);
      return res.json({ success:true, devCode: code });
    }
  } catch (err) {
    console.error('send-code error', err);
    return res.json({ success:false, error:'Server error' });
  }
});

// --- API: verify code
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    if(!email || !code) return res.json({ success:false, error:'Missing fields' });

    console.log(`[VERIFY ATTEMPT] ${email} code=${code} ip=${req.ip}`);

    const rec = await Verification.findOne({ email, code });
    if (!rec) {
      const existing = await Verification.find({ email }).lean();
      console.log(`[VERIFY FAIL] existing for ${email}:`, existing);
      return res.json({ success:false, error:'Invalid code' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      const username = email.split('@')[0];
      user = await User.create({
        email,
        username,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`,
        nameColor: '#4285F4',
        server: 'TR',
        country: 'TR'
      });
    }

    // set session
    req.session.userId = user._id.toString();
    req.session.email = user.email;

    await Verification.deleteMany({ email });

    return res.json({ success:true, user:{ _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success:false, error:'Server error' });
  }
});

// --- API: detect country by IP (for fallback)
app.get('/api/detect-country', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
  const country = ipToCountry(ip);
  return res.json({ country });
});

// --- API: profile-setup (accept profilePhoto as dataURL)
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor, country } = req.body;
    const sessionUserId = req.session.userId;
    if (!sessionUserId) return res.status(401).json({ success:false, error:'Not authenticated' });

    const serverCode = serverForCountry(country || ipToCountry(req.ip));

    const user = await User.findByIdAndUpdate(sessionUserId, {
      username: username || 'User',
      profilePhoto: profilePhoto || undefined,
      nameColor: nameColor || '#4285F4',
      country: country || ipToCountry(req.ip),
      server: serverCode,
      lastSeen: new Date()
    }, { new:true });

    req.session.userId = user._id.toString();
    return res.json({ success:true, user });
  } catch (err) {
    console.error('profile-setup error', err);
    return res.status(500).json({ success:false, error:'Server error' });
  }
});

// --- API: current user
app.get('/api/user', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error:'Not authenticated' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error:'Not authenticated' });
    return res.json({ user });
  } catch (err) {
    console.error('api/user error', err);
    return res.status(500).json({ error:'Server error' });
  }
});

// --- API: messages
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const msgs = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: 1 })
      .limit(200);
    return res.json(msgs);
  } catch (err) {
    console.error('api/messages error', err);
    return res.status(500).json({ error:'Server error' });
  }
});

// --- Logout
app.get('/logout', (req, res) => {
  req.session.destroy(()=>res.redirect('/'));
});

// --- Socket.io logic
const roomUsers = new Map(); // serverId -> Set(socket.id)
const socketMeta = new Map(); // socket.id -> {userId, serverId}

io.on('connection', (socket) => {
  // join-server expects { userId, serverId, username, nameColor, profilePhoto }
  socket.on('join-server', async (payload = {}) => {
    try {
      // If payload lacks userId, try from session
      const session = socket.request.session || {};
      const sidUserId = session.userId;
      const userId = payload.userId || sidUserId;
      const serverId = payload.serverId || (session && session.server) || 'TR';

      if (!userId) return; // not authenticated

      socket.join(serverId);
      socketMeta.set(socket.id, { userId, serverId });

      if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Set());
      roomUsers.get(serverId).add(socket.id);

      io.to(serverId).emit('update-users', roomUsers.get(serverId).size);

      // update lastSeen
      User.findByIdAndUpdate(userId, { lastSeen: new Date(), server: serverId }).catch(()=>{});
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      // basic validation
      if (!data || !data.serverId || !data.userId) return;

      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date()
      });

      // broadcast to everyone in room (includes sender)
      io.to(data.serverId).emit('new-message', msg);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      if (!messageId || !userId) return;
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

  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      if (!messageId || !newMessage) return;
      const msg = await Message.findByIdAndUpdate(messageId, {
        message: newMessage, edited: true, editedAt: new Date()
      }, { new: true });
      if (msg) io.to(msg.serverId).emit('message-edited', { messageId: msg._id, newMessage: msg.message, edited: true });
    } catch (err) {
      console.error('edit-message error', err);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      const { serverId } = meta;
      socketMeta.delete(socket.id);
      if (roomUsers.has(serverId)) {
        roomUsers.get(serverId).delete(socket.id);
        io.to(serverId).emit('update-users', roomUsers.get(serverId).size);
      }
    }
  });
});

// serve index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// start server
server.listen(PORT, ()=>console.log(`🚀 Server running on port ${PORT}`));
