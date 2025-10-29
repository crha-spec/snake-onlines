const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Render için CORS ayarı
const io = socketIo(server, {
  cors: {
    origin: ["https://your-app-name.onrender.com", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Basit bellek deposu (MongoDB olmadan)
const rooms = new Map();
const activeUsers = new Map();
const roomCodes = new Set();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (roomCodes.has(code));
  
  roomCodes.add(code);
  return code;
}

function generateColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
  const index = username ? username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : 0;
  return colors[index % colors.length];
}

// Socket.io bağlantısı
io.on('connection', (socket) => {
  console.log('🔗 Yeni bağlantı:', socket.id);

  socket.on('create-room', (data) => {
    try {
      const { userName, userPhoto, roomName, password } = data;
      
      if (!userName || !roomName) {
        socket.emit('error', { message: 'Kullanıcı adı ve oda adı gereklidir!' });
        return;
      }

      const roomCode = generateRoomCode();
      const userColor = generateColor(userName);

      // Odayı oluştur
      const room = {
        roomCode,
        roomName,
        ownerId: socket.id,
        password: password || null,
        participants: [],
        activeVideo: null,
        playbackState: {
          playing: false,
          currentTime: 0,
          playbackRate: 1
        },
        createdAt: new Date()
      };

      rooms.set(roomCode, room);

      // Kullanıcıyı kaydet
      const user = {
        id: socket.id,
        socketId: socket.id,
        userName,
        userPhoto: userPhoto || '',
        userColor,
        roomCode,
        isOwner: true,
        joinedAt: new Date()
      };

      activeUsers.set(socket.id, user);
      room.participants.push(user);
      socket.join(roomCode);

      console.log('✅ Oda oluşturuldu:', roomCode);
      
      // Başarılı yanıt gönder
      socket.emit('room-joined', {
        roomCode,
        roomName,
        isOwner: true,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor
      });

      // Kullanıcı listesini güncelle
      updateRoomUsers(roomCode);

    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı' });
    }
  });

  socket.on('join-room', (data) => {
    try {
      const { roomCode, userName, userPhoto, password } = data;
      
      if (!roomCode || !userName) {
        socket.emit('error', { message: 'Oda kodu ve kullanıcı adı gereklidir!' });
        return;
      }

      const room = rooms.get(roomCode.toUpperCase());
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı!' });
        return;
      }

      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Yanlış şifre!' });
        return;
      }

      const userColor = generateColor(userName);
      const user = {
        id: socket.id,
        socketId: socket.id,
        userName,
        userPhoto: userPhoto || '',
        userColor,
        roomCode: room.roomCode,
        isOwner: room.ownerId === socket.id,
        joinedAt: new Date()
      };

      activeUsers.set(socket.id, user);
      room.participants.push(user);
      socket.join(room.roomCode);

      socket.emit('room-joined', {
        roomCode: room.roomCode,
        roomName: room.roomName,
        isOwner: user.isOwner,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor
      });

      // Diğer kullanıcılara bildir
      socket.to(room.roomCode).emit('user-joined', {
        userName: user.userName
      });

      updateRoomUsers(room.roomCode);
      console.log(`✅ ${userName} odaya katıldı: ${room.roomCode}`);

    } catch (error) {
      console.error('❌ Katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılınamadı' });
    }
  });

  function updateRoomUsers(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const users = room.participants.map(user => ({
      userId: user.id,
      userName: user.userName,
      userPhoto: user.userPhoto,
      userColor: user.userColor,
      isOwner: user.isOwner
    }));

    io.to(roomCode).emit('user-list-update', users);
  }

  // Video kontrol
  socket.on('video-control', (controlData) => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.isOwner) return;

    const room = rooms.get(user.roomCode);
    if (room) {
      if (controlData.playing !== undefined) room.playbackState.playing = controlData.playing;
      if (controlData.currentTime !== undefined) room.playbackState.currentTime = controlData.currentTime;
      if (controlData.playbackRate !== undefined) room.playbackState.playbackRate = controlData.playbackRate;

      socket.to(user.roomCode).emit('video-control', controlData);
    }
  });

  // Mesaj
  socket.on('message', (messageData) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now().toString(),
      time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
      userName: user.userName,
      userPhoto: user.userPhoto,
      userColor: user.userColor,
      roomCode: user.roomCode,
      ...messageData
    };

    io.to(user.roomCode).emit('message', message);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomCode);
      if (room) {
        room.participants = room.participants.filter(p => p.id !== user.id);
        
        // Oda boşsa sil
        if (room.participants.length === 0) {
          rooms.delete(user.roomCode);
          roomCodes.delete(user.roomCode);
        } else {
          updateRoomUsers(user.roomCode);
          socket.to(user.roomCode).emit('user-left', { userName: user.userName });
        }
      }
      
      activeUsers.delete(socket.id);
      console.log(`🔌 ${user.userName} ayrıldı`);
    }
  });
});

// API Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    activeUsers: activeUsers.size,
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rooms', (req, res) => {
  const roomsList = Array.from(rooms.values()).map(room => ({
    roomCode: room.roomCode,
    roomName: room.roomName,
    participants: room.participants.length,
    createdAt: room.createdAt
  }));
  res.json(roomsList);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Render için PORT ayarı
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Render Sunucusu ${PORT} portunda çalışıyor`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`📱 Socket.io bağlantısı hazır`);
});
