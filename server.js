// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const path = require('path');
const geoip = require('geoip-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is required in .env');
  process.exit(1);
}

// ---------- MongoDB ----------
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

// ---------- Schemas ----------
const userSchema = new mongoose.Schema({
  email: { type: String, required: false, unique: false }, // may be undefined for quick guests
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

// ---------- Session ----------
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

// make session accessible in socket
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ---------- Middleware ----------
app.use(express.json({ limit: '5mb' })); // base64 avatar potentially large
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Mailer (optional) ----------
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
  console.log('ℹ️ SMTP not configured — verification codes will be printed to console and returned in dev responses.');
}

// ---------- Helpers ----------
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const normalizeEmail = e => (e || '').toString().trim().toLowerCase();
const ipToCountry = ip => {
  if (!ip) return 'TR';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  const g = geoip.lookup(ip);
  return (g && g.country) ? g.country : 'TR';
};
const serverForCountry = c => {
  const map = { TR:'TR', US:'US', GB:'GB', DE:'DE', FR:'FR', KR:'KR', JP:'JP', CN:'CN' };
  return map[c] || (c || 'TR');
};

// ---------- API: send verification code ----------
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
      console.log(`✉️ Sent code to ${email}`);
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

// ---------- API: verify code ----------
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    console.log(`[VERIFY ATTEMPT] ${email} / ${code} from ${req.ip}`);

    const rec = await Verification.findOne({ email, code });
    if (!rec) {
      const existing = await Verification.find({ email }).lean();
      console.log(`[VERIFY FAIL] ${email} existing:`, existing);
      return res.json({ success: false, error: 'Invalid code or expired' });
    }

    // create or find user
    let user = await User.findOne({ email });
    if (!user) {
      const usernameBase = email.split('@')[0];
      user = await User.create({
        email,
        username: usernameBase,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(usernameBase)}&background=667eea&color=fff`,
        nameColor: '#4285F4',
        country: ipToCountry(req.ip),
        server: serverForCountry(ipToCountry(req.ip))
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

// ---------- API: profile-setup (includes avatar upload as base64) ----------
app.post('/api/profile-setup', async (req, res) => {
  try {
    const sessionUserId = req.session.userId;
    if (!sessionUserId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const { username, profilePhoto, nameColor, country } = req.body;
    const serverCode = serverForCountry(country || ipToCountry(req.ip));

    const user = await User.findByIdAndUpdate(sessionUserId, {
      username: username || 'User',
      profilePhoto: profilePhoto || undefined,
      nameColor: nameColor || '#4285F4',
      country: country || ipToCountry(req.ip),
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
    const msgs = await Message.find({ serverId: req.params.serverId }).sort({ timestamp: 1 }).limit(200);
    return res.json(msgs);
  } catch (err) {
    console.error('api/messages error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- API: logout ----------
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Socket.io realtime ----------
// track sockets per room and mapping for seen counts
const rooms = new Map(); // room -> Set(socket.id)
const socketMeta = new Map(); // socket.id -> { userId, roomId }

io.on('connection', (socket) => {
  // joinCountry or join-server
  socket.on('joinCountry', async (payload) => {
    try {
      const ip = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
      const countryFromIp = ipToCountry(ip);
      const country = payload?.country || countryFromIp || 'TR';
      const serverId = serverForCountry(country);

      // attach meta
      const userId = socket.request.session?.userId || payload?.userId || null;
      const username = payload?.username || (socket.request.session?.email ? socket.request.session.email.split('@')[0] : ('User'+Math.floor(Math.random()*1000)));
      const profilePhoto = payload?.profilePhoto || (socket.request.session?.profilePhoto) || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`;
      const nameColor = payload?.nameColor || '#4285F4';

      socket.join(serverId);
      socketMeta.set(socket.id, { userId, roomId: serverId });

      if (!rooms.has(serverId)) rooms.set(serverId, new Set());
      rooms.get(serverId).add(socket.id);

      io.to(serverId).emit('update-users', rooms.get(serverId).size);

      // update user lastSeen/server in DB if userId present
      if (userId) {
        User.findByIdAndUpdate(userId, { lastSeen: new Date(), server: serverId }).catch(()=>{});
      }
    } catch (err) {
      console.error('joinCountry error', err);
    }
  });

  socket.on('join-server', async (payload) => {
    // backward compatibility: payload { userId, serverId, username, profilePhoto }
    try {
      const room = payload.serverId || payload.room || 'TR';
      const userId = payload.userId || socket.request.session?.userId || null;
      socket.join(room);
      socketMeta.set(socket.id, { userId, roomId: room });

      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(socket.id);
      io.to(room).emit('update-users', rooms.get(room).size);
      if (userId) User.findByIdAndUpdate(userId, { lastSeen: new Date(), server: room }).catch(()=>{});
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      // validate
      if (!data || !data.serverId || !data.message || !data.userId) return;
      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date()
      });

      // emit to entire room (including sender) — single authoritative emit
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

  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const updated = await Message.findByIdAndUpdate(messageId, { message: newMessage, edited: true, editedAt: new Date() }, { new: true });
      if (updated) io.to(updated.serverId).emit('message-edited', { messageId: updated._id, newMessage: updated.message });
    } catch (err) {
      console.error('edit-message error', err);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      const { roomId } = meta;
      socketMeta.delete(socket.id);
      if (rooms.has(roomId)) {
        rooms.get(roomId).delete(socket.id);
        io.to(roomId).emit('update-users', rooms.get(roomId).size);
      }
    } else {
      // try to remove from all rooms
      for (const [roomId, set] of rooms.entries()) {
        if (set.has(socket.id)) {
          set.delete(socket.id);
          io.to(roomId).emit('update-users', set.size);
        }
      }
    }
  });
});

// ---------- Frontend landing ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start ----------
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
