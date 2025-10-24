const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

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
const users = new Map();

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

// Kullanıcı ID oluşturma
function generateUserId() {
    return Math.random().toString(36).substr(2, 9);
}

// Kullanıcı adı oluşturma
function generateUserName() {
    const adjectives = ['Hızlı', 'Mutlu', 'Zeki', 'Sessiz', 'Enerjik', 'Dost', 'Neşeli', 'Sakin'];
    const nouns = ['Kaplan', 'Kartal', 'Yunus', 'Kurt', 'Aslan', 'Kelebek', 'Kuzu', 'Panda'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj}${noun}${Math.floor(Math.random() * 1000)}`;
}

// Renk oluşturma
function generateColor(username) {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
        '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
        '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D7BDE2'
    ];
    const index = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[index % colors.length];
}

// Oda işlemleri
function getRoomUsers(room) {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    return Array.from(rooms.get(room)).map(userId => users.get(userId)).filter(Boolean);
}

function addUserToRoom(userId, room) {
    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    rooms.get(room).add(userId);
}

function removeUserFromRoom(userId, room) {
    if (rooms.has(room)) {
        rooms.get(room).delete(userId);
        if (rooms.get(room).size === 0) {
            rooms.delete(room);
        }
    }
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

        // Kullanıcı oluşturma
        const userId = generateUserId();
        const userName = generateUserName();
        const userColor = generateColor(userName);

        const user = {
            id: userId,
            socketId: socket.id,
            userName: userName,
            city: city,
            userColor: userColor,
            room: city,
            joinedAt: new Date()
        };

        users.set(userId, user);
        addUserToRoom(userId, city);

        // Kullanıcıya bilgilerini gönder
        socket.emit('user-assigned', {
            userId: userId,
            userName: userName,
            city: city,
            userColor: userColor
        });

        // Kullanıcıyı odaya ekle
        socket.join(city);

        // Odadaki kullanıcı listesini güncelle
        const roomUsers = getRoomUsers(city);
        io.to(city).emit('user-list-update', roomUsers);

        // Kullanıcı katıldı bildirimi
        socket.to(city).emit('user-joined', {
            userName: userName,
            users: roomUsers
        });

        console.log(`Kullanıcı ${userName} ${city} odasına katıldı`);

        // Mesaj alma
        socket.on('message', (messageData) => {
            const user = users.get(userId);
            if (!user) return;

            const message = {
                id: messageData.id,
                text: messageData.text,
                time: messageData.time,
                userName: user.userName,
                userColor: user.userColor,
                room: user.room,
                seen: false
            };

            // Odaya mesajı yayınla
            io.to(user.room).emit('message', message);
            console.log(`Mesaj ${user.room} odasında yayınlandı:`, message.text);
        });

        // Yazıyor indikatörü
        socket.on('typing', (isTyping) => {
            const user = users.get(userId);
            if (!user) return;

            socket.to(user.room).emit('typing', {
                userName: user.userName,
                isTyping: isTyping
            });
        });

        // Mesaj okundu
        socket.on('message-seen', (data) => {
            const user = users.get(userId);
            if (!user) return;

            // Mesajın okunduğunu odadaki herkese bildir
            io.to(data.room).emit('message-seen', {
                messageId: data.messageId,
                seenBy: user.userName
            });
        });

        // Bağlantı kesilme
        socket.on('disconnect', () => {
            console.log('Kullanıcı ayrıldı:', socket.id);

            const user = users.get(userId);
            if (!user) return;

            // Kullanıcıyı odadan çıkar
            removeUserFromRoom(userId, user.room);
            users.delete(userId);

            // Odadaki kullanıcı listesini güncelle
            const roomUsers = getRoomUsers(user.room);
            io.to(user.room).emit('user-left', {
                userName: user.userName,
                users: roomUsers
            });

            io.to(user.room).emit('user-list-update', roomUsers);
        });

    } catch (error) {
        console.error('Kullanıcı bağlantı hatası:', error);
        socket.emit('error', { message: 'Şehir belirleme hatası' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        users: users.size,
        rooms: Array.from(rooms.keys())
    });
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
});

module.exports = app;
