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
const io = new Server(server, {
  cors: { origin: true, methods: ["GET","POST"] }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this';

// --- basic checks ---
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env');
  process.exit(1);
}

// --- MongoDB connect ---
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

// --- Schemas ---
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: String,
  profilePhoto: String, // data URL or URL
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

// --- session ---
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

// allow socket to access express session
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// --- middleware ---
app.use(express.json({ limit: '5mb' })); // allow avatar base64
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- mailer (optional) ---
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  transporter.verify().then(()=>console.log('✅ SMTP ready')).catch(e=>console.warn('⚠ SMTP verify failed:', e.message));
} else {
  console.log('ℹ SMTP not configured — verification codes will be printed in server logs (dev fallback).');
}

// --- helpers ---
function genCode() { return Math.floor(100000 + Math.random()*900000).toString(); }
function normalizeEmail(e){ return (e||'').toString().trim().toLowerCase(); }
function ipFromReq(req){
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || '';
  if (ip.includes(',')) return ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:','');
  return ip;
}
function countryFromIp(ip){
  try{
    const geo = geoip.lookup(ip);
    return (geo && geo.country) ? geo.country : 'TR';
  }catch(e){ return 'TR'; }
}

// --- API: send-code ---
app.post('/api/send-code', async (req,res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.json({ success:false, error:'Missing email' });

    await Verification.deleteMany({ email });
    const code = genCode();
    await Verification.create({ email, code });

    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: 'Doğrulama Kodu - Global Chat',
        text: `Doğrulama kodunuz: ${code} (5 dakika geçerli)`
      });
      console.log(`✉️ Sent verification to ${email}`);
      return res.json({ success:true });
    } else {
      console.log(`[DEV] Verification code for ${email}: ${code}`);
      return res.json({ success:true, devCode: code });
    }
  } catch (err) {
    console.error('send-code error', err);
    return res.json({ success:false, error:'Server error' });
  }
});

// --- API: verify-code ---
app.post('/api/verify-code', async (req,res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code||'').toString().trim();
    if (!email || !code) return res.json({ success:false, error:'Missing fields' });

    console.log(`[VERIFY ATTEMPT] ${email} -> ${code}`);
    const record = await Verification.findOne({ email, code });
    if (!record) {
      const existing = await Verification.find({ email }).lean();
      console.log(`[VERIFY_FAIL] ${email} existing:`, existing);
      return res.json({ success:false, error:'Invalid code' });
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

    return res.json({ success:true, user: { _id: user._id, email: user.email } });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success:false, error:'Server error' });
  }
});

// --- API: profile-setup (avatar base64 allowed) ---
app.post('/api/profile-setup', async (req,res) => {
  try {
    const sessionUserId = req.session.userId;
    if (!sessionUserId) return res.status(401).json({ success:false, error:'Not authenticated' });

    const { username, profilePhoto, nameColor, country } = req.body;
    const serverCode = country || countryFromIp(ipFromReq(req));

    const user = await User.findByIdAndUpdate(sessionUserId, {
      username: username || undefined,
      profilePhoto: profilePhoto || undefined,
      nameColor: nameColor || '#4285F4',
      country: country || undefined,
      server: serverCode,
      lastSeen: new Date()
    }, { new: true });

    req.session.userId = user._id.toString();
    return res.json({ success:true, user });
  } catch (err) {
    console.error('profile-setup error', err);
    return res.status(500).json({ success:false, error:'Server error' });
  }
});

// --- API: current user ---
app.get('/api/user', async (req,res) => {
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

// --- API: messages ---
app.get('/api/messages/:serverId', async (req,res) => {
  try {
    const messages = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: 1 })
      .limit(200);
    return res.json(messages);
  } catch (err) {
    console.error('api/messages error', err);
    return res.status(500).json({ error:'Server error' });
  }
});

// --- Logout ---
app.get('/logout', (req,res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Socket.io logic ---
// room -> set of socket ids
const roomUsers = new Map();
// socket.id -> meta { userId, serverId }
const socketMeta = new Map();

io.on('connection', (socket) => {
  // retrieve session userId if set
  const sess = socket.request.session || {};
  // join-server: payload { userId, serverId }
  socket.on('join-server', async (payload) => {
    try {
      const { userId, serverId } = payload || {};
      if (!serverId) return;
      socket.join(serverId);
      socketMeta.set(socket.id, { userId, serverId });

      if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Set());
      roomUsers.get(serverId).add(socket.id);

      io.to(serverId).emit('update-users', roomUsers.get(serverId).size);
    } catch (e) { console.error('join-server err', e); }
  });

  // send-message saves then emits to room (including sender)
  socket.on('send-message', async (data) => {
    try {
      // Validate
      if (!data || !data.serverId || !data.userId) return;
      const m = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date()
      });

      // emit saved message to all in room (includes sender)
      io.to(data.serverId).emit('new-message', m);
    } catch (err) {
      console.error('send-message error', err);
    }
  });

  // When a client informs server they saw a message
  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;
      if (!msg.seenBy.some(s => s.userId?.toString() === userId?.toString())) {
        msg.seenBy.push({ userId, seenAt: new Date() });
        await msg.save();
        // broadcast seen count update to room
        io.to(msg.serverId).emit('message-seen-update', { messageId: msg._id, seenCount: msg.seenBy.length });
      }
    } catch (err) { console.error('message-seen error', err); }
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
app.get('/', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
