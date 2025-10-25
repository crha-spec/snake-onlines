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

// Socket.io yapılandırması
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());
app.use(express.static('public'));

// MongoDB bağlantısı
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB bağlantısı başarılı'))
  .catch(err => console.log('⚠️  MongoDB bağlantı hatası:', err));
}

// Mesaj Şeması (Güncellendi)
const messageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userPhoto: String,
  userColor: String,
  room: {
    type: String,
    required: true
  },
  text: String,
  media: String,
  mediaType: String,
  caption: String,
  audio: String,
  duration: Number,
  type: {
    type: String,
    default: 'text',
    enum: ['text', 'audio', 'media']
  },
  edited: {
    type: Boolean,
    default: false
  },
  editedAt: Date,
  deleted: {
    type: Boolean,
    default: false
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const Message = mongoose.model('Message', messageSchema);

// Kullanıcı Şehir Kaydı Şeması
const userLocationSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true
  },
  ipAddress: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true
  },
  country: {
    type: String,
    default: 'Turkey'
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

const UserLocation = mongoose.model('UserLocation', userLocationSchema);

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
  deviceId: {
    type: String,
    required: true
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

// Desteklenen ülkeler (Türkiye)
const SUPPORTED_COUNTRIES = ['Turkey', 'Türkiye'];

// Bellek deposu
const rooms = new Map();
const activeUsers = new Map();

// IP'den şehir bulma
async function getCityFromIP(ip) {
  try {
    let realIP = ip;
    if (ip.includes('::ffff:')) {
      realIP = ip.split(':').pop();
    }
    
    // Localhost ve test IP'leri için
    if (realIP === '127.0.0.1' || realIP === '::1' || realIP === '::ffff:127.0.0.1') {
      return { city: 'İstanbul', country: 'Turkey', restricted: false };
    }

    console.log('🔍 IP sorgulanıyor:', realIP);
    const response = await axios.get(`http://ip-api.com/json/${realIP}?fields=status,message,city,country,query`, {
      timeout: 10000
    });
    
    if (response.data.status === 'success' && response.data.city) {
      const city = response.data.city;
      const country = response.data.country;
      console.log('📍 API şehir döndü:', city, country);
      
      // Ülke kontrolü - YENİ EKLENDİ
      const isSupported = SUPPORTED_COUNTRIES.some(supported => 
        country.toLowerCase().includes(supported.toLowerCase())
      );
      
      if (!isSupported) {
        return { city: null, country, restricted: true };
      }
      
      // Türkçe şehir isimleriyle eşleştirme
      const turkishCity = TURKISH_CITIES.find(turkishCity => 
        city.toLowerCase().includes(turkishCity.toLowerCase()) ||
        turkishCity.toLowerCase().includes(city.toLowerCase())
      );
      
      return { 
        city: turkishCity || 'Genel', 
        country, 
        restricted: false 
      };
    }
  } catch (error) {
    console.error('❌ IP lookup error:', error.message);
  }
  
  return { city: 'Genel', country: 'Unknown', restricted: false };
}

// Device ID ile şehir bul veya oluştur
async function getOrCreateUserCity(deviceId, ipAddress) {
  try {
    // Önce MongoDB'de deviceId'yi ara
    let userLocation = await UserLocation.findOne({ deviceId: deviceId });
    
    if (userLocation) {
      console.log(`✅ Device ID bulundu: ${deviceId} -> ${userLocation.city}`);
      // Son görülme zamanını güncelle
      userLocation.lastSeen = new Date();
      userLocation.ipAddress = ipAddress; // IP güncelle (VPN değişmiş olabilir)
      await userLocation.save();
      
      // YENİ: IP kontrolü yap
      const ipInfo = await getCityFromIP(ipAddress);
      if (ipInfo.restricted) {
        return { city: null, restricted: true };
      }
      
      // IP tabanlı şehir atama - YENİ EKLENDİ
      return { city: ipInfo.city, restricted: false };
    }
    
    // Device ID yoksa, IP'den şehir bul
    console.log(`🆕 Yeni Device ID: ${deviceId}, IP: ${ipAddress}`);
    const ipInfo = await getCityFromIP(ipAddress);
    
    if (ipInfo.restricted) {
      return { city: null, restricted: true };
    }
    
    // Yeni kayıt oluştur
    userLocation = new UserLocation({
      deviceId: deviceId,
      ipAddress: ipAddress,
      city: ipInfo.city,
      country: ipInfo.country
    });
    await userLocation.save();
    
    console.log(`✅ Yeni şehir kaydı: ${deviceId} -> ${ipInfo.city}`);
    return { city: ipInfo.city, restricted: false };
    
  } catch (error) {
    console.error('❌ Şehir bulma hatası:', error);
    return { city: 'Genel', restricted: false };
  }
}

// Kullanıcı profilini getir veya oluştur
async function getOrCreateUserProfile(userData) {
  try {
    let userProfile = await UserProfile.findOne({ userId: userData.userId });
    
    if (!userProfile) {
      userProfile = new UserProfile({
        userId: userData.userId,
        userName: userData.userName,
        userPhoto: userData.userPhoto || '',
        deviceId: userData.deviceId
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
      deviceId: userData.deviceId
    };
  }
}

// Kullanıcı rengi oluşturma
function generateColor(username) {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
  ];
  const index = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[index % colors.length];
}

// Oda kullanıcılarını güncelle
function updateRoomUsers(city) {
  if (!rooms.has(city)) return;
  
  const roomUsers = Array.from(rooms.get(city))
    .map(socketId => activeUsers.get(socketId))
    .filter(user => user !== undefined)
    .map(user => ({
      userId: user.id,
      userName: user.userName,
      userPhoto: user.userPhoto,
      city: user.city,
      userColor: user.userColor
    }));

  io.to(city).emit('user-list-update', roomUsers);
}

// Socket.io bağlantı yönetimi
io.on('connection', async (socket) => {
  console.log('🔗 Yeni kullanıcı bağlandı:', socket.id);

  // Heartbeat mekanizması
  let heartbeatInterval = setInterval(() => {
    socket.emit('ping');
  }, 20000);

  socket.on('pong', () => {
    // Heartbeat alındı
  });

  socket.on('user-join', async (userData) => {
    try {
      const clientIP = socket.handshake.headers['x-forwarded-for'] || 
                      socket.handshake.address || 
                      socket.conn.remoteAddress;

      console.log('👤 Kullanıcı katılıyor:', userData.userName);
      console.log('📱 Device ID:', userData.deviceId);
      console.log('🌐 IP:', clientIP);

      // Kullanıcıya şehir ataması yap (IP tabanlı) - YENİ
      const locationInfo = await getOrCreateUserCity(userData.deviceId, clientIP);
      
      // Bölge kısıtlaması kontrolü - YENİ
      if (locationInfo.restricted) {
        socket.emit('user-assigned', { restricted: true });
        return;
      }
      
      // Kullanıcı profilini kaydet
      const userProfile = await getOrCreateUserProfile({
        ...userData,
        deviceId: userData.deviceId
      });

      const user = {
        id: userProfile.userId,
        socketId: socket.id,
        userName: userProfile.userName,
        userPhoto: userProfile.userPhoto,
        city: locationInfo.city,
        userColor: generateColor(userProfile.userName),
        deviceId: userData.deviceId,
        joinedAt: new Date()
      };

      // Kullanıcıyı kaydet
      activeUsers.set(socket.id, user);
      
      // Odaya ekle
      if (!rooms.has(locationInfo.city)) {
        rooms.set(locationInfo.city, new Set());
      }
      rooms.get(locationInfo.city).add(socket.id);

      socket.join(locationInfo.city);

      // Kullanıcıya şehir bilgisini gönder
      socket.emit('user-assigned', {
        userId: user.id,
        userName: user.userName,
        city: locationInfo.city,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        restricted: false
      });

      // Oda kullanıcılarını güncelle
      updateRoomUsers(locationInfo.city);

      socket.to(locationInfo.city).emit('user-joined', {
        userName: user.userName
      });

      console.log(`✅ ${user.userName} ${locationInfo.city} odasına katıldı`);

    } catch (error) {
      console.error('❌ Kullanıcı katılma hatası:', error);
      socket.emit('error', { message: 'Şehir belirleme hatası' });
    }
  });

  socket.on('message', async (messageData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) return;

      const message = {
        id: messageData.id,
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        userName: user.userName,
        userPhoto: user.userPhoto,
        userColor: user.userColor,
        room: user.city
      };

      if (messageData.text) {
        message.text = messageData.text;
        message.type = 'text';
        console.log(`💬 ${user.userName} (${user.city}): ${message.text}`);
      }
      else if (messageData.audio) {
        message.audio = messageData.audio;
        message.duration = messageData.duration || 0;
        message.type = 'audio';
        console.log(`🎤 ${user.userName} (${user.city}): Ses mesajı`);
      }
      else if (messageData.media) {
        message.media = messageData.media;
        message.mediaType = messageData.mediaType;
        message.caption = messageData.caption;
        message.type = 'media';
        console.log(`📷 ${user.userName} (${user.city}): ${messageData.mediaType} gönderdi`);
      }

      // Mesajı veritabanına kaydet
      try {
        const dbMessage = new Message({
          messageId: message.id,
          userId: user.id,
          userName: user.userName,
          userPhoto: user.userPhoto,
          userColor: user.userColor,
          room: user.city,
          text: message.text,
          media: message.media,
          mediaType: message.mediaType,
          caption: message.caption,
          audio: message.audio,
          duration: message.duration,
          type: message.type
        });
        await dbMessage.save();
      } catch (dbError) {
        console.error('❌ Mesaj veritabanı kayıt hatası:', dbError);
      }

      io.to(user.city).emit('message', message);

    } catch (error) {
      console.error('❌ Mesaj hatası:', error);
    }
  });

  // YENİ: Mesaj düzenleme event'i
  socket.on('edit-message', async (editData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) return;

      // Mesajı veritabanında bul ve sahiplik kontrolü yap
      const message = await Message.findOne({ 
        messageId: editData.messageId,
        userId: user.id // Sadece kendi mesajını düzenleyebilir
      });

      if (!message) {
        socket.emit('error', { message: 'Mesaj bulunamadı veya düzenleme yetkiniz yok' });
        return;
      }

      // Mesajı güncelle
      message.text = editData.newText;
      message.edited = true;
      message.editedAt = new Date();
      await message.save();

      // Güncellenen mesajı odaya yayınla
      io.to(user.city).emit('message-edited', {
        messageId: editData.messageId,
        newText: editData.newText,
        editedAt: message.editedAt,
        userName: user.userName
      });

      console.log(`✏️ ${user.userName} mesajını düzenledi: ${editData.messageId}`);

    } catch (error) {
      console.error('❌ Mesaj düzenleme hatası:', error);
      socket.emit('error', { message: 'Mesaj düzenlenemedi' });
    }
  });

  // YENİ: Mesaj silme event'i
  socket.on('delete-message', async (deleteData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) return;

      // Mesajı veritabanında bul ve sahiplik kontrolü yap
      const message = await Message.findOne({ 
        messageId: deleteData.messageId,
        userId: user.id // Sadece kendi mesajını silebilir
      });

      if (!message) {
        socket.emit('error', { message: 'Mesaj bulunamadı veya silme yetkiniz yok' });
        return;
      }

      // Mesajı veritabanından tamamen sil
      await Message.deleteOne({ messageId: deleteData.messageId });

      // Silinen mesajı odaya yayınla
      io.to(user.city).emit('message-deleted', {
        messageId: deleteData.messageId
      });

      console.log(`🗑️ ${user.userName} mesajını sildi: ${deleteData.messageId}`);

    } catch (error) {
      console.error('❌ Mesaj silme hatası:', error);
      socket.emit('error', { message: 'Mesaj silinemedi' });
    }
  });

  socket.on('typing', (isTyping) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.to(user.city).emit('typing', {
        userName: user.userName,
        isTyping: isTyping
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 Kullanıcı ayrıldı:', socket.id, reason);
    
    clearInterval(heartbeatInterval);
    
    const user = activeUsers.get(socket.id);
    if (user) {
      activeUsers.delete(socket.id);
      
      if (rooms.has(user.city)) {
        rooms.get(user.city).delete(socket.id);
      }

      updateRoomUsers(user.city);
      
      socket.to(user.city).emit('user-left', {
        userName: user.userName
      });
    }
  });
});

// API Routes
app.get('/health', async (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      database: dbStatus,
      activeUsers: activeUsers.size,
      rooms: Array.from(rooms.keys())
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Kullanıcı istatistikleri
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await UserProfile.countDocuments();
    const totalLocations = await UserLocation.countDocuments();
    const cities = await UserLocation.aggregate([
      { $group: { _id: '$city', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      totalUsers,
      totalLocations,
      cities
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
});
