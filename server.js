const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Render için CORS ayarları
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Oda yönetimi
const rooms = new Map();
const users = new Map();

// Yardımcı fonksiyonlar
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function sanitizeUser(user) {
  return {
    id: user.id,
    userName: user.userName,
    userPhoto: user.userPhoto,
    userColor: user.userColor,
    isOwner: user.isOwner,
    country: user.country || 'Türkiye',
    deviceId: user.deviceId
  };
}

function getRoomByCode(roomCode) {
  return rooms.get(roomCode);
}

function createRoom(roomName, password, owner) {
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    name: roomName,
    password: password,
    owner: owner.id,
    users: new Map(),
    activeVideo: null,
    playbackState: {
      playing: false,
      currentTime: 0,
      playbackRate: 1
    },
    createdAt: new Date()
  };
  
  room.users.set(owner.id, owner);
  rooms.set(roomCode, room);
  
  return room;
}

// Socket.io bağlantı yönetimi
io.on('connection', (socket) => {
  console.log('🔗 Yeni kullanıcı bağlandı:', socket.id);

  let currentUser = null;
  let currentRoom = null;

  // Oda oluşturma
  socket.on('create-room', (data) => {
    try {
      const { userName, userPhoto, deviceId, roomName, password } = data;
      
      // Kullanıcı oluştur
      currentUser = {
        id: socket.id,
        userName: userName || 'Anonim',
        userPhoto: userPhoto,
        userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
        deviceId: deviceId,
        isOwner: true,
        country: 'Türkiye'
      };
      
      users.set(socket.id, currentUser);
      
      // Oda oluştur
      const room = createRoom(roomName, password, currentUser);
      currentRoom = room;
      
      socket.join(room.code);
      
      // Başarılı yanıt
      socket.emit('room-created', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: true
      });
      
      // Odaya katıldı mesajı
      socket.to(room.code).emit('user-joined', {
        userName: currentUser.userName
      });
      
      // Kullanıcı listesini güncelle
      updateUserList(room);
      
      console.log(`✅ Oda oluşturuldu: ${room.code} - ${room.name}`);
      
    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı' });
    }
  });

  // Odaya katılma
  socket.on('join-room', (data) => {
    try {
      const { roomCode, userName, userPhoto, deviceId, password } = data;
      
      const room = getRoomByCode(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı' });
        return;
      }
      
      // Şifre kontrolü
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Geçersiz şifre' });
        return;
      }
      
      // Kullanıcı oluştur
      currentUser = {
        id: socket.id,
        userName: userName || 'Anonim',
        userPhoto: userPhoto,
        userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
        deviceId: deviceId,
        isOwner: false,
        country: 'Türkiye'
      };
      
      users.set(socket.id, currentUser);
      room.users.set(socket.id, currentUser);
      currentRoom = room;
      
      socket.join(room.code);
      
      // Başarılı yanıt
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: false,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: currentUser.userColor
      });
      
      // Diğer kullanıcılara bildir
      socket.to(room.code).emit('user-joined', {
        userName: currentUser.userName
      });
      
      // Kullanıcı listesini güncelle
      updateUserList(room);
      
      console.log(`✅ Kullanıcı odaya katıldı: ${userName} -> ${room.code}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı' });
    }
  });

  // Video yükleme
  socket.on('upload-video', (data) => {
    try {
      if (!currentRoom || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
        return;
      }
      
      const { videoBase64, title } = data;
      
      // Base64 verisini doğrudan kullan
      const videoData = {
        url: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      currentRoom.activeVideo = videoData;
      currentRoom.playbackState = {
        playing: false,
        currentTime: 0,
        playbackRate: 1
      };
      
      // Tüm kullanıcılara video yüklendiğini bildir
      io.to(currentRoom.code).emit('video-uploaded', {
        videoUrl: videoData.url,
        title: videoData.title
      });
      
      console.log(`🎬 Video yüklendi: ${title} -> ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Video yükleme hatası:', error);
      socket.emit('error', { message: 'Video yüklenemedi' });
    }
  });

  // Video kontrolü
  socket.on('video-control', (controlData) => {
    if (!currentRoom || !currentUser || !currentUser.isOwner) return;
    
    currentRoom.playbackState = {
      playing: controlData.playing,
      currentTime: controlData.currentTime,
      playbackRate: controlData.playbackRate
    };
    
    // Oda sahibi dışındaki herkese kontrol bilgilerini gönder
    socket.to(currentRoom.code).emit('video-control', controlData);
  });

  // Video silme
  socket.on('delete-video', () => {
    if (!currentRoom || !currentUser || !currentUser.isOwner) return;
    
    currentRoom.activeVideo = null;
    currentRoom.playbackState = {
      playing: false,
      currentTime: 0,
      playbackRate: 1
    };
    
    io.to(currentRoom.code).emit('video-deleted');
  });

  // Mesaj gönderme
  socket.on('message', (messageData) => {
    if (!currentRoom || !currentUser) return;
    
    const message = {
      id: crypto.randomBytes(8).toString('hex'),
      userName: currentUser.userName,
      userPhoto: currentUser.userPhoto,
      userColor: currentUser.userColor,
      text: messageData.text,
      type: messageData.type || 'text',
      time: new Date().toLocaleTimeString('tr-TR', { 
        hour: '2-digit', 
        minute: '2-digit' 
      }),
      country: currentUser.country
    };
    
    io.to(currentRoom.code).emit('message', message);
  });

  // Kullanıcı listesini güncelleme fonksiyonu
  function updateUserList(room) {
    const userList = Array.from(room.users.values()).map(user => sanitizeUser(user));
    io.to(room.code).emit('user-list-update', userList);
  }

  // Bağlantı kesildiğinde
  socket.on('disconnect', () => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id);
    
    if (currentRoom && currentUser) {
      // Kullanıcıyı odadan çıkar
      currentRoom.users.delete(socket.id);
      
      // Diğer kullanıcılara bildir
      socket.to(currentRoom.code).emit('user-left', {
        userName: currentUser.userName
      });
      
      // Eğer oda sahibi ayrıldıysa ve odada kimse kalmadıysa odayı temizle
      if (currentUser.isOwner && currentRoom.users.size === 0) {
        rooms.delete(currentRoom.code);
        console.log(`🗑️ Oda silindi: ${currentRoom.code}`);
      } else if (currentRoom.users.size > 0) {
        // Kullanıcı listesini güncelle
        updateUserList(currentRoom);
      }
    }
    
    // Kullanıcıyı temizle
    users.delete(socket.id);
  });

  // Hata yönetimi
  socket.on('error', (error) => {
    console.error('❌ Socket hatası:', error);
  });
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    users: users.size
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    code: room.code,
    name: room.name,
    userCount: room.users.size,
    hasPassword: !!room.password,
    createdAt: room.createdAt
  }));
  res.json(roomList);
});

// Static files (Render için)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Başlatma
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(() => {
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
