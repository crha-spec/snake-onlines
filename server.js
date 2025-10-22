require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const geoip = require('geoip-lite');
const cors = require('cors');
const path = require('path');

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
app.use(passport.initialize());
app.use(passport.session());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, required: true },
  email: String,
  displayName: String,
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
  seenBy: [{ 
    userId: mongoose.Schema.Types.ObjectId, 
    seenAt: Date 
  }]
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Passport Google OAuth
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email: profile.emails[0].value,
        displayName: profile.displayName,
        profilePhoto: profile.photos[0].value
      });
    }
    
    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Routes
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/profile-setup');
  }
);

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

app.post('/api/profile-setup', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { username, profilePhoto, nameColor, country } = req.body;
    
    const user = await User.findByIdAndUpdate(req.user._id, {
      username,
      profilePhoto: profilePhoto || req.user.profilePhoto,
      nameColor,
      country,
      server: country
    }, { new: true });

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/detect-country', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const geo = geoip.lookup(ip);
  
  const countryNames = {
    'TR': 'Türkiye',
    'US': 'United States',
    'GB': 'United Kingdom',
    'DE': 'Deutschland',
    'FR': 'France',
    'KR': '대한민국',
    'JP': '日本',
    'CN': '中国'
  };
  
  const country = geo ? geo.country : 'TR';
  const countryName = countryNames[country] || country;
  
  res.json({ country, countryName });
});

app.get('/api/messages/:serverId', async (req, res) => {
  try {
    const messages = await Message.find({ serverId: req.params.serverId })
      .sort({ timestamp: -1 })
      .limit(100);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/logout', (req, res) => {
  req.logout(() => {
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
