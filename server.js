const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// 🎯 GELİŞMİŞ BELLEK YÖNETİMİ
const rooms = new Map();
const users = new Map();
const messages = new Map();
const userTimeouts = new Map();

// Socket.io configuration - GELİŞMİŞ AYARLAR
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingTimeout: 60000, // 60 saniye
  pingInterval: 10000, // 10 saniyede bir ping
  connectTimeout: 30000
});

// Bağlantı izleme sistemi
function setupUserHeartbeat(socket) {
  // Mevcut timeout'u temizle
  if (userTimeouts.has(socket.id)) {
    clearTimeout(userTimeouts.get(socket.id));
  }

  // Yeni timeout ayarla (25 dakika)
  const timeout = setTimeout(() => {
    console.log(`⏰ Timeout: ${socket.id} bağlantısı kesildi`);
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

  // Playback state'i güncelle
  room.playbackState = controlData;

  // Diğer kullanıcılara gönder (oda sahibi hariç)
  socket.to(roomCode).emit('youtube-control', controlData);
}

function handleYouTubeSeek(socket, roomCode, seekData) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Seek bilgisini diğer kullanıcılara gönder (oda sahibi hariç)
  socket.to(roomCode).emit('youtube-seek', seekData);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('✅ Yeni kullanıcı bağlandı:', socket.id);

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
      
      const shareableLink = `${process.env.NODE_ENV === 'production' ? 'https://snake-onlines-xe9h.onrender.com' : 'http://localhost:10000'}?room=${roomCode}`;
      
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
      
      console.log(`✅ KULLANICI KATILDI: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 YOUTUBE KONTROLÜ
  socket.on('youtube-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    console.log('🎮 YouTube kontrolü:', controlData);
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
      console.log('📞 WebRTC offer gönderiliyor:', data.target);
      socket.to(data.target).emit('webrtc-offer', {
        offer: data.offer,
        caller: socket.id,
        callerName: currentUser?.userName,
        type: data.type
      });
    } catch (error) {
      console.error('❌ WebRTC offer gönderme hatası:', error);
    }
  });

  socket.on('webrtc-answer', async (data) => {
    try {
      console.log('📞 WebRTC answer gönderiliyor:', data.target);
      socket.to(data.target).emit('webrtc-answer', {
        answer: data.answer,
        answerer: socket.id
      });
    } catch (error) {
      console.error('❌ WebRTC answer gönderme hatası:', error);
    }
  });

  socket.on('webrtc-ice-candidate', (data) => {
    try {
      socket.to(data.target).emit('webrtc-ice-candidate', {
        candidate: data.candidate
      });
    } catch (error) {
      console.error('❌ WebRTC ICE candidate gönderme hatası:', error);
    }
  });

  socket.on('webrtc-end-call', (data) => {
    try {
      socket.to(data.target).emit('webrtc-end-call');
    } catch (error) {
      console.error('❌ WebRTC end call gönderme hatası:', error);
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
      console.error('❌ Mesaj gönderme hatası:', error);
    }
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', reason);
    
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
              console.log(`🗑️ Boş oda silindi: ${currentRoomCode}`);
            }
          }, 30 * 60 * 1000); // 30 dakika
        }
      }
    }
  });
});

// Düzenli temizlik
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 30 * 60 * 1000; // 30 dakika
  
  for (const [roomCode, room] of rooms.entries()) {
    if (room.users.size === 0 && (now - room.lastActivity) > inactiveThreshold) {
      rooms.delete(roomCode);
      messages.delete(roomCode);
      console.log(`🧹 Inactive oda temizlendi: ${roomCode}`);
    }
  }
}, 10 * 60 * 1000); // 10 dakikada bir kontrol et

// Ping gönderme
setInterval(() => {
  io.emit('ping');
}, 15000); // 15 saniyede bir ping

// API Routes (mevcut kod aynı)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    users: users.size,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Static files (mevcut kod aynı)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
  console.log(`🎯 GELİŞMİŞ ÖZELLİKLER:`);
  console.log(`   ✅ YouTube Sync Kontrolü`);
  console.log(`   ✅ Gelişmiş WebRTC`);
  console.log(`   ✅ Bağlantı İzleme Sistemi`);
  console.log(`   ✅ Otomatik Yeniden Bağlanma`);
  console.log(`   ✅ 25 Dakika Timeout`);
});
