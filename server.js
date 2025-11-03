import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// Render optimizasyonları
app.set('trust proxy', 1); // Render proxy için
app.disable('x-powered-by'); // Güvenlik için

// CORS ayarları - Render için optimize
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [/\.onrender\.com$/, /\.vercel\.app$/] 
    : '*',
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Memory optimizasyonu
app.use(express.json({ 
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '50mb',
  parameterLimit: 10000
}));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : '0',
  etag: true,
  lastModified: true
}));

// Socket.io configuration - Render için optimize
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? [/\.onrender\.com$/, /\.vercel\.app$/] 
      : '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000, // Render için daha kısa ping aralığı
  connectTimeout: 30000,
  upgradeTimeout: 30000
});

// 🎯 MONGODB OLMADAN - BELLEK TABANLI SİSTEM
const rooms = new Map();
const users = new Map();
const messages = new Map();
const userTimeouts = new Map();

// Bellek optimizasyonu - düzenli temizlik
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const roomTimeout = 60 * 60 * 1000; // 1 saat
  const userTimeout = 30 * 60 * 1000; // 30 dakika
  
  // Boş odaları temizle
  for (const [roomCode, room] of rooms.entries()) {
    if (room.users.size === 0 && (now - room.lastActivity) > roomTimeout) {
      rooms.delete(roomCode);
      messages.delete(roomCode);
      console.log(`🧹 Inactive room cleaned: ${roomCode}`);
    }
  }
  
  // Timeout'ları temizle
  for (const [userId, timeout] of userTimeouts.entries()) {
    if (!users.has(userId)) {
      clearTimeout(timeout);
      userTimeouts.delete(userId);
    }
  }
}, 10 * 60 * 1000); // 10 dakikada bir

// Yardımcı fonksiyonlar
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateUserColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];
  const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
  return colors[index % colors.length];
}

function generateDefaultAvatar(username) {
  const firstLetter = username ? username.charAt(0).toUpperCase() : '?';
  const color = generateUserColor(username);
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="${color}"/><text x="50" y="60" font-family="Arial" font-size="40" text-anchor="middle" fill="white">${firstLetter}</text></svg>`;
}

function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function updateUserList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const userList = Array.from(room.users.values()).map(user => ({
    id: user.id,
    userName: user.userName,
    userPhoto: user.userPhoto,
    userColor: user.userColor,
    isOwner: user.isOwner,
    country: user.country
  }));
  
  io.to(roomCode).emit('user-list-update', userList);
}

function setupUserHeartbeat(socket) {
  if (userTimeouts.has(socket.id)) {
    clearTimeout(userTimeouts.get(socket.id));
  }

  const timeout = setTimeout(() => {
    console.log(`⏰ Timeout: ${socket.id} connection timed out`);
    if (socket.connected) {
      socket.disconnect(true);
    }
  }, 25 * 60 * 1000); // 25 dakika

  userTimeouts.set(socket.id, timeout);
}

// YouTube kontrol fonksiyonları
function handleYouTubeControl(socket, roomCode, controlData) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.playbackState = controlData;
  socket.to(roomCode).emit('youtube-control', controlData);
}

function handleYouTubeSeek(socket, roomCode, seekData) {
  const room = rooms.get(roomCode);
  if (!room) return;

  socket.to(roomCode).emit('youtube-seek', seekData);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('✅ New user connected:', socket.id);

  let currentUser = null;
  let currentRoomCode = null;

  // Heartbeat başlat
  setupUserHeartbeat(socket);

  // Ping-pong mekanizması
  socket.on('pong', () => {
    setupUserHeartbeat(socket);
  });

  // 🎯 ODA OLUŞTURMA
  socket.on('create-room', (data) => {
    try {
      console.log('🎯 Room creation request:', data);
      
      const { userName, userPhoto, deviceId, roomName, password } = data;
      
      if (!userName || !roomName) {
        socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' });
        return;
      }
      
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      console.log('🔑 New room code:', roomCode);
      
      const room = {
        code: roomCode,
        name: roomName,
        password: password || null,
        owner: socket.id,
        users: new Map(),
        video: null,
        playbackState: {
          playing: false,
          currentTime: 0,
          playbackRate: 1
        },
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date()
      };
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || generateDefaultAvatar(userName),
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        isOwner: true,
        country: 'Türkiye',
        lastPing: new Date()
      };
      
      room.users.set(socket.id, currentUser);
      rooms.set(roomCode, room);
      users.set(socket.id, { roomCode, ...currentUser });
      
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      const shareableLink = `${process.env.NODE_ENV === 'production' ? 'https://your-app.onrender.com' : 'http://localhost:10000'}?room=${roomCode}`;
      
      socket.emit('room-created', {
        roomCode: roomCode,
        roomName: roomName,
        isOwner: true,
        shareableLink: shareableLink,
        userColor: currentUser.userColor
      });
      
      console.log(`✅ ROOM CREATED SUCCESSFULLY: ${roomCode} - ${roomName}`);
      
    } catch (error) {
      console.error('❌ Room creation error:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı!' });
    }
  });

  // 🔑 ODAYA KATILMA
  socket.on('join-room', (data) => {
    try {
      const { roomCode, userName, userPhoto, deviceId, password } = data;
      const room = rooms.get(roomCode.toUpperCase());
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı!' });
        return;
      }
      
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Şifre yanlış!' });
        return;
      }
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || generateDefaultAvatar(userName),
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        isOwner: room.owner === socket.id,
        country: 'Türkiye',
        lastPing: new Date()
      };
      
      room.users.set(socket.id, currentUser);
      room.lastActivity = new Date();
      users.set(socket.id, { roomCode, ...currentUser });
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      const roomMessages = messages.get(roomCode) || [];
      
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: room.owner === socket.id,
        userColor: currentUser.userColor,
        previousMessages: roomMessages.slice(-50),
        activeVideo: room.video,
        playbackState: room.playbackState
      });
      
      socket.to(roomCode).emit('user-joined', {
        userName: currentUser.userName
      });
      
      updateUserList(roomCode);
      
      console.log(`✅ USER JOINED: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Join room error:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 YOUTUBE KONTROLÜ
  socket.on('youtube-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    console.log('🎮 YouTube control:', controlData);
    handleYouTubeControl(socket, currentRoomCode, controlData);
  });

  socket.on('youtube-seek', (seekData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    console.log('⏩ YouTube seek:', seekData);
    handleYouTubeSeek(socket, currentRoomCode, seekData);
  });

  // 🎮 VIDEO KONTROLÜ (normal video için)
  socket.on('video-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = controlData;
    room.lastActivity = new Date();
    
    socket.to(currentRoomCode).emit('video-control', controlData);
  });

  // 📞 WEBRTC GELİŞMİŞ AYARLAR
  socket.on('webrtc-offer', async (data) => {
    try {
      console.log('📞 WebRTC offer sending:', data.target);
      socket.to(data.target).emit('webrtc-offer', {
        offer: data.offer,
        caller: socket.id,
        callerName: currentUser?.userName,
        type: data.type
      });
    } catch (error) {
      console.error('❌ WebRTC offer sending error:', error);
    }
  });

  socket.on('webrtc-answer', async (data) => {
    try {
      console.log('📞 WebRTC answer sending:', data.target);
      socket.to(data.target).emit('webrtc-answer', {
        answer: data.answer,
        answerer: socket.id
      });
    } catch (error) {
      console.error('❌ WebRTC answer sending error:', error);
    }
  });

  socket.on('webrtc-ice-candidate', (data) => {
    try {
      socket.to(data.target).emit('webrtc-ice-candidate', {
        candidate: data.candidate
      });
    } catch (error) {
      console.error('❌ WebRTC ICE candidate sending error:', error);
    }
  });

  socket.on('webrtc-end-call', (data) => {
    try {
      socket.to(data.target).emit('webrtc-end-call');
    } catch (error) {
      console.error('❌ WebRTC end call sending error:', error);
    }
  });

  // 📨 MESAJ GÖNDERME
  socket.on('message', (messageData) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const room = rooms.get(currentRoomCode);
      if (room) room.lastActivity = new Date();
      
      const message = {
        id: Date.now().toString(),
        userName: currentUser.userName,
        userPhoto: currentUser.userPhoto,
        userColor: currentUser.userColor,
        text: messageData.text,
        type: messageData.type || 'text',
        fileUrl: messageData.fileUrl,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
        time: new Date().toLocaleTimeString('tr-TR', { 
          hour: '2-digit', 
          minute: '2-digit' 
        }),
        country: currentUser.country,
        timestamp: new Date()
      };
      
      const roomMessages = messages.get(currentRoomCode) || [];
      roomMessages.push(message);
      
      if (roomMessages.length > 100) {
        messages.set(currentRoomCode, roomMessages.slice(-100));
      } else {
        messages.set(currentRoomCode, roomMessages);
      }
      
      io.to(currentRoomCode).emit('message', message);
      
    } catch (error) {
      console.error('❌ Message sending error:', error);
    }
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 User disconnected:', socket.id, 'Reason:', reason);
    
    // Timeout'u temizle
    if (userTimeouts.has(socket.id)) {
      clearTimeout(userTimeouts.get(socket.id));
      userTimeouts.delete(socket.id);
    }
    
    if (currentUser && currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.users.delete(socket.id);
        users.delete(socket.id);
        
        socket.to(currentRoomCode).emit('user-left', {
          userName: currentUser.userName
        });
        
        updateUserList(currentRoomCode);
        
        // Oda boşsa temizle (30 dakika sonra)
        if (room.users.size === 0) {
          setTimeout(() => {
            if (rooms.get(currentRoomCode)?.users.size === 0) {
              rooms.delete(currentRoomCode);
              messages.delete(currentRoomCode);
              console.log(`🗑️ Empty room deleted: ${currentRoomCode}`);
            }
          }, 30 * 60 * 1000); // 30 dakika
        }
      }
    }
  });
});

// Ping gönderme
setInterval(() => {
  io.emit('ping');
}, 15000); // 15 saniyede bir ping

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    users: users.size,
    environment: process.env.NODE_ENV || 'development',
    features: {
      videoUpload: true,
      youtubeSharing: true,
      fileSharing: true,
      voiceMessages: true,
      videoCalls: true,
      realtimeChat: true,
      viewerRestrictions: true
    },
    memory: {
      rooms: rooms.size,
      users: users.size,
      messages: messages.size
    }
  });
});

app.get('/api/room/:code', (req, res) => {
  try {
    const room = rooms.get(req.params.code);
    if (!room) {
      return res.status(404).json({ error: 'Oda bulunamadı' });
    }
    
    res.json({
      code: room.code,
      name: room.name,
      userCount: room.users.size,
      createdAt: room.createdAt,
      hasPassword: !!room.password,
      joinUrl: `https://your-app.onrender.com?room=${room.code}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Oda bilgisi alınamadı' });
  }
});

// Static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  clearInterval(cleanupInterval);
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
  console.log(`🎯 RENDER OPTIMIZED - VIEWER RESTRICTIONS ACTIVE`);
  console.log(`📊 FEATURES:`);
  console.log(`   ✅ Oda Oluşturma/Katılma`);
  console.log(`   ✅ Video Yükleme & YouTube`);
  console.log(`   ✅ İzleyici Kısıtlamaları`);
  console.log(`   📞 Görüntülü/Sesli Arama`);
  console.log(`   💬 Gerçek Zamanlı Sohbet`);
  console.log(`   🔗 Oda Kodu Paylaşımı`);
  console.log(`   🧹 Otomatik Temizlik`);
});
