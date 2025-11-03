import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// ✅ WEBSOCKET BAĞLANTI SORUNU ÇÖZÜMÜ
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingTimeout: 60000, // 60 saniye
  pingInterval: 25000, // 25 saniye
  connectTimeout: 45000, // 45 saniye
  transports: ['websocket', 'polling'] // İkisini de kullan
});

const PORT = process.env.PORT || 10000;

// 🎯 BELLEK TABANLI VERİ YAPILARI
const rooms = new Map();
const users = new Map();
const messages = new Map();
const connections = new Map(); // Bağlantı takibi

// 🕐 BAĞLANTI KONTROL SİSTEMİ
const connectionWatchdog = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [socketId, lastActivity] of connectionWatchdog.entries()) {
    // 30 dakika aktivite yoksa bağlantıyı temizle
    if (now - lastActivity > 30 * 60 * 1000) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        console.log(`🕐 Uzun süre aktivite yok, bağlantı temizleniyor: ${socketId}`);
        socket.disconnect(true);
      }
      connectionWatchdog.delete(socketId);
    }
  }
}, 60000); // Her 1 dakikada bir kontrol et

// ✅ YARDIMCI FONKSİYONLAR
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

// ✅ WEBRTC ICE SERVER KONFİGÜRASYONU (UZAK BAĞLANTI İÇİN)
const rtcConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Fallback STUN sunucuları
    { urls: 'stun:stun.voiparound.com' },
    { urls: 'stun:stun.voipbuster.com' },
    { urls: 'stun:stun.voipstunt.com' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// ✅ ORTAK KONTROL SİSTEMİ (ADMIN KONTROLÜ)
function syncVideoToAll(roomCode, controlData) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // Video durumunu oda hafızasında sakla
  room.playbackState = controlData;
  
  // Tüm kullanıcılara senkronize et (oda sahibi hariç)
  socket.to(roomCode).emit('video-control', controlData);
}

// ✅ YOUTUBE API KONTROLÜ
function setupYouTubeSync(roomCode, videoId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // YouTube player kontrolü için özel event
  room.youTubeSync = {
    videoId: videoId,
    lastState: room.playbackState
  };
}

// ✅ BAĞLANTI SAĞLIK KONTROLÜ
function setupConnectionHealth(socket, roomCode) {
  const healthInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('connection-health-check');
      connectionWatchdog.set(socket.id, Date.now());
    } else {
      clearInterval(healthInterval);
    }
  }, 15000); // 15 saniyede bir health check

  socket.on('connection-health-response', () => {
    connectionWatchdog.set(socket.id, Date.now());
  });

  socket.on('disconnect', () => {
    clearInterval(healthInterval);
    connectionWatchdog.delete(socket.id);
  });
}

// ✅ MIDDLEWARE
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ✅ SOCKET.IO BAĞLANTI YÖNETİMİ
io.on('connection', (socket) => {
  console.log('✅ Yeni kullanıcı bağlandı:', socket.id);
  connectionWatchdog.set(socket.id, Date.now());

  let currentUser = null;
  let currentRoomCode = null;

  // 🎯 BAĞLANTI SAĞLIK KONTROLÜNÜ BAŞLAT
  setupConnectionHealth(socket, currentRoomCode);

  // 🎯 ODA OLUŞTURMA
  socket.on('create-room', (data) => {
    try {
      console.log('🎯 Oda oluşturma isteği:', data);
      
      const { userName, userPhoto, deviceId, roomName, password } = data;
      
      if (!userName || !roomName) {
        socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' });
        return;
      }
      
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      console.log('🔑 Yeni oda kodu:', roomCode);
      
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
          playbackRate: 1,
          duration: 0
        },
        youTubeSync: null,
        messages: [],
        createdAt: new Date()
      };
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || generateDefaultAvatar(userName),
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        isOwner: true,
        country: 'Türkiye'
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
      
      console.log(`✅ ODA BAŞARIYLA OLUŞTURULDU: ${roomCode} - ${roomName}`);
      
    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
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
        country: 'Türkiye'
      };
      
      room.users.set(socket.id, currentUser);
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
        playbackState: room.playbackState,
        rtcConfig: rtcConfiguration // ✅ WEBRTC config gönder
      });
      
      socket.to(roomCode).emit('user-joined', {
        userName: currentUser.userName
      });
      
      updateUserList(roomCode);
      
      console.log(`✅ KULLANICI KATILDI: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 YOUTUBE VIDEO PAYLAŞMA
  socket.on('share-youtube-link', (data) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const { youtubeUrl, title } = data;
      const videoId = extractYouTubeId(youtubeUrl);
      const room = rooms.get(currentRoomCode);
      
      if (!videoId) {
        socket.emit('error', { message: 'Geçersiz YouTube linki' });
        return;
      }
      
      room.video = {
        type: 'youtube',
        videoId: videoId,
        url: youtubeUrl,
        title: title || 'YouTube Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      // YouTube senkronizasyonunu başlat
      setupYouTubeSync(currentRoomCode, videoId);
      
      // Tüm kullanıcılara bildir (SADECE video bilgisi)
      io.to(currentRoomCode).emit('youtube-video-shared', {
        videoId: videoId,
        title: title || 'YouTube Video',
        sharedBy: currentUser.userName
      });
      
      console.log(`🎬 YouTube video paylaşıldı: ${videoId} -> ${currentRoomCode}`);
      
    } catch (error) {
      console.error('❌ YouTube video paylaşma hatası:', error);
      socket.emit('error', { message: 'YouTube video paylaşılamadı!' });
    }
  });

  // 🎮 VIDEO KONTROLÜ (ADMIN İÇİN)
  socket.on('video-control', (controlData) => {
    if (!currentRoomCode || !currentUser) return;
    
    const room = rooms.get(currentRoomCode);
    if (!room || !currentUser.isOwner) return;
    
    console.log('🎮 Video kontrolü:', controlData);
    
    // Video durumunu güncelle
    room.playbackState = {
      ...room.playbackState,
      ...controlData
    };
    
    // Tüm izleyicilere senkronize et (admin hariç)
    socket.to(currentRoomCode).emit('video-control', room.playbackState);
  });

  // 📨 MESAJ GÖNDERME
  socket.on('message', (messageData) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
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
      connectionWatchdog.set(socket.id, Date.now());
      
    } catch (error) {
      console.error('❌ Mesaj gönderme hatası:', error);
    }
  });

  // 📞 WEBRTC GÖRÜNTÜLÜ/SESLİ ARAMA - GELİŞMİŞ
  socket.on('webrtc-offer', (data) => {
    console.log('📞 WebRTC Offer gönderiliyor:', data.target);
    socket.to(data.target).emit('webrtc-offer', {
      offer: data.offer,
      caller: socket.id,
      callerName: currentUser?.userName,
      rtcConfig: rtcConfiguration, // ✅ Config gönder
      type: data.type
    });
  });

  socket.on('webrtc-answer', (data) => {
    console.log('📞 WebRTC Answer gönderiliyor:', data.target);
    socket.to(data.target).emit('webrtc-answer', {
      answer: data.answer,
      answerer: socket.id
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.target).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });

  socket.on('webrtc-end-call', (data) => {
    socket.to(data.target).emit('webrtc-end-call', {
      endedBy: currentUser?.userName
    });
  });

  // ✅ BAĞLANTI SAĞLIK KONTROLÜ
  socket.on('connection-health-response', () => {
    connectionWatchdog.set(socket.id, Date.now());
  });

  socket.on('client-heartbeat', () => {
    connectionWatchdog.set(socket.id, Date.now());
    socket.emit('server-heartbeat', { timestamp: Date.now() });
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', reason);
    connectionWatchdog.delete(socket.id);
    
    if (currentUser && currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.users.delete(socket.id);
        users.delete(socket.id);
        
        socket.to(currentRoomCode).emit('user-left', {
          userName: currentUser.userName
        });
        
        updateUserList(currentRoomCode);
        
        if (room.users.size === 0) {
          setTimeout(() => {
            if (rooms.get(currentRoomCode)?.users.size === 0) {
              rooms.delete(currentRoomCode);
              messages.delete(currentRoomCode);
              console.log(`🗑️ Boş oda silindi: ${currentRoomCode}`);
            }
          }, 300000);
        }
      }
    }
  });
});

// ✅ API ROUTES
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    users: users.size,
    connections: connectionWatchdog.size,
    environment: process.env.NODE_ENV || 'development'
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
      createdAt: room.createdAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Oda bilgisi alınamadı' });
  }
});

// ✅ STATIC FILES
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ SERVER BAŞLATMA
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
  console.log(`✅ WEBRTC UZAK BAĞLANTI DESTEĞİ AKTİF`);
  console.log(`✅ YOUTUBE SENKRONİZASYONU AKTİF`);
  console.log(`✅ BAĞLANTI SAĞLIK KONTROLÜ AKTİF`);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(() => {
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
