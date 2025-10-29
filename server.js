const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(cors());
app.use(express.static('public'));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dxpi8bapd',
  api_key: process.env.CLOUDINARY_API_KEY || '976283781598975',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'Orqu1ukmjx76NZIsDHH_TsDnDJ0'
});

// MongoDB bağlantısı
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Admin:efkaza7634@cluster0.dcuzvid.mongodb.net/video-platform?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB bağlantısı başarılı'))
  .catch(err => {
    console.log('❌ MongoDB bağlantı hatası:', err.message);
    console.log('⚠️  Uygulama MongoDB olmadan çalışıyor');
  });

// Şemalar
const userProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  userPhoto: { type: String, default: '' },
  deviceId: { type: String, required: true },
  country: { type: String, default: 'Türkiye' },
  lastSeen: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  roomCode: { type: String, required: true, unique: true },
  roomName: { type: String, required: true },
  ownerId: { type: String, required: true },
  ownerName: String,
  password: String,
  activeVideo: {
    url: String,
    cloudinaryId: String,
    title: String,
    duration: Number,
    uploadedAt: Date
  },
  playbackState: {
    playing: { type: Boolean, default: false },
    currentTime: { type: Number, default: 0 },
    playbackRate: { type: Number, default: 1 },
    timestamp: { type: Date, default: Date.now }
  },
  participants: [{
    userId: String,
    userName: String,
    userPhoto: String,
    userColor: String,
    country: String,
    joinedAt: Date
  }],
  maxParticipants: { type: Number, default: 50 },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userPhoto: String,
  userColor: String,
  country: String,
  roomCode: { type: String, required: true },
  text: String,
  type: { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now }
});

const UserProfile = mongoose.model('UserProfile', userProfileSchema);
const Room = mongoose.model('Room', roomSchema);
const Message = mongoose.model('Message', messageSchema);

// Bellek deposu
const rooms = new Map();
const activeUsers = new Map();

// Yardımcı fonksiyonlar
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];
  const index = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[index % colors.length];
}

async function getOrCreateUserProfile(userData) {
  try {
    let userProfile = await UserProfile.findOne({ userId: userData.userId });
    
    if (!userProfile) {
      userProfile = new UserProfile({
        userId: userData.userId,
        userName: userData.userName,
        userPhoto: userData.userPhoto || '',
        deviceId: userData.deviceId,
        country: userData.country || 'Türkiye'
      });
      await userProfile.save();
    } else {
      userProfile.userName = userData.userName;
      userProfile.userPhoto = userData.userPhoto || userProfile.userPhoto;
      userProfile.lastSeen = new Date();
      await userProfile.save();
    }
    return userProfile;
  } catch (error) {
    console.error('❌ Profil hatası:', error);
    return userData;
  }
}

function updateRoomUsers(roomCode) {
  if (!rooms.has(roomCode)) return;
  const roomUsers = Array.from(rooms.get(roomCode))
    .map(socketId => activeUsers.get(socketId))
    .filter(user => user !== undefined)
    .map(user => ({
      userId: user.id,
      userName: user.userName,
      userPhoto: user.userPhoto,
      userColor: user.userColor,
      country: user.country,
      isOwner: user.isOwner
    }));
  io.to(roomCode).emit('user-list-update', roomUsers);
}

// Socket.io
io.on('connection', async (socket) => {
  console.log('🔗 Yeni bağlantı:', socket.id);

  let heartbeatInterval = setInterval(() => socket.emit('ping'), 20000);
  socket.on('pong', () => {});

  // Oda oluştur
  socket.on('create-room', async (data) => {
    try {
      const { userName, userPhoto, deviceId, roomName, password } = data;
      const userProfile = await getOrCreateUserProfile({ 
        userId: socket.id, 
        userName, 
        userPhoto, 
        deviceId 
      });
      
      let roomCode;
      let attempts = 0;
      do { 
        roomCode = generateRoomCode(); 
        attempts++;
        if (attempts > 10) throw new Error('Oda kodu oluşturulamadı');
      } while (await Room.findOne({ roomCode }));
      
      const room = new Room({
        roomCode,
        roomName: roomName || `${userName}'in Odası`,
        ownerId: userProfile.userId,
        ownerName: userName,
        password: password || null
      });
      await room.save();

      console.log('✅ Oda oluşturuldu:', roomCode);
      
      const user = {
        id: userProfile.userId,
        socketId: socket.id,
        userName: userProfile.userName,
        userPhoto: userProfile.userPhoto,
        userColor: generateColor(userProfile.userName),
        country: userProfile.country,
        deviceId: deviceId,
        roomCode: room.roomCode,
        isOwner: true,
        joinedAt: new Date()
      };

      activeUsers.set(socket.id, user);
      if (!rooms.has(room.roomCode)) rooms.set(room.roomCode, new Set());
      rooms.get(room.roomCode).add(socket.id);
      socket.join(room.roomCode);

      room.participants.push({
        userId: user.id,
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        country: user.country,
        joinedAt: new Date()
      });
      await room.save();

      socket.emit('room-joined', {
        roomCode: room.roomCode,
        roomName: room.roomName,
        isOwner: true,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: user.userColor
      });

      updateRoomUsers(room.roomCode);
      console.log(`✅ ${user.userName} odayı oluşturdu: ${room.roomCode}`);

    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı: ' + error.message });
    }
  });

  // Odaya katıl
  socket.on('join-room', async (data) => {
    try {
      const { roomCode, userName, userPhoto, deviceId, password } = data;
      const room = await Room.findOne({ roomCode: roomCode.toUpperCase() });
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı!' });
        return;
      }

      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Yanlış şifre!' });
        return;
      }

      if (room.participants.length >= room.maxParticipants) {
        socket.emit('error', { message: 'Oda dolu! Max ' + room.maxParticipants + ' kişi' });
        return;
      }

      const userProfile = await getOrCreateUserProfile({ 
        userId: socket.id, 
        userName, 
        userPhoto, 
        deviceId 
      });
      
      const user = {
        id: userProfile.userId,
        socketId: socket.id,
        userName: userProfile.userName,
        userPhoto: userProfile.userPhoto,
        userColor: generateColor(userProfile.userName),
        country: userProfile.country,
        deviceId: deviceId,
        roomCode: room.roomCode,
        isOwner: room.ownerId === userProfile.userId,
        joinedAt: new Date()
      };

      activeUsers.set(socket.id, user);
      if (!rooms.has(room.roomCode)) rooms.set(room.roomCode, new Set());
      rooms.get(room.roomCode).add(socket.id);
      socket.join(room.roomCode);

      room.participants.push({
        userId: user.id,
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        country: user.country,
        joinedAt: new Date()
      });
      await room.save();

      socket.emit('room-joined', {
        roomCode: room.roomCode,
        roomName: room.roomName,
        isOwner: user.isOwner,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: user.userColor
      });

      updateRoomUsers(room.roomCode);
      socket.to(room.roomCode).emit('user-joined', { 
        userName: user.userName,
        country: user.country 
      });
      
      console.log(`✅ ${user.userName} → ${room.roomCode}`);
    } catch (error) {
      console.error('❌ Katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılınamadı' });
    }
  });

  // Video yükle
  socket.on('upload-video', async (videoData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user || !user.isOwner) {
        socket.emit('error', { message: 'Sadece oda sahibi video yükleyebilir!' });
        return;
      }

      console.log('📹 Video yükleniyor...');
      
      const room = await Room.findOne({ roomCode: user.roomCode });
      if (room.activeVideo?.cloudinaryId) {
        await cloudinary.uploader.destroy(room.activeVideo.cloudinaryId, { resource_type: 'video' });
      }

      const uploadResult = await cloudinary.uploader.upload(videoData.videoBase64, {
        resource_type: 'video',
        folder: 'video-odalari',
        chunk_size: 6000000
      });

      await Room.findOneAndUpdate(
        { roomCode: user.roomCode },
        {
          activeVideo: {
            url: uploadResult.secure_url,
            cloudinaryId: uploadResult.public_id,
            title: videoData.title || 'Video',
            duration: uploadResult.duration,
            uploadedAt: new Date()
          },
          'playbackState.playing': false,
          'playbackState.currentTime': 0,
          'playbackState.playbackRate': 1
        }
      );

      io.to(user.roomCode).emit('video-uploaded', {
        videoUrl: uploadResult.secure_url,
        title: videoData.title || 'Video',
        duration: uploadResult.duration
      });

      console.log('✅ Video yüklendi:', uploadResult.duration + 's');
    } catch (error) {
      console.error('❌ Video yükleme hatası:', error);
      socket.emit('error', { message: 'Video yüklenemedi: ' + error.message });
    }
  });

  // Video kontrol
  socket.on('video-control', async (controlData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user || !user.isOwner) return;

      const updateData = {
        'playbackState.timestamp': new Date()
      };

      if (controlData.playing !== undefined) updateData['playbackState.playing'] = controlData.playing;
      if (controlData.currentTime !== undefined) updateData['playbackState.currentTime'] = controlData.currentTime;
      if (controlData.playbackRate !== undefined) updateData['playbackState.playbackRate'] = controlData.playbackRate;

      await Room.findOneAndUpdate(
        { roomCode: user.roomCode },
        updateData
      );

      socket.to(user.roomCode).emit('video-control', controlData);
    } catch (error) {
      console.error('❌ Video kontrol hatası:', error);
    }
  });

  // Video sil
  socket.on('delete-video', async () => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user || !user.isOwner) return;

      const room = await Room.findOne({ roomCode: user.roomCode });
      if (room.activeVideo?.cloudinaryId) {
        await cloudinary.uploader.destroy(room.activeVideo.cloudinaryId, { resource_type: 'video' });
      }

      await Room.findOneAndUpdate(
        { roomCode: user.roomCode },
        { 
          activeVideo: null, 
          playbackState: { 
            playing: false, 
            currentTime: 0, 
            playbackRate: 1 
          } 
        }
      );

      io.to(user.roomCode).emit('video-deleted');
      console.log('✅ Video silindi');
    } catch (error) {
      console.error('❌ Silme hatası:', error);
    }
  });

  // Mesaj
  socket.on('message', async (messageData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) return;

      const message = {
        id: Date.now().toString(),
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        country: user.country,
        roomCode: user.roomCode,
        ...messageData
      };

      const dbMessage = new Message({
        messageId: message.id,
        userId: user.id,
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        country: user.country,
        roomCode: user.roomCode,
        text: message.text,
        type: message.type
      });
      await dbMessage.save();

      io.to(user.roomCode).emit('message', message);
    } catch (error) {
      console.error('❌ Mesaj hatası:', error);
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    clearInterval(heartbeatInterval);
    const user = activeUsers.get(socket.id);
    if (user) {
      activeUsers.delete(socket.id);
      if (rooms.has(user.roomCode)) {
        rooms.get(user.roomCode).delete(socket.id);
      }

      await Room.findOneAndUpdate(
        { roomCode: user.roomCode },
        { $pull: { participants: { userId: user.id } } }
      );

      updateRoomUsers(user.roomCode);
      socket.to(user.roomCode).emit('user-left', { userName: user.userName });
      console.log(`🔌 ${user.userName} ayrıldı`);
    }
  });
});

// API Routes
app.get('/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ 
    status: 'OK', 
    database: dbStatus,
    activeUsers: activeUsers.size,
    rooms: rooms.size
  });
});

app.get('/api/rooms', async (req, res) => {
  try {
    const roomsList = await Room.find().select('roomCode roomName ownerName participants createdAt');
    res.json(roomsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Video Platform Server ${PORT} portunda çalışıyor`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
