require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: String,
  profilePhoto: String,
  nameColor: { type: String, default: '#4285F4' },
  country: String,
  server: String,
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});

const verificationSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true }
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
  seenBy: [{ 
    userId: mongoose.Schema.Types.ObjectId, 
    seenAt: Date 
  }]
});

const User = mongoose.model('User', userSchema);
const Verification = mongoose.model('Verification', verificationSchema);
const Message = mongoose.model('Message', messageSchema);

// Routes
app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 dakika geçerli

  await Verification.findOneAndUpdate(
    { email },
    { code, expiresAt },
    { upsert: true, new: true }
  );

  // TODO: Burada Vercel Email API ile kodu gönder
  console.log(`Verification code for ${email}: ${code}`);

  res.json({ success: true });
});

app.post('/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const record = await Verification.findOne({ email, code });
  
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ email });
  }

  req.session.userId = user._id;
  await record.deleteOne();

  res.json({ success: true, user });
});

app.get('/api/user', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await User.findById(req.session.userId);
  res.json({ user });
});

app.post('/api/profile-setup', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { username, profilePhoto, nameColor, country } = req.body;
  
  const user = await User.findByIdAndUpdate(req.session.userId, {
    username,
    profilePhoto,
    nameColor,
    country,
    server: country
  }, { new: true });

  res.json({ success: true, user });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
