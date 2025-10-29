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

// Environment Variables
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/video-platform';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Cloudinary configuration
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET
});

// MongoDB connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB bağlantısı başarılı'))
.catch(err => console.error('❌ MongoDB bağlantı hatası:', err));

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
  try {
    console.log('☁️ Cloudinary\'ye video yükleniyor...');
    
    // Base64'ten upload
    const result = await cloudinary.uploader.upload(videoBase64, {
      resource_type: 'video',
      public_id: `video-platform/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      chunk_size: 6000000, // 6MB chunks
      timeout: 120000, // 2 dakika timeout
      eager: [
        { streaming_profile: "full_hd", format: "m3u8" } // HLS format için
      ],
      eager_async: true
    });

    console.log('✅ Cloudinary yükleme başarılı:', result.public_id);
    return result;
  } catch (error) {
    console.error('❌ Cloudinary yükleme hatası:', error);
    throw error;
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
      const room = new Room({
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
      
      await room.save();
      
      // Kullanıcı oluştur
      currentUser = new User({
        socketId: socket.id,
        userName: userName || 'Anonim',
        userPhoto: userPhoto,
        userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
        deviceId: deviceId,
        roomCode: roomCode,
        isOwner: true,
        country: 'Türkiye'
      });
      
      await currentUser.save();
      
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
      
      const room = await Room.findOne({ code: roomCode });
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
      currentUser = await User.findOneAndUpdate(
        { socketId: socket.id },
        {
          socketId: socket.id,
          userName: userName || 'Anonim',
          userPhoto: userPhoto,
          userColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
          deviceId: deviceId,
          roomCode: roomCode,
          isOwner: false,
          country: 'Türkiye',
          lastSeen: new Date()
        },
        { upsert: true, new: true }
      );
      
      currentRoom = room;
      socket.join(roomCode);
      
      // Geçmiş mesajları getir
      const messages = await Message.find({ roomCode: roomCode })
        .sort({ createdAt: -1 })
        .limit(50);
      
      // Başarılı yanıt
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: false,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: currentUser.userColor,
        previousMessages: messages.reverse() // En eskiden yeniye
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
      
      console.log(`🎬 Cloudinary'ye video yükleniyor: ${title}`);
      
      // Cloudinary'ye yükle
      const cloudinaryResult = await uploadToCloudinary(videoBase64, title);
      
      // Odayı güncelle
      const updatedRoom = await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          activeVideo: {
            url: cloudinaryResult.secure_url,
            title: title || 'Video',
            cloudinaryId: cloudinaryResult.public_id,
            uploadedBy: currentUser.userName,
            uploadedAt: new Date()
          },
          playbackState: {
            playing: false,
            currentTime: 0,
            playbackRate: 1
          },
          updatedAt: new Date()
        },
        { new: true }
      );
      
      // Tüm kullanıcılara video yüklendiğini bildir
      io.to(currentRoom.code).emit('video-uploaded', {
        videoUrl: cloudinaryResult.secure_url,
        title: title || 'Video',
        cloudinaryId: cloudinaryResult.public_id
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
      await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          playbackState: {
            playing: controlData.playing,
            currentTime: controlData.currentTime,
            playbackRate: controlData.playbackRate
          },
          updatedAt: new Date()
        }
      );
      
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
      // Cloudinary'den video sil
      if (currentRoom.activeVideo && currentRoom.activeVideo.cloudinaryId) {
        await cloudinary.uploader.destroy(currentRoom.activeVideo.cloudinaryId, {
          resource_type: 'video'
        });
      }
      
      // Odayı güncelle
      await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          activeVideo: null,
          playbackState: {
            playing: false,
            currentTime: 0,
            playbackRate: 1
          },
          updatedAt: new Date()
        }
      );
      
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
      
      const message = new Message({
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
      
      await message.save();
      
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
      const users = await User.find({ roomCode: roomCode });
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
        await User.deleteOne({ socketId: socket.id });
        
        if (currentRoom) {
          // Diğer kullanıcılara bildir
          socket.to(currentRoom.code).emit('user-left', {
            userName: currentUser.userName
          });
          
          // Eğer oda sahibi ayrıldıysa kontrol et
          if (currentUser.isOwner) {
            const roomUsers = await User.find({ roomCode: currentRoom.code });
            if (roomUsers.length === 0) {
              // Odada kimse kalmadı, odayı ve mesajları temizle
              await Room.deleteOne({ code: currentRoom.code });
              await Message.deleteMany({ roomCode: currentRoom.code });
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
    const roomCount = await Room.countDocuments();
    const userCount = await User.countDocuments();
    const messageCount = await Message.countDocuments();
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      rooms: roomCount,
      users: userCount,
      messages: messageCount,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().select('code name createdAt updatedAt').lean();
    const roomList = await Promise.all(rooms.map(async (room) => {
      const userCount = await User.countDocuments({ roomCode: room.code });
      return {
        code: room.code,
        name: room.name,
        userCount: userCount,
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`☁️ Cloudinary: ${CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}`);
  console.log(`🗄️ MongoDB: ${MONGODB_URI ? 'Connected' : 'Not connected'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(async () => {
    await mongoose.connection.close();
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
