require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passwordHash: String,
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

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Simple Email Verification Logic (demo)
const emailCodes = new Map();

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Send verification code
app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email gerekli' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  emailCodes.set(email, code);

  console.log(`🔑 Verification code for ${email}: ${code}`);
  // Burada gerçek email gönderimi eklenebilir (Vercel veya başka servis ile)
  
  res.json({ success: true });
});

// Verify code and create account
app.post('/api/verify-code', async (req, res) => {
  const { email, code, username, password } = req.body;
  const savedCode = emailCodes.get(email);

  if (!savedCode || savedCode !== code) {
    return res.status(400).json({ error: 'Kod yanlış veya süresi dolmuş' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    let user = await User.findOne({ email });
    
    if (!user) {
      user = await User.create({
        email,
        passwordHash,
        username,
        server: 'TR'
      });
    }

    req.session.userId = user._id;
    emailCodes.delete(email);

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profile Setup
app.post('/api/profile-setup', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { username, profilePhoto, nameColor, country } = req.body;
  try {
    const user = await User.findByIdAndUpdate(userId, {
      username,
      profilePhoto,
      nameColor,
      country,
      server: country
    }, { new: true });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user
app.get('/api/user', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const user = await User.findById(userId);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Chat routes
app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const messages = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: -1 })
      .limit(100);
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('join-server', async ({ userId, serverId }) => {
    socket.join(serverId);
    onlineUsers.set(userId, { socketId: socket.id, serverId });
    await User.findByIdAndUpdate(userId, { lastSeen: new Date() });

    io.to(serverId).emit('user-count', {
      count: Array.from(onlineUsers.values()).filter(u => u.serverId === serverId).length
    });
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
    } catch (err) {
      console.error(err);
    }
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
    } catch (err) {
      console.error(err);
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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
