// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Config / Env validation ----
const {
  MONGODB_URI,
  SESSION_SECRET,
  PORT,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  DEBUG_SHOW_CODE
} = process.env;

if (!MONGODB_URI) {
  console.error('MONGODB_URI missing in .env');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET missing in .env');
  process.exit(1);
}

// ---- MongoDB ----
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  });

// ---- Session store ----
const sessionStore = MongoStore.create({
  mongoUrl: MONGODB_URI,
  collectionName: 'sessions'
});

app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ---- Models ----
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: String,
  profilePhoto: String,
  nameColor: { type: String, default: '#4285F4' },
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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
const Message = mongoose.model('Message', messageSchema);

// Verification codes: auto-delete after TTL (300 seconds)
const verificationSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: { expires: 300 } } // 5 minutes TTL
});
const Verification = mongoose.model('Verification', verificationSchema);

// ---- Nodemailer transporter (if configured) ----
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  // quick verify (non-blocking)
  transporter.verify().then(() => console.log('✅ SMTP transporter ready')).catch(err => {
    console.warn('⚠️ SMTP transporter verify failed:', err.message || err);
  });
} else {
  console.log('ℹ️ SMTP not configured — mail will fallback to console.log');
}

// ---- Utility ----
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}
async function hashCode(code) {
  const salt = await bcrypt.genSalt(8);
  return bcrypt.hash(code, salt);
}
async function compareCode(code, hash) {
  return bcrypt.compare(code, hash);
}

// ---- API: send-code ----
app.post('/api/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') return res.status(400).json({ success: false, message: 'Invalid email' });

    const code = generateCode();
    const codeHash = await hashCode(code);

    // Remove existing verifications for email, then create new
    await Verification.deleteMany({ email });
    await Verification.create({ email, codeHash });

    // send mail if possible
    if (transporter) {
      try {
        await transporter.sendMail({
          from: `${process.env.SMTP_USER}`,
          to: email,
          subject: 'Doğrulama Kodunuz',
          text: `Doğrulama kodunuz: ${code}`,
          html: `<p>Doğrulama kodunuz: <strong>${code}</strong></p>`
        });
        console.log(`Kod gönderildi (mail): ${email}`);
      } catch (err) {
        console.error('Mail gönderirken hata:', err);
      }
    } else {
      // fallback: print code on server console (for dev/demo)
      console.log(`DEV CODE for ${email}: ${code}`);
    }

    // If DEBUG_SHOW_CODE true, return code in response (ONLY for local/dev demo)
    if (String(DEBUG_SHOW_CODE).toLowerCase() === 'true') {
      return res.json({ success: true, debug: true, code });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('send-code error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ---- API: verify-code ----
app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Missing email or code' });

    const v = await Verification.findOne({ email });
    if (!v) return res.status(400).json({ success: false, message: 'No code found or expired' });

    const ok = await compareCode(code, v.codeHash);
    if (!ok) return res.status(400).json({ success: false, message: 'Code invalid' });

    // code correct: create / find user & set session
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ email, username: email.split('@')[0] });
    }
    req.session.userId = user._id.toString();
    await Verification.deleteMany({ email }); // single-use

    return res.json({ success: true, user });
  } catch (err) {
    console.error('verify-code error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ---- API: profile-setup ----
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor, server } = req.body;
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.username = username || user.username;
    user.profilePhoto = profilePhoto || user.profilePhoto;
    user.nameColor = nameColor || user.nameColor;
    await user.save();

    return res.json({ success: true, user });
  } catch (err) {
    console.error('profile-setup error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ---- API: get current user ----
app.get('/api/user', async (req, res) => {
  try {
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ success: false, message: 'Not authenticated' });
    const user = await User.findById(uid);
    return res.json({ success: true, user });
  } catch (err) {
    console.error('api/user error:', err);
    return res.status(500).json({ success: false });
  }
});

// ---- API: messages history ----
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const messages = await Message.find({ serverId }).sort({ timestamp: -1 }).limit(200);
    return res.json({ success: true, messages: messages.reverse() });
  } catch (err) {
    console.error('api/messages error:', err);
    return res.status(500).json({ success: false });
  }
});

// ---- Logout ----
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('session destroy err', err);
    res.redirect('/');
  });
});

// ---- Socket.io ----
const onlineUsers = new Map(); // userId => { socketId, serverId }

io.use((socket, next) => {
  // simple middleware example: if you want cookie-session integration later
  next();
});

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  socket.on('join-server', async ({ userId, serverId }) => {
    try {
      socket.join(serverId);
      onlineUsers.set(userId, { socketId: socket.id, serverId });
      await User.findByIdAndUpdate(userId, { lastSeen: new Date() });

      const onlineCount = Array.from(onlineUsers.values()).filter(u => u.serverId === serverId).length;
      io.to(serverId).emit('user-count', { count: onlineCount });
    } catch (err) {
      console.error('join-server err', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      const message = await Message.create({
        serverId: data.serverId || 'global',
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message
      });

      io.to(message.serverId).emit('new-message', {
        _id: message._id,
        serverId: message.serverId,
        userId: message.userId,
        username: message.username,
        nameColor: message.nameColor,
        profilePhoto: message.profilePhoto,
        message: message.message,
        timestamp: message.timestamp,
        seenBy: []
      });
    } catch (err) {
      console.error('send-message err', err);
    }
  });

  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const m = await Message.findByIdAndUpdate(messageId, { message: newMessage, edited: true, editedAt: new Date() }, { new: true });
      io.to(m.serverId).emit('message-edited', { messageId: m._id, newMessage: m.message });
    } catch (err) {
      console.error('edit-message err', err);
    }
  });

  socket.on('typing', (data) => {
    socket.to(data.serverId).emit('user-typing', { username: data.username, isTyping: data.isTyping });
  });

  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;
      if (!message.seenBy.some(s => s.userId.toString() === userId)) {
        message.seenBy.push({ userId, seenAt: new Date() });
        await message.save();
        io.to(message.serverId).emit('message-seen-update', { messageId, seenCount: message.seenBy.length });
      }
    } catch (err) {
      console.error('message-seen err', err);
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, val] of onlineUsers.entries()) {
      if (val.socketId === socket.id) {
        const serverId = val.serverId;
        onlineUsers.delete(userId);
        const onlineCount = Array.from(onlineUsers.values()).filter(u => u.serverId === serverId).length;
        io.to(serverId).emit('user-count', { count: onlineCount });
        break;
      }
    }
    console.log('Socket disconnected:', socket.id);
  });
});

// ---- Start server ----
const PORT_TO_USE = Number(PORT) || 3000;
server.listen(PORT_TO_USE, () => console.log(`🚀 Server running on port ${PORT_TO_USE}`));
