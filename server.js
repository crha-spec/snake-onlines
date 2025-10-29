const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const { Buffer } = require('buffer');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// Environment Variables - Render'da ayarlanacak
const MONGODB_URI = process.env.MONGODB_URI;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Cloudinary configuration - Varsa config et
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
  console.log('✅ Cloudinary configured');
} else {
  console.log('⚠️ Cloudinary not configured - using base64 fallback');
}

// MongoDB connection with better error handling
async function connectDB() {
  if (!MONGODB_URI) {
    console.log('❌ MONGODB_URI not found in environment variables');
    console.log('📝 Using in-memory storage (data will be lost on restart)');
    return false;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB bağlantısı başarılı');
    return true;
  } catch (error) {
    console.error('❌ MongoDB bağlantı hatası:', error.message);
    console.log('📝 Using in-memory storage (data will be lost on restart)');
    return false;
  }
}

// MongoDB Schemas
const roomSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  password: String,
  owner: { type: String, required: true },
  activeVideo: {
    url: String,
    title: String,
    cloudinaryId: String,
    uploadedBy: String,
    uploadedAt: Date
  },
  playbackState: {
    playing: Boolean,
    currentTime: Number,
    playbackRate: Number
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  socketId: { type: String, required: true },
  userName: { type: String, required: true },
  userPhoto: String,
  userColor: String,
  deviceId: String,
  roomCode: String,
  isOwner: Boolean,
  country: String,
  lastSeen: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  userName: { type: String, required: true },
  userPhoto: String,
  userColor: String,
  text: { type: String, required: true },
  type: { type: String, default: 'text' },
  time: String,
  country: String,
  createdAt: { type: Date, default: Date.now }
});

const Room = mongoose.model('Room', roomSchema);
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// In-memory storage fallback
const memoryRooms = new Map();
const memoryUsers = new Map();
const memoryMessages = new Map(); // roomCode -> messages array

let useDatabase = false;

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Yardımcı fonksiyonlar
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function sanitizeUser(user) {
  return {
    id: user.socketId,
    userName: user.userName,
    userPhoto: user.userPhoto,
    userColor: user.userColor,
    isOwner: user.isOwner,
    country: user.country || 'Türkiye',
    deviceId: user.deviceId
  };
}

// Cloudinary'ye video yükleme fonksiyonu
async function uploadToCloudinary(videoBase64, fileName) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary not configured');
  }

  try {
    console.log('☁️ Cloudinary\'ye video yükleniyor...');
    
    const result = await cloudinary.uploader.upload(videoBase64, {
      resource_type: 'video',
      public_id: `video-platform/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      chunk_size: 6000000,
      timeout: 120000,
    });

    console.log('✅ Cloudinary yükleme başarılı:', result.public_id);
    return result;
  } catch (error) {
    console.error('❌ Cloudinary yükleme hatası:', error);
    throw error;
  }
}

// Database functions with fallback
async function saveRoom(roomData) {
  if (useDatabase) {
    const room = new Room(roomData);
    return await room.save();
  } else {
    memoryRooms.set(roomData.code, { ...roomData, _id: crypto.randomBytes(8).toString('hex') });
    return memoryRooms.get(roomData.code);
  }
}

async function findRoom(roomCode) {
  if (useDatabase) {
    return await Room.findOne({ code: roomCode });
  } else {
    return memoryRooms.get(roomCode) || null;
  }
}

async function updateRoom(roomCode, updateData) {
  if (useDatabase) {
    return await Room.findOneAndUpdate(
      { code: roomCode },
      { ...updateData, updatedAt: new Date() },
      { new: true }
    );
  } else {
    const room = memoryRooms.get(roomCode);
    if (room) {
      Object.assign(room, updateData, { updatedAt: new Date() });
      memoryRooms.set(roomCode, room);
    }
    return room;
  }
}

async function saveUser(userData) {
  if (useDatabase) {
    const user = new User(userData);
    return await user.save();
  } else {
    memoryUsers.set(userData.socketId, { ...userData, _id: crypto.randomBytes(8).toString('hex') });
    return memoryUsers.get(userData.socketId);
  }
}

async function findUser(socketId) {
  if (useDatabase) {
    return await User.findOne({ socketId });
  } else {
    return memoryUsers.get(socketId) || null;
  }
}

async function deleteUser(socketId) {
  if (useDatabase) {
    await User.deleteOne({ socketId });
  } else {
    memoryUsers.delete(socketId);
  }
}

async function findUsersByRoom(roomCode) {
  if (useDatabase) {
    return await User.find({ roomCode });
  } else {
    return Array.from(memoryUsers.values()).filter(user => user.roomCode === roomCode);
  }
}

async function saveMessage(messageData) {
  if (useDatabase) {
    const message = new Message(messageData);
    return await message.save();
  } else {
    const message = { ...messageData, _id: crypto.randomBytes(8).toString('hex'), createdAt: new Date() };
    if (!memoryMessages.has(messageData.roomCode)) {
      memoryMessages.set(messageData.roomCode, []);
    }
    memoryMessages.get(messageData.roomCode).push(message);
    return message;
  }
}

async function findMessagesByRoom(roomCode, limit = 50) {
  if (useDatabase) {
    return await Message.find({ roomCode }).sort({ createdAt: -1 }).limit(limit);
  } else {
    const messages = memoryMessages.get(roomCode) || [];
    return messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  }
}

async function deleteRoom(roomCode) {
  if (useDatabase) {
    await Room.deleteOne({ code: roomCode });
    await Message.deleteMany({ roomCode });
  } else {
    memoryRooms.delete(roomCode);
    memoryMessages.delete(roomCode);
  }
}

// Socket.io bağlantı yönetimi
io.on('connection', (socket) => {
  console.log('🔗 Yeni kullanıcı bağlandı:', socket.id);

  let currentUser = null;
  let currentRoom = null;

  // Oda oluşturma
  socket.on('create-room', async (data) => {
    try {
      const { userName, userPhoto, deviceId, roomName, password } = data;
      
      const roomCode = generateRoomCode();
      
      // Oda oluştur
      const room = await saveRoom({
        code: roomCode,
        name: roomName,
        password: password,
        owner: socket.id,
        playbackState: {
          playing: false,
          currentTime: 0,
          playbackRate: 1
        }
      });
      
      // Kullanıcı oluştur
      currentUser = await saveUser({
        socketId: socket.id,
        userName: userName || 'Anonim',
        userPhoto: userPhoto,
        userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
        deviceId: deviceId,
        roomCode: roomCode,
        isOwner: true,
        country: 'Türkiye'
      });
      
      currentRoom = room;
      socket.join(roomCode);
      
      // Başarılı yanıt
      socket.emit('room-created', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: true
      });
      
      console.log(`✅ Oda oluşturuldu: ${room.code} - ${room.name}`);
      
    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı' });
    }
  });

  // Odaya katılma
  socket.on('join-room', async (data) => {
    try {
      const { roomCode, userName, userPhoto, deviceId, password } = data;
      
      const room = await findRoom(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı' });
        return;
      }
      
      // Şifre kontrolü
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Geçersiz şifre' });
        return;
      }
      
      // Kullanıcı oluştur/güncelle
      currentUser = await saveUser({
        socketId: socket.id,
        userName: userName || 'Anonim',
        userPhoto: userPhoto,
        userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
        deviceId: deviceId,
        roomCode: roomCode,
        isOwner: false,
        country: 'Türkiye',
        lastSeen: new Date()
      });
      
      currentRoom = room;
      socket.join(roomCode);
      
      // Geçmiş mesajları getir
      const messages = await findMessagesByRoom(roomCode);
      
      // Başarılı yanıt
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: false,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: currentUser.userColor,
        previousMessages: messages.reverse()
      });
      
      // Diğer kullanıcılara bildir
      socket.to(roomCode).emit('user-joined', {
        userName: currentUser.userName
      });
      
      // Kullanıcı listesini güncelle
      await updateUserList(roomCode);
      
      console.log(`✅ Kullanıcı odaya katıldı: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı' });
    }
  });

  // Video yükleme
  socket.on('upload-video', async (data) => {
    try {
      if (!currentRoom || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
        return;
      }
      
      const { videoBase64, title } = data;
      
      let videoUrl = videoBase64;
      let cloudinaryId = null;
      
      // Cloudinary'ye yükle (eğer config varsa)
      if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
        try {
          console.log(`🎬 Cloudinary'ye video yükleniyor: ${title}`);
          const cloudinaryResult = await uploadToCloudinary(videoBase64, title);
          videoUrl = cloudinaryResult.secure_url;
          cloudinaryId = cloudinaryResult.public_id;
        } catch (error) {
          console.log('⚠️ Cloudinary yükleme başarısız, base64 kullanılıyor:', error.message);
          // Cloudinary başarısız olursa base64 kullanmaya devam et
        }
      }
      
      // Odayı güncelle
      await updateRoom(currentRoom.code, {
        activeVideo: {
          url: videoUrl,
          title: title || 'Video',
          cloudinaryId: cloudinaryId,
          uploadedBy: currentUser.userName,
          uploadedAt: new Date()
        },
        playbackState: {
          playing: false,
          currentTime: 0,
          playbackRate: 1
        }
      });
      
      // Tüm kullanıcılara video yüklendiğini bildir
      io.to(currentRoom.code).emit('video-uploaded', {
        videoUrl: videoUrl,
        title: title || 'Video',
        cloudinaryId: cloudinaryId
      });
      
      console.log(`🎬 Video yüklendi: ${title} -> ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Video yükleme hatası:', error);
      socket.emit('error', { message: 'Video yüklenemedi: ' + error.message });
    }
  });

  // Video kontrolü
  socket.on('video-control', async (controlData) => {
    if (!currentRoom || !currentUser || !currentUser.isOwner) return;
    
    try {
      await updateRoom(currentRoom.code, {
        playbackState: {
          playing: controlData.playing,
          currentTime: controlData.currentTime,
          playbackRate: controlData.playbackRate
        }
      });
      
      // Oda sahibi dışındaki herkese kontrol bilgilerini gönder
      socket.to(currentRoom.code).emit('video-control', controlData);
    } catch (error) {
      console.error('❌ Video kontrol güncelleme hatası:', error);
    }
  });

  // Video silme
  socket.on('delete-video', async () => {
    if (!currentRoom || !currentUser || !currentUser.isOwner) return;
    
    try {
      // Cloudinary'den video sil (eğer varsa)
      if (currentRoom.activeVideo && currentRoom.activeVideo.cloudinaryId) {
        try {
          await cloudinary.uploader.destroy(currentRoom.activeVideo.cloudinaryId, {
            resource_type: 'video'
          });
        } catch (error) {
          console.log('⚠️ Cloudinary silme başarısız:', error.message);
        }
      }
      
      // Odayı güncelle
      await updateRoom(currentRoom.code, {
        activeVideo: null,
        playbackState: {
          playing: false,
          currentTime: 0,
          playbackRate: 1
        }
      });
      
      io.to(currentRoom.code).emit('video-deleted');
      console.log(`🗑️ Video silindi: ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Video silme hatası:', error);
    }
  });

  // Mesaj gönderme
  socket.on('message', async (messageData) => {
    try {
      if (!currentRoom || !currentUser) return;
      
      console.log('💬 Mesaj alındı:', messageData.text);
      
      const message = await saveMessage({
        roomCode: currentRoom.code,
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
      });
      
      // Tüm kullanıcılara mesajı gönder
      io.to(currentRoom.code).emit('message', {
        id: message._id,
        userName: currentUser.userName,
        userPhoto: currentUser.userPhoto,
        userColor: currentUser.userColor,
        text: messageData.text,
        type: messageData.type || 'text',
        time: message.time,
        country: currentUser.country
      });
      
      console.log(`💬 Mesaj kaydedildi: ${currentUser.userName} -> ${messageData.text}`);
      
    } catch (error) {
      console.error('❌ Mesaj gönderme hatası:', error);
    }
  });

  // Kullanıcı listesini güncelleme fonksiyonu
  async function updateUserList(roomCode) {
    try {
      const users = await findUsersByRoom(roomCode);
      const userList = users.map(user => sanitizeUser(user));
      io.to(roomCode).emit('user-list-update', userList);
    } catch (error) {
      console.error('❌ Kullanıcı listesi güncelleme hatası:', error);
    }
  }

  // Bağlantı kesildiğinde
  socket.on('disconnect', async (reason) => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Sebep:', reason);
    
    if (currentUser) {
      try {
        // Kullanıcıyı sil
        await deleteUser(socket.id);
        
        if (currentRoom) {
          // Diğer kullanıcılara bildir
          socket.to(currentRoom.code).emit('user-left', {
            userName: currentUser.userName
          });
          
          // Eğer oda sahibi ayrıldıysa kontrol et
          if (currentUser.isOwner) {
            const roomUsers = await findUsersByRoom(currentRoom.code);
            if (roomUsers.length === 0) {
              // Odada kimse kalmadı, odayı temizle
              await deleteRoom(currentRoom.code);
              console.log(`🗑️ Oda silindi: ${currentRoom.code}`);
            }
          } else {
            // Kullanıcı listesini güncelle
            await updateUserList(currentRoom.code);
          }
        }
      } catch (error) {
        console.error('❌ Kullanıcı temizleme hatası:', error);
      }
    }
  });
});

// API Routes
app.get('/api/health', async (req, res) => {
  try {
    let roomCount, userCount, messageCount;
    
    if (useDatabase) {
      roomCount = await Room.countDocuments();
      userCount = await User.countDocuments();
      messageCount = await Message.countDocuments();
    } else {
      roomCount = memoryRooms.size;
      userCount = memoryUsers.size;
      messageCount = Array.from(memoryMessages.values()).reduce((acc, msgs) => acc + msgs.length, 0);
    }
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      rooms: roomCount,
      users: userCount,
      messages: messageCount,
      environment: process.env.NODE_ENV || 'development',
      database: useDatabase ? 'MongoDB' : 'In-Memory',
      cloudinary: !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET)
    });
  } catch (error) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    let rooms;
    
    if (useDatabase) {
      rooms = await Room.find().select('code name createdAt updatedAt').lean();
    } else {
      rooms = Array.from(memoryRooms.values()).map(room => ({
        code: room.code,
        name: room.name,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      }));
    }
    
    const roomList = await Promise.all(rooms.map(async (room) => {
      const users = await findUsersByRoom(room.code);
      return {
        code: room.code,
        name: room.name,
        userCount: users.length,
        hasPassword: !!room.password,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    }));
    
    res.json(roomList);
  } catch (error) {
    res.status(500).json({ error: 'Rooms fetch failed' });
  }
});

// Static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Başlatma
async function startServer() {
  // MongoDB'ye bağlan
  useDatabase = await connectDB();
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🗄️ Database: ${useDatabase ? 'MongoDB' : 'In-Memory'}`);
    console.log(`☁️ Cloudinary: ${CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}`);
  });
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(async () => {
    if (useDatabase) {
      await mongoose.connection.close();
    }
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
