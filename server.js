const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

// MongoDB bağlantısı
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-app', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB bağlantısı başarılı'))
.catch(err => console.error('MongoDB bağlantı hatası:', err));

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

// IP'den şehir bulma
async function getCityFromIP(ip) {
    try {
        // Vercel'de gerçek IP'yi almak için
        const realIP = ip.includes('::ffff:') ? ip.split(':').pop() : ip;
        
        const response = await axios.get(`http://ip-api.com/json/${realIP}?fields=status,message,city,country`);
        
        if (response.data.status === 'success' && response.data.city) {
            const city = response.data.city;
            
            // Türkçe şehir isimleriyle eşleştirme
            const turkishCity = TURKISH_CITIES.find(turkishCity => 
                city.toLowerCase().includes(turkishCity.toLowerCase()) ||
                turkishCity.toLowerCase().includes(city.toLowerCase())
            );
            
            return turkishCity || 'Genel';
        }
    } catch (error) {
        console.error('IP lookup error:', error.message);
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
        let userProfile = await UserProfile.findOne({ userId: userData.userId });
        
        if (!userProfile) {
            userProfile = new UserProfile({
                userId: userData.userId,
                userName: userData.userName,
                userPhoto: userData.userPhoto || '',
                city: userData.city || 'Genel'
            });
            await userProfile.save();
            console.log('Yeni kullanıcı profili oluşturuldu:', userData.userName);
        } else {
            // Profili güncelle
            userProfile.userName = userData.userName;
            userProfile.userPhoto = userData.userPhoto || userProfile.userPhoto;
            userProfile.lastSeen = new Date();
            await userProfile.save();
            console.log('Kullanıcı profili güncellendi:', userData.userName);
        }
        
        return userProfile;
    } catch (error) {
        console.error('Kullanıcı profili hatası:', error);
        throw error;
    }
}

// Oda işlemleri
function getRoomUsers(room) {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    return Array.from(rooms.get(room)).map(userId => {
        const socketId = Array.from(socketToUser.entries()).find(([_, uid]) => uid === userId)?.[0];
        return socketId ? { userId, socketId } : null;
    }).filter(Boolean);
}

function addUserToRoom(userId, room, socketId) {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    rooms.get(room).add(userId);
    socketToUser.set(socketId, userId);
}

function removeUserFromRoom(socketId, room) {
    const userId = socketToUser.get(socketId);
    if (userId && rooms.has(room)) {
        rooms.get(room).delete(userId);
        if (rooms.get(room).size === 0) {
            rooms.delete(room);
        }
    }
    socketToUser.delete(socketId);
}

// Socket.io bağlantı yönetimi
io.on('connection', async (socket) => {
    console.log('Yeni kullanıcı bağlandı:', socket.id);

    try {
        // IP'den şehir belirleme
        const clientIP = socket.handshake.headers['x-forwarded-for'] || 
                        socket.handshake.address || 
                        socket.conn.remoteAddress;
        
        const city = await getCityFromIP(clientIP);
        console.log(`Kullanıcı ${socket.id} şehri: ${city}`);

        // İlk bağlantıda kullanıcı bilgilerini bekle
        socket.on('user-join', async (userData) => {
            try {
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

                addUserToRoom(user.id, city, socket.id);

                // Kullanıcıya bilgilerini gönder
                socket.emit('user-assigned', {
                    userId: user.id,
                    userName: user.userName,
                    city: city,
                    userPhoto: user.userPhoto,
                    userColor: user.userColor
                });

                // Kullanıcıyı odaya ekle
                socket.join(city);

                // Odadaki kullanıcı listesini güncelle
                const roomUsers = await Promise.all(
                    getRoomUsers(city).map(async (userInfo) => {
                        const profile = await UserProfile.findOne({ userId: userInfo.userId });
                        return profile ? {
                            userId: profile.userId,
                            userName: profile.userName,
                            userPhoto: profile.userPhoto,
                            city: profile.city,
                            userColor: generateColor(profile.userName)
                        } : null;
                    })
                ).then(users => users.filter(Boolean));

                io.to(city).emit('user-list-update', roomUsers);

                // Kullanıcı katıldı bildirimi
                socket.to(city).emit('user-joined', {
                    userName: user.userName,
                    users: roomUsers
                });

                console.log(`Kullanıcı ${user.userName} ${city} odasına katıldı`);

            } catch (error) {
                console.error('Kullanıcı katılma hatası:', error);
                socket.emit('error', { message: 'Kullanıcı kaydı hatası' });
            }
        });

        // Profil güncelleme
        socket.on('update-profile', async (profileData) => {
            try {
                const userProfile = await UserProfile.findOneAndUpdate(
                    { userId: profileData.userId },
                    {
                        userName: profileData.userName,
                        userPhoto: profileData.userPhoto,
                        lastSeen: new Date()
                    },
                    { new: true }
                );

                if (userProfile) {
                    // Tüm odalara profil güncelleme bildirimi gönder
                    const roomUsers = getRoomUsers(userProfile.city);
                    roomUsers.forEach(userInfo => {
                        io.to(userInfo.socketId).emit('profile-updated', {
                            userId: userProfile.userId,
                            userName: userProfile.userName,
                            userPhoto: userProfile.userPhoto,
                            oldUserName: profileData.oldUserName
                        });
                    });

                    console.log(`Profil güncellendi: ${userProfile.userName}`);
                }
            } catch (error) {
                console.error('Profil güncelleme hatası:', error);
            }
        });

        // Mesaj alma
        socket.on('message', async (messageData) => {
            try {
                const userId = socketToUser.get(socket.id);
                if (!userId) return;

                const userProfile = await UserProfile.findOne({ userId: userId });
                if (!userProfile) return;

                const message = {
                    id: messageData.id,
                    text: messageData.text,
                    time: messageData.time,
                    userName: userProfile.userName,
                    userPhoto: userProfile.userPhoto,
                    userColor: generateColor(userProfile.userName),
                    room: userProfile.city,
                    seen: false
                };

                // Odaya mesajı yayınla
                io.to(userProfile.city).emit('message', message);
                console.log(`Mesaj ${userProfile.city} odasında yayınlandı:`, message.text);
            } catch (error) {
                console.error('Mesaj gönderme hatası:', error);
            }
        });

        // Yazıyor indikatörü
        socket.on('typing', async (isTyping) => {
            try {
                const userId = socketToUser.get(socket.id);
                if (!userId) return;

                const userProfile = await UserProfile.findOne({ userId: userId });
                if (!userProfile) return;

                socket.to(userProfile.city).emit('typing', {
                    userName: userProfile.userName,
                    isTyping: isTyping
                });
            } catch (error) {
                console.error('Typing indicator hatası:', error);
            }
        });

        // Mesaj okundu
        socket.on('message-seen', (data) => {
            try {
                const userId = socketToUser.get(socket.id);
                if (!userId) return;

                // Mesajın okunduğunu odadaki herkese bildir
                io.to(data.room).emit('message-seen', {
                    messageId: data.messageId,
                    seenBy: userId
                });
            } catch (error) {
                console.error('Mesaj okundu hatası:', error);
            }
        });

        // Bağlantı kesilme
        socket.on('disconnect', async () => {
            console.log('Kullanıcı ayrıldı:', socket.id);

            try {
                const userId = socketToUser.get(socket.id);
                if (!userId) return;

                const userProfile = await UserProfile.findOne({ userId: userId });
                if (!userProfile) return;

                // Kullanıcıyı odadan çıkar
                removeUserFromRoom(socket.id, userProfile.city);

                // Odadaki kullanıcı listesini güncelle
                const roomUsers = await Promise.all(
                    getRoomUsers(userProfile.city).map(async (userInfo) => {
                        const profile = await UserProfile.findOne({ userId: userInfo.userId });
                        return profile ? {
                            userId: profile.userId,
                            userName: profile.userName,
                            userPhoto: profile.userPhoto,
                            city: profile.city,
                            userColor: generateColor(profile.userName)
                        } : null;
                    })
                ).then(users => users.filter(Boolean));

                io.to(userProfile.city).emit('user-left', {
                    userName: userProfile.userName,
                    users: roomUsers
                });

                io.to(userProfile.city).emit('user-list-update', roomUsers);

                console.log(`Kullanıcı ${userProfile.userName} ${userProfile.city} odasından ayrıldı`);
            } catch (error) {
                console.error('Kullanıcı ayrılma hatası:', error);
            }
        });

    } catch (error) {
        console.error('Kullanıcı bağlantı hatası:', error);
        socket.emit('error', { message: 'Şehir belirleme hatası' });
    }
});

// API Routes
app.get('/api/users/:userId', async (req, res) => {
    try {
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
            rooms: Array.from(rooms.keys()).length,
            connectedUsers: socketToUser.size
        });
    } catch (error) {
        res.status(500).json({ status: 'ERROR', error: error.message });
    }
});

// Ana sayfa
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Hata yönetimi
process.on('uncaughtException', (error) => {
    console.error('Beklenmeyen hata:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('İşlenmemiş promise reddi:', reason);
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor`);
    console.log(`Sağlık kontrolü: http://localhost:${PORT}/health`);
    console.log(`MongoDB durumu: ${mongoose.connection.readyState === 1 ? 'Bağlı' : 'Bağlı değil'}`);
});

module.exports = app;
