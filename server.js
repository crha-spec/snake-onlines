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
  .catch(err => {
    console.error('❌ MongoDB Error:', err);
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

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI }),
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 gün
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Middleware
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

// IP ve Ülke tespiti için API
async function getCountryFromIP(ip) {
  try {
    // Localhost için default değer
    if (ip === '::1' || ip === '127.0.0.1') return 'TR';
    
    const response = await fetch(`http://ip-api.com/json/${ip}`);
    const data = await response.json();
    return data.countryCode || 'TR';
  } catch (error) {
    console.error('IP detection error:', error);
    return 'TR';
  }
}

// API: Oturum kontrolü - ÖNEMLİ DEĞİŞİKLİK
app.get('/api/check-session', async (req, res) => {
  try {
    console.log('🔍 Checking session for userId:', req.session.userId);
    
    if (!req.session.userId) {
      console.log('❌ No session found');
      return res.json({ authenticated: false });
    }

    const user = await User.findById(req.session.userId);
    if (!user) {
      console.log('❌ User not found in DB');
      req.session.destroy();
      return res.json({ authenticated: false });
    }

    console.log('✅ Session valid for user:', user.email);
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
      }
    });
  } catch (err) {
    console.error('check-session error', err);
    return res.json({ authenticated: false });
  }
});

// API: Çıkış
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Logout failed' });
    }
    res.json({ success: true });
  });
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

// API: verify-code (IP tespiti eklendi)
app.post('/api/verify-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    const clientIP = req.ip || req.connection.remoteAddress;
    
    console.log('📡 IP Address:', clientIP);
    
    if (!email || !code) return res.json({ success: false, error: 'Missing fields' });

    const record = await Verification.findOne({ email, code });
    if (!record) return res.json({ success: false, error: 'Invalid code' });

    // IP'den ülke tespiti
    const country = await getCountryFromIP(clientIP);
    console.log('🌍 Detected country:', country);

    let user = await User.findOne({ email });
    if (!user) {
      const username = email.split('@')[0];
      user = await User.create({
        email,
        username,
        profilePhoto: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff`,
        nameColor: '#4285F4',
        country: country,
        server: country
      });
    } else {
      // Mevcut kullanıcıyı güncelle
      user.country = country;
      user.server = country;
      await user.save();
    }

    // ÖNEMLİ: Session oluştur - 30 gün hatırlasın
    req.session.userId = user._id.toString();
    req.session.email = email;

    await Verification.deleteMany({ email });

    return res.json({ 
      success: true, 
      user: { 
        _id: user._id, 
        email: user.email,
        username: user.username,
        country: country 
      } 
    });
  } catch (err) {
    console.error('verify-code error', err);
    return res.json({ success: false, error: 'Server error' });
  }
});

// API: profile-setup
app.post('/api/profile-setup', async (req, res) => {
  try {
    const { username, profilePhoto, nameColor } = req.body;
    const sessionUserId = req.session.userId;

    if (!sessionUserId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const user = await User.findByIdAndUpdate(
      sessionUserId,
      {
        username: username || 'User',
        profilePhoto: profilePhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(username || 'User')}`,
        nameColor: nameColor || '#4285F4'
      },
      { new: true }
    );

    return res.json({ success: true, user });
  } catch (err) {
    console.error('profile-setup error', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: Mesaj düzenleme
app.put('/api/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { newMessage, userId } = req.body;
    
    if (!req.session.userId || req.session.userId !== userId) {
      return res.status(401).json({ success: false, error: 'Not authorized' });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    if (message.userId.toString() !== userId) {
      return res.status(403).json({ success: false, error: 'Can only edit your own messages' });
    }

    message.message = newMessage;
    message.edited = true;
    message.editedAt = new Date();
    
    await message.save();

    // Düzenlenen mesajı tüm kullanıcılara bildir
    io.to(message.serverId).emit('message-edited', {
      messageId: message._id,
      newMessage: message.message,
      editedAt: message.editedAt
    });

    return res.json({ success: true, message });
  } catch (err) {
    console.error('edit-message error', err);
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
  console.log('✅ User connected:', socket.id);

  socket.on('join-server', async (payload) => {
    const { serverId, userId } = payload;
    if (!serverId) return;

    socket.join(serverId);
    
    if (!roomUsers.has(serverId)) roomUsers.set(serverId, new Map());
    roomUsers.get(serverId).set(socket.id, userId);
    
    io.to(serverId).emit('update-users', roomUsers.get(serverId).size);
    
    // Kullanıcı katıldığında tüm mesajları görüldü olarak işaretle
    try {
      const messages = await Message.find({ serverId });
      for (const msg of messages) {
        if (!msg.seenBy.some(s => s.userId?.toString() === userId)) {
          const user = await User.findById(userId);
          msg.seenBy.push({ 
            userId, 
            username: user?.username || 'User',
            seenAt: new Date() 
          });
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
      console.log('📨 Sending message:', data);
      
      // ÖNCE mesajı istemciye göster (gecikme olmasın)
      const tempMessage = {
        _id: 'temp-' + Date.now(),
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date(),
        seenBy: [{
          userId: data.userId,
          username: data.username,
          seenAt: new Date()
        }],
        seenCount: 1,
        isTemp: true
      };
      
      // Mesajı hemen göster (gecikme olmasın)
      socket.emit('new-message', tempMessage);
      
      // Sonra DB'ye kaydet ve herkese gönder
      const msg = await Message.create({
        serverId: data.serverId,
        userId: data.userId,
        username: data.username,
        nameColor: data.nameColor,
        profilePhoto: data.profilePhoto,
        message: data.message,
        timestamp: new Date(),
        seenBy: [{
          userId: data.userId,
          username: data.username,
          seenAt: new Date()
        }]
      });
      
      console.log('✅ Message saved to DB:', msg._id);
      
      const messageWithSeen = {
        ...msg.toObject(),
        seenCount: 1,
        seenBy: [{
          userId: data.userId,
          username: data.username,
          seenAt: new Date()
        }]
      };
      
      // Temp mesajı gerçek mesajla değiştir
      socket.emit('message-replaced', {
        tempId: tempMessage._id,
        realMessage: messageWithSeen
      });
      
      // Diğer kullanıcılara gerçek mesajı gönder
      socket.to(data.serverId).emit('new-message', messageWithSeen);
      
    } catch (err) {
      console.error('send-message error', err);
      // Hata durumunda temp mesajı kaldır
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
        msg.seenBy.push({ 
          userId, 
          username: user.username,
          seenAt: new Date() 
        });
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

  // Mesaj düzenleme socket event'i
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
    socket.to(data.serverId).emit('user-typing', {
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('typing-stop', (data) => {
    socket.to(data.serverId).emit('user-stop-typing', {
      userId: data.userId
    });
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

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
