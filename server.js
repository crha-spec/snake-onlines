require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const geoip = require('geoip-lite');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  // optional mongoose options
})
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Session (store in MongoDB)
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Email transporter (use SMTP credentials in .env)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: (process.env.EMAIL_SECURE === 'true'),
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Models
const userSchema = new mongoose.Schema({
  // googleId removed (we won't require it)
  googleId: { type: String, unique: false, sparse: true, default: null },
  email: { type: String, index: true, required: true, unique: true },
  displayName: String,
  username: { type: String, index: true },
  profilePhoto: String,
  nameColor: { type: String, default: '#4285F4' },
  country: String,
  server: String,
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  passwordHash: String // optional if later you add password flow
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
  codeHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  used: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// Helpers
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { error: 'Too many requests, slow down.' }
});

// Routes: email verification start
app.post('/auth/email/start', authLimiter, async (req, res) => {
  try {
    const { email, displayName } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const ttlMinutes = Number(process.env.VERIFICATION_CODE_TTL_MINUTES || 15);
    const code = generateCode();
    const salt = await bcrypt.genSalt(10);
    const codeHash = await bcrypt.hash(code, salt);

    // mark previous unused verifications used
    await Verification.updateMany({ email, used: false }, { used: true }).catch(()=>{});

    const v = await Verification.create({
      email,
      codeHash,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
      attempts: 0,
      used: false
    });

    // send email (best effort; do not leak whether email exists)
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: email,
      subject: 'Doğrulama Kodu - Your verification code',
      text: `Doğrulama kodunuz: ${code}\nKod ${ttlMinutes} dakika içinde geçersiz olacaktır.`,
      html: `<p>Doğrulama kodunuz: <b>${code}</b></p><p>Kod ${ttlMinutes} dakika içinde geçersiz olacaktır.</p>`
    };

    await transporter.sendMail(mailOptions).catch(err => {
      console.error('Mail send error (non-fatal):', err);
      // continue — we still created verification in DB
    });

    return res.json({ success: true, message: 'Verification code sent if the email exists.' });
  } catch (err) {
    console.error('Email start error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Routes: verify code and create/login user
app.post('/auth/email/verify', authLimiter, async (req, res) => {
  try {
    const { email, code, username, profilePhoto, nameColor, country } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const v = await Verification.findOne({ email, used: false }).sort({ createdAt: -1 });
    if (!v) return res.status(400).json({ error: 'No verification request found' });

    if (v.expiresAt < new Date()) {
      v.used = true;
      await v.save();
      return res.status(400).json({ error: 'Code expired' });
    }

    v.attempts = (v.attempts || 0) + 1;
    if (v.attempts > 5) {
      v.used = true;
      await v.save();
      return res.status(429).json({ error: 'Too many attempts' });
    }

    const ok = await bcrypt.compare(code, v.codeHash);
    if (!ok) {
      await v.save();
      return res.status(400).json({ error: 'Invalid code' });
    }

    // successful
    v.used = true;
    await v.save();

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        googleId: null,
        email,
        displayName: username || email.split('@')[0],
        username: username || email.split('@')[0],
        profilePhoto: profilePhoto || '',
        nameColor: nameColor || '#4285F4',
        country: country || ''
      });
    }

    // create session
    req.session.userId = user._id.toString();
    await new Promise((r, rej) => req.session.save(err => err ? rej(err) : r()));

    return res.json({ success: true, user });
  } catch (err) {
    console.error('Email verify error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Basic auth status route
app.get('/api/user', (req, res) => {
  if (req.session && req.session.userId) {
    User.findById(req.session.userId).then(user => {
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      return res.json({ user });
    }).catch(err => res.status(500).json({ error: 'Internal error' }));
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Existing endpoints (detect-country, messages) — unchanged
app.get('/api/detect-country', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const geo = geoip.lookup(ip);
  const countryNames = {
    'TR': 'Türkiye','US':'United States','GB':'United Kingdom','DE':'Deutschland','FR':'France','KR':'대한민국','JP':'日本','CN':'中国'
  };
  const country = geo ? geo.country : 'TR';
  const countryName = countryNames[country] || country;
  res.json({ country, countryName });
});

app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const messages = await Message.find({ serverId: req.params.serverId }).sort({ timestamp: -1 }).limit(100);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io logic (unchanged behaviour; client still emits join-server with userId)
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('join-server', async ({ userId, serverId }) => {
    try {
      socket.join(serverId);
      onlineUsers.set(userId, { socketId: socket.id, serverId });
      await User.findByIdAndUpdate(userId, { lastSeen: new Date() });
      io.to(serverId).emit('user-count', {
        count: Array.from(onlineUsers.values()).filter(u => u.serverId === serverId).length
      });
    } catch (err) {
      console.error('join-server error', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      const message = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message
      });

      io.to(data.serverId).emit('new-message', {
        _id: message._id,
        username: message.username,
        nameColor: message.nameColor,
        profilePhoto: message.profilePhoto,
        message: message.message,
        timestamp: message.timestamp,
        seenBy: []
      });
    } catch (error) {
      console.error('Message error:', error);
    }
  });

  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const message = await Message.findByIdAndUpdate(messageId, {
        message: newMessage,
        edited: true,
        editedAt: new Date()
      }, { new: true });

      io.to(message.serverId).emit('message-edited', {
        messageId,
        newMessage,
        edited: true
      });
    } catch (error) {
      console.error('Edit error:', error);
    }
  });

  socket.on('typing', (data) => {
    socket.to(data.serverId).emit('user-typing', {
      username: data.username,
      isTyping: data.isTyping
    });
  });

  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message.seenBy.some(s => s.userId.toString() === userId)) {
        message.seenBy.push({ userId, seenAt: new Date() });
        await message.save();

        io.to(message.serverId).emit('message-seen-update', {
          messageId,
          seenCount: message.seenBy.length
        });
      }
    } catch (error) {
      console.error('Seen error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    for (const [userId, userData] of onlineUsers.entries()) {
      if (userData.socketId === socket.id) {
        const serverId = userData.serverId;
        onlineUsers.delete(userId);
        io.to(serverId).emit('user-count', {
          count: Array.from(onlineUsers.values()).filter(u => u.serverId === serverId).length
        });
        break;
      }
    }
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
