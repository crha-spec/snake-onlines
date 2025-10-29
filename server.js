const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// 🎯 MONGODB OLMADAN - BELLEK TABANLI SİSTEM
const rooms = new Map();      // Tüm odalar
const users = new Map();      // Tüm kullanıcılar
const messages = new Map();   // Tüm mesajlar (oda bazlı)

// Socket.io configuration - BÜYÜK DOSYA DESTEĞİ
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB dosya desteği
});

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

// Middleware - BÜYÜK DOSYA DESTEĞİ
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('✅ Yeni kullanıcı bağlandı:', socket.id);

  let currentUser = null;
  let currentRoomCode = null;

  // 🎯 ODA OLUŞTURMA - BASİT ve GARANTİ
  socket.on('create-room', (data) => {
    try {
      console.log('🎯 Oda oluşturma isteği:', data);
      
      const { userName, userPhoto, deviceId, roomName, password } = data;
      
      // Validasyon
      if (!userName || !roomName) {
        socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' });
        return;
      }
      
      // Benzersiz oda kodu oluştur
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      console.log('🔑 Yeni oda kodu:', roomCode);
      
      // Oda oluştur
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
        createdAt: new Date()
      };
      
      // Kullanıcı oluştur
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || generateDefaultAvatar(userName),
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        isOwner: true,
        country: 'Türkiye'
      };
      
      // Belleğe kaydet
      room.users.set(socket.id, currentUser);
      rooms.set(roomCode, room);
      users.set(socket.id, { roomCode, ...currentUser });
      
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      // Paylaşım linki oluştur
      const shareableLink = `${process.env.NODE_ENV === 'production' ? 'https://snake-onlines-xe9h.onrender.com' : 'http://localhost:10000'}?room=${roomCode}`;
      
      // BAŞARILI CEVAP
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
      
      // Şifre kontrolü
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Şifre yanlış!' });
        return;
      }
      
      // Kullanıcı oluştur
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || generateDefaultAvatar(userName),
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        isOwner: room.owner === socket.id,
        country: 'Türkiye'
      };
      
      // Belleğe kaydet
      room.users.set(socket.id, currentUser);
      users.set(socket.id, { roomCode, ...currentUser });
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      // Geçmiş mesajları getir
      const roomMessages = messages.get(roomCode) || [];
      
      // Başarılı cevap
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: room.owner === socket.id,
        userColor: currentUser.userColor,
        previousMessages: roomMessages.slice(-50),
        activeVideo: room.video,
        playbackState: room.playbackState
      });
      
      // Diğer kullanıcılara bildir
      socket.to(roomCode).emit('user-joined', {
        userName: currentUser.userName
      });
      
      // Kullanıcı listesini güncelle
      updateUserList(roomCode);
      
      console.log(`✅ KULLANICI KATILDI: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 VIDEO YÜKLEME
  socket.on('upload-video', (data) => {
    try {
      if (!currentRoomCode || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
        return;
      }
      
      const { videoBase64, title, fileSize } = data;
      const room = rooms.get(currentRoomCode);
      
      console.log(`🎬 Video yükleniyor: ${title}`);
      
      // Progress bildirimi
      socket.emit('upload-progress', { status: 'uploading', progress: 50 });
      
      // Odaya video bilgisini kaydet
      room.video = {
        url: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      // Tüm kullanıcılara bildir
      io.to(currentRoomCode).emit('video-uploaded', {
        videoUrl: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName
      });
      
      socket.emit('upload-progress', { status: 'completed', progress: 100 });
      
      console.log(`✅ VIDEO YÜKLENDI: ${title} -> ${currentRoomCode}`);
      
    } catch (error) {
      console.error('❌ Video yükleme hatası:', error);
      socket.emit('upload-progress', { status: 'error', progress: 0 });
      socket.emit('error', { message: 'Video yüklenemedi!' });
    }
  });

  // 📺 YOUTUBE VIDEO PAYLAŞMA
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
      
      // Odaya YouTube video bilgisini kaydet
      room.video = {
        type: 'youtube',
        videoId: videoId,
        url: youtubeUrl,
        title: title || 'YouTube Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      // Tüm kullanıcılara bildir
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

  // 🎮 VIDEO KONTROLÜ
  socket.on('video-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = controlData;
    
    socket.to(currentRoomCode).emit('video-control', controlData);
  });

  // 🗑️ VIDEO SİLME
  socket.on('delete-video', () => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.video = null;
    
    io.to(currentRoomCode).emit('video-deleted');
    console.log(`🗑️ Video silindi: ${currentRoomCode}`);
  });

  // 📨 MESAJ GÖNDERME - TÜM DOSYA TÜRLERİ DESTEĞİ
  socket.on('message', (messageData) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      console.log('💬 Mesaj gönderiliyor:', messageData.type || 'text');
      
      // Mesajı hazırla
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
      
      // Belleğe kaydet
      const roomMessages = messages.get(currentRoomCode) || [];
      roomMessages.push(message);
      
      // Son 100 mesajı sakla
      if (roomMessages.length > 100) {
        messages.set(currentRoomCode, roomMessages.slice(-100));
      } else {
        messages.set(currentRoomCode, roomMessages);
      }
      
      // Tüm kullanıcılara gönder
      io.to(currentRoomCode).emit('message', message);
      
      console.log('✅ Mesaj gönderildi:', messageData.type || 'text');
      
    } catch (error) {
      console.error('❌ Mesaj gönderme hatası:', error);
    }
  });

  // 📞 WEBRTC GÖRÜNTÜLÜ/SESLİ ARAMA
  socket.on('webrtc-offer', (data) => {
    socket.to(data.target).emit('webrtc-offer', {
      offer: data.offer,
      caller: socket.id,
      callerName: currentUser?.userName
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.target).emit('webrtc-answer', {
      answer: data.answer,
      answerer: socket.id
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.target).emit('webrtc-ice-candidate', {
      candidate: data.candidate
    });
  });

  socket.on('webrtc-end-call', (data) => {
    socket.to(data.target).emit('webrtc-end-call');
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', reason);
    
    if (currentUser && currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.users.delete(socket.id);
        users.delete(socket.id);
        
        socket.to(currentRoomCode).emit('user-left', {
          userName: currentUser.userName
        });
        
        updateUserList(currentRoomCode);
        
        // Oda boşsa temizle (5 dakika sonra)
        if (room.users.size === 0) {
          setTimeout(() => {
            if (rooms.get(currentRoomCode)?.users.size === 0) {
              rooms.delete(currentRoomCode);
              messages.delete(currentRoomCode);
              console.log(`🗑️ Boş oda silindi: ${currentRoomCode}`);
            }
          }, 300000); // 5 dakika
        }
      }
    }
  });
});

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
      realtimeChat: true
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
      joinUrl: `https://snake-onlines-xe9h.onrender.com?room=${room.code}`
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

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER ${PORT} PORTUNDA ÇALIŞIYOR`);
  console.log(`🎯 MONGODB OLMADAN - BELLEK TABANLI`);
  console.log(`📸 ÖZELLİKLER:`);
  console.log(`   ✅ Oda Oluşturma/Katılma`);
  console.log(`   ✅ Video Yükleme & YouTube`);
  console.log(`   ✅ Fotoğraf Paylaşımı (50MB)`);
  console.log(`   ✅ Ses Kaydı & Dosya Paylaşımı`);
  console.log(`   📞 Görüntülü/Sesli Arama`);
  console.log(`   💬 Gerçek Zamanlı Sohbet`);
  console.log(`   🔗 Oda Kodu Paylaşımı`);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(() => {
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
