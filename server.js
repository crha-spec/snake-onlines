require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');
const ADMIN_IP = '151.250.2.67';

// MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  });

// Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: String,
  profilePhoto: String,
  nameColor: { type: String, default: '#4285F4' },
  country: String,
  server: String,
  deviceSessions: [{
    deviceId: String,
    sessionId: String,
    lastActive: Date
  }],
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
  edited: { type: Boolean, default: false },
  editedAt: Date,
  seenBy: [{ 
    userId: mongoose.Schema.Types.ObjectId, 
    username: String,
    seenAt: Date 
  }]
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

// ✅ GELİŞTİRİLMİŞ SESSION YÖNETİMİ
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: MONGODB_URI,
    ttl: 24 * 60 * 60 // 24 saat
  }),
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 24 saat
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  },
  genid: (req) => {
    // Her cihaz için unique session ID
    const deviceId = req.headers['user-agent'] + '-' + Date.now();
    return crypto.createHash('md5').update(deviceId).digest('hex');
  }
}));

// IP tespiti
app.use((req, res, next) => {
  const forwarded = req.headers['x-forwarded-for'];
  req.clientIP = forwarded ? forwarded.split(',')[0] : req.connection.remoteAddress;
  
  if (req.clientIP === '::1' || req.clientIP === '::ffff:127.0.0.1') {
    req.clientIP = '127.0.0.1';
  }
  
  // Device ID oluştur
  req.deviceId = crypto.createHash('md5').update(req.headers['user-agent'] + req.clientIP).digest('hex');
  
  console.log('📱 Device:', req.deviceId, 'IP:', req.clientIP);
  next();
});

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Mail
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// Helpers
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

async function getCountryFromIP(ip) {
  try {
    if (ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return 'TR';
    }
    const response = await fetch(`http://ip-api.com/json/${ip}`);
    const data = await response.json();
    return data.countryCode || 'TR';
  } catch (error) {
    return 'TR';
  }
}

function isAdmin(ip) {
  return ip === ADMIN_IP;
}

// ✅ YENİ: Device-based session kontrolü
app.get('/api/check-session', async (req, res) => {
  try {
    console.log('🔍 Session check - Device:', req.deviceId);
    
    if (!req.session.userId) {
      console.log('❌ No session found for device');
      return res.json({ authenticated: false });
    }

    const user = await User.findById(req.session.userId);
    if (!user) {
      console.log('❌ User not found in DB');
      req.session.destroy();
      return res.json({ authenticated: false });
    }

    // Device session kaydını güncelle
    const deviceSessionIndex = user.deviceSessions.findIndex(ds => ds.deviceId === req.deviceId);
    if (deviceSessionIndex === -1) {
      user.deviceSessions.push({
        deviceId: req.deviceId,
        sessionId: req.sessionID,
        lastActive: new Date()
      });
    } else {
      user.deviceSessions[deviceSessionIndex].lastActive = new Date();
    }
    await user.save();

    console.log('✅ User authenticated:', user.email);
    return res.json({ 
      authenticated: true, 
      user: {
        _id: user._id,
        email: user.email,
        username: user.username,
        profilePhoto: user.profilePhoto,
        nameColor: user.nameColor,
        country: user.country,
        server: user.server
      },
      isAdmin: isAdmin(req.clientIP)
    });
  } catch (err) {
    console.error('check-session error:', err);
    return res.json({ authenticated: false });
  }
});

// API: Çıkış
app.post('/api/logout', async (req, res) => {
  try {
    if (req.session.userId) {
      // Device session'ını temizle
      const user = await User.findById(req.session.userId);
      if (user) {
        user.deviceSessions = user.deviceSessions.filter(ds => ds.deviceId !== req.deviceId);
        await user.save();
      }
    }
    
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  } catch (err) {
    console.error('Logout error:', err);
    req.session.destroy();
    res.json({ success: true });
  }
});

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
      return res.json({ success: true });
    } else {
      console.log(`[DEV] Code for ${email}: ${code}`);
      return res.json({ success: true, devCode: code });
    }
  } catch (err) {
    console.error('send-code error:', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ✅ GELİŞTİRİLMİŞ: verify-code (Device session kaydı)
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    const clientIP = req.clientIP;
    
    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    const record = await Verification.findOne({ email, code });
    if (!record) return res.json({ success: false, error: 'Invalid code' });

    const country = await getCountryFromIP(clientIP);

    let user = await User.findOne({ email });
    if (!user) {
      const username = email.split('@')[0];
      user = await User.create({
        email,
        username,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`,
        nameColor: '#4285F4',
        country: country,
        server: country,
        deviceSessions: [{
          deviceId: req.deviceId,
          sessionId: req.sessionID,
          lastActive: new Date()
        }]
      });
    } else {
      user.country = country;
      user.server = country;
      
      // Mevcut device session kontrolü
      const existingDeviceSession = user.deviceSessions.find(ds => ds.deviceId === req.deviceId);
      if (!existingDeviceSession) {
        user.deviceSessions.push({
          deviceId: req.deviceId,
          sessionId: req.sessionID,
          lastActive: new Date()
        });
      }
      await user.save();
    }

    // Session oluştur
    req.session.userId = user._id.toString();
    req.session.email = email;
    req.session.deviceId = req.deviceId;

    // Session'ı hemen kaydet
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await Verification.deleteMany({ email });

    console.log('✅ Login successful for device:', req.deviceId);
    return res.json({ 
      success: true, 
      user: { 
        _id: user._id, 
        email: user.email,
        username: user.username,
        country: country 
      },
      isAdmin: isAdmin(clientIP)
    });
  } catch (err) {
    console.error('verify-code error:', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// ✅ GELİŞTİRİLMİŞ: profile-setup (Session kontrolü)
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor } = req.body;
    const sessionUserId = req.session.userId;

    console.log('👤 Profile setup - Device:', req.deviceId, 'User:', sessionUserId);

    if (!sessionUserId) {
      console.log('❌ No session in profile setup');
      return res.status(401).json({ success: false, error: 'Oturum açılmamış. Lütfen tekrar giriş yapın.' });
    }

    const user = await User.findById(sessionUserId);
    if (!user) {
      console.log('❌ User not found in profile setup');
      req.session.destroy();
      return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı. Lütfen tekrar giriş yapın.' });
    }

    // Device session kontrolü
    const deviceSession = user.deviceSessions.find(ds => ds.deviceId === req.deviceId);
    if (!deviceSession) {
      console.log('❌ Device session not found');
      req.session.destroy();
      return res.status(401).json({ success: false, error: 'Cihaz oturumu bulunamadı. Lütfen tekrar giriş yapın.' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      sessionUserId,
      {
        username: username || 'User',
        profilePhoto: profilePhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}`,
        nameColor: nameColor || '#4285F4'
      },
      { new: true }
    );

    // Session'ı güncelle
    req.session.userId = updatedUser._id.toString();
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log('✅ Profile updated successfully for device:', req.deviceId);
    return res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('profile-setup error:', err);
    return res.status(500).json({ success: false, error: 'Sunucu hatası. Lütfen tekrar deneyin.' });
  }
});

// Diğer API routes (kısaltılmış)
app.put('/api/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { newMessage, userId } = req.body;
    
    if (!req.session.userId || req.session.userId !== userId) {
      return res.status(401).json({ success: false, error: 'Not authorized' });
    }

    const message = await Message.findById(messageId);
    if (!message || message.userId.toString() !== userId) {
      return res.status(403).json({ success: false, error: 'Can only edit your own messages' });
    }

    message.message = newMessage;
    message.edited = true;
    message.editedAt = new Date();
    await message.save();

    io.to(message.serverId).emit('message-edited', {
      messageId: message._id,
      newMessage: message.message,
      editedAt: message.editedAt
    });

    return res.json({ success: true, message });
  } catch (err) {
    console.error('edit-message error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { userId } = req.body;
    const clientIP = req.clientIP;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const isUserAdmin = isAdmin(clientIP);
    const isOwnMessage = message.userId.toString() === userId;

    if (!isUserAdmin && !isOwnMessage) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this message' });
    }

    await Message.findByIdAndDelete(messageId);
    io.to(message.serverId).emit('message-deleted', { messageId: message._id });

    return res.json({ success: true });
  } catch (err) {
    console.error('delete-message error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.delete('/api/messages', async (req, res) => {
  try {
    const clientIP = req.clientIP;
    const { serverId } = req.body;

    if (!isAdmin(clientIP)) {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Server ID required' });
    }

    const result = await Message.deleteMany({ serverId });
    io.to(serverId).emit('all-messages-cleared');

    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('clear-all-messages error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/user', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    return res.json({ user, isAdmin: isAdmin(req.clientIP) });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    deviceId: req.deviceId,
    session: !!req.session.userId,
    ip: req.clientIP
  });
});

// Socket.io
const roomUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('join-server', async (payload) => {
    const { serverId, userId } = payload;
    if (!serverId) return;

    socket.join(serverId);
    
    if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Map());
    roomUsers.get(serverId).set(socket.id, userId);
    
    io.to(serverId).emit('update-users', roomUsers.get(serverId).size);
    
    try {
      const messages = await Message.find({ serverId });
      for (const msg of messages) {
        if (!msg.seenBy.some(s => s.userId?.toString() === userId)) {
          const user = await User.findById(userId);
          msg.seenBy.push({ userId, username: user?.username || 'User', seenAt: new Date() });
          await msg.save();
          io.to(serverId).emit('message-seen-update', { 
            messageId: msg._id, 
            seenCount: msg.seenBy.length,
            seenBy: msg.seenBy 
          });
        }
      }
    } catch (err) {
      console.error('Mark messages as seen error:', err);
    }
  });

  socket.on('send-message', async (data) => {
    try {
      const tempMessage = {
        _id: 'temp-' + Date.now(),
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date(),
        seenBy: [{ userId: data.userId, username: data.username, seenAt: new Date() }],
        seenCount: 1,
        isTemp: true
      };
      
      socket.emit('new-message', tempMessage);
      
      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date(),
        seenBy: [{ userId: data.userId, username: data.username, seenAt: new Date() }]
      });
      
      const messageWithSeen = { ...msg.toObject(), seenCount: 1 };
      
      socket.emit('message-replaced', {
        tempId: tempMessage._id,
        realMessage: messageWithSeen
      });
      
      socket.to(data.serverId).emit('new-message', messageWithSeen);
      
    } catch (err) {
      console.error('send-message error', err);
      socket.emit('message-failed', { tempId: 'temp-' + Date.now() });
    }
  });

  socket.on('message-seen', async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;
      
      const user = await User.findById(userId);
      if (!user) return;

      if (!msg.seenBy.some(s => s.userId?.toString() === userId?.toString())) {
        msg.seenBy.push({ userId, username: user.username, seenAt: new Date() });
        await msg.save();
        io.to(msg.serverId).emit('message-seen-update', { 
          messageId: msg._id, 
          seenCount: msg.seenBy.length,
          seenBy: msg.seenBy 
        });
      }
    } catch (err) {
      console.error('message-seen error', err);
    }
  });

  socket.on('edit-message', async (data) => {
    try {
      const { messageId, newMessage, userId } = data;
      const message = await Message.findById(messageId);
      
      if (!message || message.userId.toString() !== userId) {
        socket.emit('edit-message-error', { error: 'Not authorized' });
        return;
      }

      message.message = newMessage;
      message.edited = true;
      message.editedAt = new Date();
      await message.save();

      io.to(message.serverId).emit('message-edited', {
        messageId: message._id,
        newMessage: message.message,
        editedAt: message.editedAt
      });

    } catch (err) {
      console.error('edit-message socket error', err);
      socket.emit('edit-message-error', { error: 'Server error' });
    }
  });

  socket.on('typing-start', (data) => {
    socket.to(data.serverId).emit('user-typing', { userId: data.userId, username: data.username });
  });

  socket.on('typing-stop', (data) => {
    socket.to(data.serverId).emit('user-stop-typing', { userId: data.userId });
  });

  socket.on('disconnect', () => {
    for (const [serverId, users] of roomUsers) {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        io.to(serverId).emit('update-users', users.size);
        break;
      }
    }
    console.log('❌ User disconnected:', socket.id);
  });
});

// Serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Multi-device support: ENABLED`);
});
