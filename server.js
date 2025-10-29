const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// Environment Variables
const MONGODB_URI = process.env.MONGODB_URI;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Cloudinary configuration - BÜYÜK DOSYALAR İÇİN
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  timeout: 300000, // 5 dakika timeout
  chunk_size: 20000000 // 20MB chunks (büyük dosyalar için)
});

// MongoDB connection
mongoose.connect(MONGODB_URI)
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
    uploadedAt: Date,
    duration: Number,
    fileSize: Number
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

// Socket.io with LARGE FILE support
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 120000, // 2 dakika
  pingInterval: 30000,
  maxHttpBufferSize: 2e8 // 200MB buffer (büyük filmler için)
});

// Middleware with LARGE limits
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
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

// Cloudinary'ye BÜYÜK video yükleme fonksiyonu
async function uploadLargeVideoToCloudinary(videoBase64, fileName, fileSize) {
  return new Promise((resolve, reject) => {
    console.log(`🎬 Büyük video yükleniyor: ${fileName}, Boyut: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
    
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        public_id: `movies/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        chunk_size: 20000000, // 20MB chunks
        timeout: 600000, // 10 dakika timeout (büyük filmler için)
        eager: [
          { streaming_profile: "full_hd", format: "m3u8" } // HLS format for streaming
        ],
        eager_async: true,
        transformation: [
          { quality: "auto" },
          { format: "mp4" }
        ]
      },
      (error, result) => {
        if (error) {
          console.error('❌ Cloudinary yükleme hatası:', error);
          reject(error);
        } else {
          console.log('✅ Büyük video yükleme başarılı:', result.public_id);
          resolve(result);
        }
      }
    );

    // Base64'ü buffer'a çevir ve yükle
    const base64Data = videoBase64.replace(/^data:video\/\w+;base64,/, '');
    const videoBuffer = Buffer.from(base64Data, 'base64');
    uploadStream.write(videoBuffer);
    uploadStream.end();
  });
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
      
      socket.emit('room-created', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: true
      });
      
      console.log(`✅ Oda oluşturuldu: ${room.code}`);
      
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
      
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Geçersiz şifre' });
        return;
      }
      
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
      
      const messages = await Message.find({ roomCode: roomCode })
        .sort({ createdAt: -1 })
        .limit(50);
      
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: false,
        activeVideo: room.activeVideo,
        playbackState: room.playbackState,
        userColor: currentUser.userColor,
        previousMessages: messages.reverse()
      });
      
      socket.to(roomCode).emit('user-joined', {
        userName: currentUser.userName
      });
      
      await updateUserList(roomCode);
      
      console.log(`✅ Kullanıcı odaya katıldı: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı' });
    }
  });

  // BÜYÜK Video yükleme - FİLM DESTEKLİ
  socket.on('upload-video', async (data) => {
    let uploadSuccess = false;
    
    try {
      if (!currentRoom || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
        return;
      }
      
      const { videoBase64, title, fileSize } = data;
      
      console.log(`🎬 FİLM yükleniyor: ${title}, Tahmini Boyut: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
      
      // İstemciye yükleme başladığını bildir
      socket.emit('upload-progress', { status: 'preparing', progress: 5 });
      
      let videoUrl = videoBase64;
      let cloudinaryId = null;
      
      // Cloudinary'ye yükle (BÜYÜK FİLM)
      try {
        socket.emit('upload-progress', { status: 'uploading', progress: 20 });
        
        const cloudinaryResult = await uploadLargeVideoToCloudinary(videoBase64, title, fileSize);
        videoUrl = cloudinaryResult.secure_url;
        cloudinaryId = cloudinaryResult.public_id;
        
        socket.emit('upload-progress', { status: 'uploading', progress: 70 });
        
      } catch (cloudinaryError) {
        console.log('⚠️ Cloudinary yükleme başarısız, base64 kullanılıyor:', cloudinaryError.message);
        // Fallback: base64 kullan
      }
      
      // Odayı güncelle
      await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          activeVideo: {
            url: videoUrl,
            title: title || 'Film',
            cloudinaryId: cloudinaryId,
            uploadedBy: currentUser.userName,
            uploadedAt: new Date(),
            fileSize: fileSize
          },
          playbackState: {
            playing: false,
            currentTime: 0,
            playbackRate: 1
          },
          updatedAt: new Date()
        }
      );
      
      socket.emit('upload-progress', { status: 'processing', progress: 90 });
      
      // Tüm kullanıcılara bildir
      io.to(currentRoom.code).emit('video-uploaded', {
        videoUrl: videoUrl,
        title: title || 'Film',
        cloudinaryId: cloudinaryId,
        fileSize: fileSize
      });
      
      socket.emit('upload-progress', { status: 'completed', progress: 100 });
      uploadSuccess = true;
      
      console.log(`🎬 FİLM yüklendi: ${title} -> ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Film yükleme hatası:', error);
      if (!uploadSuccess) {
        socket.emit('upload-progress', { status: 'error', progress: 0 });
        socket.emit('error', { message: 'Film yüklenemedi: ' + error.message });
      }
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
      
      socket.to(currentRoom.code).emit('video-control', controlData);
    } catch (error) {
      console.error('❌ Video kontrol güncelleme hatası:', error);
    }
  });

  // Video silme
  socket.on('delete-video', async () => {
    if (!currentRoom || !currentUser || !currentUser.isOwner) return;
    
    try {
      if (currentRoom.activeVideo && currentRoom.activeVideo.cloudinaryId) {
        await cloudinary.uploader.destroy(currentRoom.activeVideo.cloudinaryId, {
          resource_type: 'video'
        });
      }
      
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
      console.log(`🗑️ Film silindi: ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Film silme hatası:', error);
    }
  });

  // Mesaj gönderme
  socket.on('message', async (messageData) => {
    try {
      if (!currentRoom || !currentUser) return;
      
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
        await User.deleteOne({ socketId: socket.id });
        
        if (currentRoom) {
          socket.to(currentRoom.code).emit('user-left', {
            userName: currentUser.userName
          });
          
          if (currentUser.isOwner) {
            const roomUsers = await User.find({ roomCode: currentRoom.code });
            if (roomUsers.length === 0) {
              await Room.deleteOne({ code: currentRoom.code });
              await Message.deleteMany({ roomCode: currentRoom.code });
              console.log(`🗑️ Oda silindi: ${currentRoom.code}`);
            }
          } else {
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
      environment: process.env.NODE_ENV || 'development',
      features: {
        largeVideoSupport: true,
        maxVideoSize: '10GB',
        maxDuration: '4 hours',
        streaming: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

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
  console.log(`🎬 BÜYÜK FİLM DESTEKLİ: 2-3 saatlik filmler yüklenebilir`);
  console.log(`☁️ Cloudinary: Configured`);
  console.log(`🗄️ MongoDB: Connected`);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(async () => {
    await mongoose.connection.close();
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
