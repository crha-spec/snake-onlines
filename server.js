const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Vercel için Socket.io yapılandırması
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  path: '/socket.io/'
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors({
  origin: "*",
  credentials: true
}));

// Static files - Vercel için path düzeltmesi
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB bağlantısı
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ MongoDB bağlantısı başarılı'))
  .catch(err => {
    console.error('❌ MongoDB bağlantı hatası:', err);
    console.log('⚠️  MongoDB olmadan devam ediliyor...');
  });
} else {
  console.log('⚠️  MONGODB_URI bulunamadı, memory modunda çalışılıyor...');
}

// Kullanıcı Profil Şeması
const userProfileSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true
  },
  userName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 20
  },
  userPhoto: {
    type: String,
    default: ''
  },
  city: {
    type: String,
    default: 'Genel'
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const UserProfile = mongoose.model('UserProfile', userProfileSchema);

// Türkiye şehir listesi
const TURKISH_CITIES = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin',
  'Aydın', 'Balıkesir', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale',
  'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir',
  'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Isparta', 'Mersin', 'İstanbul', 'İzmir',
  'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya',
  'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Rize', 'Sakarya',
  'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak',
  'Van', 'Yozgat', 'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman', 'Kırıkkale', 'Batman', 'Şırnak',
  'Bartın', 'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye', 'Düzce'
];

// Bellekte saklanan veriler
const rooms = new Map();
const socketToUser = new Map();
const connectedUsers = new Map();

// IP'den şehir bulma
async function getCityFromIP(ip) {
  try {
    let realIP = ip;
    if (ip.includes('::ffff:')) {
      realIP = ip.split(':').pop();
    }
    
    // Vercel ve localhost için fallback
    if (realIP === '127.0.0.1' || realIP === '::1' || realIP === '::ffff:127.0.0.1' || realIP === 'localhost') {
      return 'İstanbul';
    }

    // Vercel'in header'larından IP'yi al
    if (ip === '::ffff:127.0.0.1' || !ip || ip === '::1') {
      return 'İstanbul';
    }

    const response = await axios.get(`http://ip-api.com/json/${realIP}?fields=status,message,city,country`, {
      timeout: 5000
    });
    
    if (response.data.status === 'success' && response.data.city) {
      const city = response.data.city;
      
      const turkishCity = TURKISH_CITIES.find(turkishCity => 
        city.toLowerCase().includes(turkishCity.toLowerCase()) ||
        turkishCity.toLowerCase().includes(city.toLowerCase())
      );
      
      return turkishCity || 'Genel';
    }
  } catch (error) {
    console.error('❌ IP lookup error:', error.message);
  }
  
  return 'Genel';
}

// Kullanıcı rengi oluşturma
function generateColor(username) {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D7BDE2'
  ];
  const index = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[index % colors.length];
}

// Kullanıcı profilini getir veya oluştur
async function getOrCreateUserProfile(userData) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return {
        userId: userData.userId,
        userName: userData.userName,
        userPhoto: userData.userPhoto || '',
        city: userData.city || 'Genel',
        lastSeen: new Date(),
        createdAt: new Date()
      };
    }

    let userProfile = await UserProfile.findOne({ userId: userData.userId });
    
    if (!userProfile) {
      userProfile = new UserProfile({
        userId: userData.userId,
        userName: userData.userName,
        userPhoto: userData.userPhoto || '',
        city: userData.city || 'Genel'
      });
      await userProfile.save();
      console.log('✅ Yeni kullanıcı profili oluşturuldu:', userData.userName);
    } else {
      userProfile.userName = userData.userName;
      userProfile.userPhoto = userData.userPhoto || userProfile.userPhoto;
      userProfile.lastSeen = new Date();
      await userProfile.save();
      console.log('✅ Kullanıcı profili güncellendi:', userData.userName);
    }
    
    return userProfile;
  } catch (error) {
    console.error('❌ Kullanıcı profili hatası:', error);
    return {
      userId: userData.userId,
      userName: userData.userName,
      userPhoto: userData.userPhoto || '',
      city: userData.city || 'Genel',
      lastSeen: new Date(),
      createdAt: new Date()
    };
  }
}

// Oda işlemleri
function getRoomUsers(room) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  return Array.from(rooms.get(room)).map(userId => connectedUsers.get(userId)).filter(Boolean);
}

function addUserToRoom(userId, room, userInfo) {
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  rooms.get(room).add(userId);
  connectedUsers.set(userId, userInfo);
}

function removeUserFromRoom(userId, room) {
  if (rooms.has(room)) {
    rooms.get(room).delete(userId);
    if (rooms.get(room).size === 0) {
      rooms.delete(room);
    }
  }
  connectedUsers.delete(userId);
}

// Socket.io bağlantı yönetimi
io.on('connection', async (socket) => {
  console.log('🔗 Yeni kullanıcı bağlandı:', socket.id);

  try {
    // Vercel'de IP adresini doğru şekilde al
    const clientIP = socket.handshake.headers['x-forwarded-for'] || 
                    socket.handshake.address || 
                    socket.conn.remoteAddress;
    
    console.log('🌐 Client IP:', clientIP);
    const city = await getCityFromIP(clientIP);
    console.log(`📍 Kullanıcı ${socket.id} şehri: ${city}`);

    socket.on('user-join', async (userData) => {
      try {
        console.log('👤 Kullanıcı katılım verisi:', userData);

        const userProfile = await getOrCreateUserProfile({
          ...userData,
          city: city
        });

        const user = {
          id: userProfile.userId,
          socketId: socket.id,
          userName: userProfile.userName,
          userPhoto: userProfile.userPhoto,
          city: city,
          userColor: generateColor(userProfile.userName),
          room: city,
          joinedAt: new Date()
        };

        socketToUser.set(socket.id, user.id);
        addUserToRoom(user.id, city, user);

        socket.emit('user-assigned', {
          userId: user.id,
          userName: user.userName,
          city: city,
          userPhoto: user.userPhoto,
          userColor: user.userColor
        });

        socket.join(city);

        const roomUsers = getRoomUsers(city);
        io.to(city).emit('user-list-update', roomUsers);

        socket.to(city).emit('user-joined', {
          userName: user.userName,
          users: roomUsers
        });

        console.log(`✅ Kullanıcı ${user.userName} ${city} odasına katıldı`);

      } catch (error) {
        console.error('❌ Kullanıcı katılma hatası:', error);
        socket.emit('error', { message: 'Kullanıcı kaydı hatası' });
      }
    });

    socket.on('update-profile', async (profileData) => {
      try {
        console.log('🔄 Profil güncelleniyor:', profileData);

        const userProfile = await getOrCreateUserProfile(profileData);

        if (userProfile) {
          const userId = socketToUser.get(socket.id);
          if (userId && connectedUsers.has(userId)) {
            const userInfo = connectedUsers.get(userId);
            userInfo.userName = userProfile.userName;
            userInfo.userPhoto = userProfile.userPhoto;
            connectedUsers.set(userId, userInfo);
          }

          const roomUsers = getRoomUsers(userProfile.city);
          io.to(userProfile.city).emit('profile-updated', {
            userId: userProfile.userId,
            userName: userProfile.userName,
            userPhoto: userProfile.userPhoto
          });

          io.to(userProfile.city).emit('user-list-update', roomUsers);

          console.log(`✅ Profil güncellendi: ${userProfile.userName}`);
        }
      } catch (error) {
        console.error('❌ Profil güncelleme hatası:', error);
      }
    });

    socket.on('message', async (messageData) => {
      try {
        const userId = socketToUser.get(socket.id);
        if (!userId) {
          console.error('❌ Mesaj gönderen kullanıcı bulunamadı');
          return;
        }

        const userInfo = connectedUsers.get(userId);
        if (!userInfo) {
          console.error('❌ Kullanıcı bilgisi bulunamadı');
          return;
        }

        const message = {
          id: messageData.id || Date.now().toString(),
          text: messageData.text,
          time: messageData.time || new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
          userName: userInfo.userName,
          userPhoto: userInfo.userPhoto,
          userColor: userInfo.userColor,
          room: userInfo.city,
          seen: false
        };

        io.to(userInfo.city).emit('message', message);
        console.log(`💬 Mesaj ${userInfo.city} odasında yayınlandı:`, message.text.substring(0, 50) + '...');

      } catch (error) {
        console.error('❌ Mesaj gönderme hatası:', error);
        socket.emit('error', { message: 'Mesaj gönderilemedi' });
      }
    });

    socket.on('typing', async (isTyping) => {
      try {
        const userId = socketToUser.get(socket.id);
        if (!userId) return;

        const userInfo = connectedUsers.get(userId);
        if (!userInfo) return;

        socket.to(userInfo.city).emit('typing', {
          userName: userInfo.userName,
          isTyping: isTyping
        });

      } catch (error) {
        console.error('❌ Typing indicator hatası:', error);
      }
    });

    socket.on('message-seen', (data) => {
      try {
        const userId = socketToUser.get(socket.id);
        if (!userId) return;

        const userInfo = connectedUsers.get(userId);
        if (!userInfo) return;

        io.to(data.room).emit('message-seen', {
          messageId: data.messageId,
          seenBy: userInfo.userName
        });

      } catch (error) {
        console.error('❌ Mesaj okundu hatası:', error);
      }
    });

    socket.on('disconnect', async (reason) => {
      console.log('🔌 Kullanıcı ayrıldı:', socket.id, 'Neden:', reason);

      try {
        const userId = socketToUser.get(socket.id);
        if (!userId) return;

        const userInfo = connectedUsers.get(userId);
        if (!userInfo) return;

        removeUserFromRoom(userId, userInfo.city);
        socketToUser.delete(socket.id);

        const roomUsers = getRoomUsers(userInfo.city);
        
        socket.to(userInfo.city).emit('user-left', {
          userName: userInfo.userName,
          users: roomUsers
        });

        io.to(userInfo.city).emit('user-list-update', roomUsers);

        console.log(`👋 Kullanıcı ${userInfo.userName} ${userInfo.city} odasından ayrıldı`);

      } catch (error) {
        console.error('❌ Kullanıcı ayrılma hatası:', error);
      }
    });

    socket.on('error', (error) => {
      console.error('❌ Socket hatası:', error);
    });

  } catch (error) {
    console.error('❌ Kullanıcı bağlantı hatası:', error);
    socket.emit('error', { message: 'Bağlantı hatası' });
  }
});

// API Routes
app.get('/api/users/:userId', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Database bağlantısı yok' });
    }

    const userProfile = await UserProfile.findOne({ userId: req.params.userId });
    if (!userProfile) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    res.json(userProfile);
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.get('/api/users/city/:city', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json([]);
    }

    const users = await UserProfile.find({ city: req.params.city });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      database: dbStatus,
      rooms: Array.from(rooms.keys()),
      connectedUsers: connectedUsers.size,
      totalSockets: socketToUser.size
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'Sunucu çalışıyor!',
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    environment: process.env.NODE_ENV
  });
});

// Ana sayfa - Vercel için path düzeltmesi
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Tüm route'ları index.html'e yönlendir (SPA için)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route bulunamadı' });
});

// Hata yönetimi
process.on('uncaughtException', (error) => {
  console.error('💥 Beklenmeyen hata:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 İşlenmemiş promise reddi:', reason);
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Test: http://localhost:${PORT}/test`);
  console.log(`🗄️  MongoDB durumu: ${mongoose.connection.readyState === 1 ? '✅ Bağlı' : '❌ Bağlı değil'}`);
});

module.exports = app;
