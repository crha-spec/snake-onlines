const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// Environment Variables
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/videoapp';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Cloudinary configuration
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    timeout: 600000,
    chunk_size: 20000000
  });
  console.log('✅ Cloudinary configured');
} else {
  console.log('⚠️ Cloudinary not configured - using Base64 fallback');
}

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
    type: { type: String, enum: ['upload', 'youtube'], default: 'upload' },
    url: String,
    title: String,
    cloudinaryId: String,
    uploadedBy: String,
    uploadedAt: Date,
    fileSize: Number,
    videoId: String // For YouTube videos
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
  text: String,
  type: { type: String, default: 'text' },
  fileUrl: String,
  fileName: String,
  fileSize: Number,
  time: String,
  country: String,
  createdAt: { type: Date, default: Date.now }
});

const Room = mongoose.model('Room', roomSchema);
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Socket.io configuration
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 300000,
  pingInterval: 60000,
  maxHttpBufferSize: 2e9
});

// Middleware
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateUserColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];
  const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
  return colors[index % colors.length];
}

function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Upload to Cloudinary
async function uploadToCloudinary(videoBuffer, fileName) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        public_id: `movies/${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
        chunk_size: 20000000,
        timeout: 1200000,
        transformation: [
          { quality: "auto:best" },
          { format: "mp4" }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(videoBuffer);
  });
}

// Update user list
async function updateUserList(roomCode) {
  try {
    const users = await User.find({ roomCode: roomCode });
    const userList = users.map(user => ({
      id: user.socketId,
      userName: user.userName,
      userPhoto: user.userPhoto,
      userColor: user.userColor,
      isOwner: user.isOwner,
      country: user.country
    }));
    io.to(roomCode).emit('user-list-update', userList);
  } catch (error) {
    console.error('❌ Kullanıcı listesi güncelleme hatası:', error);
  }
}

// WebRTC signal storage
const webrtcSignals = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔗 Yeni kullanıcı bağlandı:', socket.id);

  let currentUser = null;
  let currentRoom = null;

  // Create room
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
        userName: userName,
        userPhoto: userPhoto,
        userColor: generateUserColor(userName),
        deviceId: deviceId,
        roomCode: roomCode,
        isOwner: true,
        country: 'Türkiye'
      });
      
      await currentUser.save();
      currentRoom = room;
      socket.join(roomCode);
      
      const shareableLink = `${process.env.NODE_ENV === 'production' ? 'https://snake-onlines-xe9h.onrender.com' : 'http://localhost:10000'}?room=${roomCode}`;
      
      socket.emit('room-created', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: true,
        shareableLink: shareableLink,
        userColor: currentUser.userColor
      });
      
      console.log(`✅ Oda oluşturuldu: ${room.code} - ${userName}`);
      
    } catch (error) {
      console.error('❌ Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı' });
    }
  });

  // Join room
  socket.on('join-room', async (data) => {
    try {
      const { roomCode, userName, userPhoto, deviceId, password } = data;
      
      const room = await Room.findOne({ code: roomCode.toUpperCase() });
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
          userName: userName,
          userPhoto: userPhoto,
          userColor: generateUserColor(userName),
          deviceId: deviceId,
          roomCode: roomCode,
          isOwner: room.owner === socket.id,
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
        isOwner: room.owner === socket.id,
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

  // Upload video
  socket.on('upload-video', async (data) => {
    let uploadSuccess = false;
    
    try {
      if (!currentRoom || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Video yüklemek için oda sahibi olmalısınız' });
        return;
      }
      
      const { videoBase64, title, fileSize } = data;
      
      console.log(`🎬 Video yükleniyor: ${title}`);
      
      socket.emit('upload-progress', { status: 'preparing', progress: 5 });
      
      let videoUrl = videoBase64;
      let cloudinaryId = null;
      
      // Try Cloudinary if configured
      if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET && fileSize < 100 * 1024 * 1024) {
        try {
          socket.emit('upload-progress', { status: 'uploading', progress: 30 });
          
          const base64Data = videoBase64.replace(/^data:video\/\w+;base64,/, '');
          const videoBuffer = Buffer.from(base64Data, 'base64');
          
          const cloudinaryResult = await uploadToCloudinary(videoBuffer, title);
          videoUrl = cloudinaryResult.secure_url;
          cloudinaryId = cloudinaryResult.public_id;
          
          socket.emit('upload-progress', { status: 'uploading', progress: 80 });
        } catch (cloudinaryError) {
          console.log('⚠️ Cloudinary yükleme başarısız, Base64 kullanılıyor');
        }
      }
      
      socket.emit('upload-progress', { status: 'processing', progress: 90 });
      
      await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          activeVideo: {
            type: 'upload',
            url: videoUrl,
            title: title,
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
      
      io.to(currentRoom.code).emit('video-uploaded', {
        videoUrl: videoUrl,
        title: title,
        cloudinaryId: cloudinaryId,
        fileSize: fileSize
      });
      
      socket.emit('upload-progress', { status: 'completed', progress: 100 });
      uploadSuccess = true;
      
      console.log(`🎬 Video yüklendi: ${title} -> ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Video yükleme hatası:', error);
      if (!uploadSuccess) {
        socket.emit('upload-progress', { status: 'error', progress: 0 });
        socket.emit('error', { message: 'Video yüklenemedi: ' + error.message });
      }
    }
  });

  // Share YouTube video
  socket.on('share-youtube-link', async (data) => {
    try {
      if (!currentRoom || !currentUser) return;
      
      const { youtubeUrl, title } = data;
      const videoId = extractYouTubeId(youtubeUrl);
      
      if (!videoId) {
        socket.emit('error', { message: 'Geçersiz YouTube linki' });
        return;
      }
      
      await Room.findOneAndUpdate(
        { code: currentRoom.code },
        {
          activeVideo: {
            type: 'youtube',
            videoId: videoId,
            url: youtubeUrl,
            title: title || 'YouTube Video',
            uploadedBy: currentUser.userName,
            uploadedAt: new Date()
          },
          playbackState: {
            playing: false,
            currentTime: 0,
            playbackRate: 1
          },
          updatedAt: new Date()
        }
      );
      
      io.to(currentRoom.code).emit('youtube-video-shared', {
        videoId: videoId,
        title: title || 'YouTube Video',
        sharedBy: currentUser.userName
      });
      
      console.log(`🎬 YouTube video paylaşıldı: ${videoId} -> ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ YouTube video paylaşma hatası:', error);
      socket.emit('error', { message: 'YouTube video paylaşılamadı' });
    }
  });

  // Video control
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

  // Delete video
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
      console.log(`🗑️ Video silindi: ${currentRoom.code}`);
      
    } catch (error) {
      console.error('❌ Video silme hatası:', error);
    }
  });

  // Send message
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
        fileUrl: messageData.fileUrl,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
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
        fileUrl: messageData.fileUrl,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
        time: message.time,
        country: currentUser.country
      });
      
    } catch (error) {
      console.error('❌ Mesaj gönderme hatası:', error);
    }
  });

  // WebRTC Signaling
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

  // Disconnect
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
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.get('/api/room/:code', async (req, res) => {
  try {
    const room = await Room.findOne({ code: req.params.code }).select('code name createdAt');
    if (!room) {
      return res.status(404).json({ error: 'Oda bulunamadı' });
    }
    
    const userCount = await User.countDocuments({ roomCode: req.params.code });
    
    res.json({
      code: room.code,
      name: room.name,
      userCount: userCount,
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
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🎬 YouTube + Video Upload Desteği Aktif`);
  console.log(`📞 WebRTC Görüntülü/Sesli Arama Aktif`);
  console.log(`💬 Dosya Paylaşımı Aktif`);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM alındı, server kapatılıyor...');
  server.close(async () => {
    await mongoose.connection.close();
    console.log('✅ Server başarıyla kapatıldı');
    process.exit(0);
  });
});
