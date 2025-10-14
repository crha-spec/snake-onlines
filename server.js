const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Veri saklama (gerçek uygulamada veritabanı kullanın)
let users = [];
let chats = [];
let messages = [];
let onlineUsers = new Map();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Yardımcı fonksiyonlar

// Kullanıcıyı ID'ye göre bul
function findUserById(id) {
    return users.find(user => user.id === id);
}

// Kullanıcıyı email'e göre bul
function findUserByEmail(email) {
    return users.find(user => user.email === email);
}

// Kullanıcıyı deviceId'ye göre bul
function findUserByDeviceId(deviceId) {
    return users.find(user => user.devices && user.devices.includes(deviceId));
}

// Sohbeti bul veya oluştur
function findOrCreateChat(user1Id, user2Id) {
    let chat = chats.find(c => 
        c.participants.includes(user1Id) && c.participants.includes(user2Id)
    );
    
    if (!chat) {
        chat = {
            id: uuidv4(),
            participants: [user1Id, user2Id],
            createdAt: new Date().toISOString()
        };
        chats.push(chat);
    }
    
    return chat;
}

// Kullanıcının sohbetlerini getir
function getUserChats(userId) {
    return chats
        .filter(chat => chat.participants.includes(userId))
        .map(chat => {
            const otherUserId = chat.participants.find(id => id !== userId);
            const otherUser = findUserById(otherUserId);
            const chatMessages = messages.filter(msg => msg.chatId === chat.id);
            
            return {
                ...chat,
                participants: [findUserById(userId), otherUser].filter(Boolean),
                messages: chatMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
            };
        })
        .sort((a, b) => {
            const aLastMessage = a.messages[a.messages.length - 1];
            const bLastMessage = b.messages[b.messages.length - 1];
            
            if (!aLastMessage && !bLastMessage) return 0;
            if (!aLastMessage) return 1;
            if (!bLastMessage) return -1;
            
            return new Date(bLastMessage.timestamp) - new Date(aLastMessage.timestamp);
        });
}

// API Routes

// Cihaz doğrulama
app.post('/api/verify-device', (req, res) => {
    const { deviceId } = req.body;
    
    if (!deviceId) {
        return res.json({ success: false, message: 'Cihaz ID gerekli' });
    }
    
    const user = findUserByDeviceId(deviceId);
    
    if (user) {
        // Hassas bilgileri çıkar
        const { password, devices, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } else {
        res.json({ success: false, message: 'Cihaz kayıtlı değil' });
    }
});

// Kullanıcı kaydı
app.post('/api/register', async (req, res) => {
    const { email, password, deviceId } = req.body;
    
    if (!email || !password) {
        return res.json({ success: false, message: 'Email ve şifre gerekli' });
    }
    
    // Email formatı kontrolü (Gmail)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const gmailRegex = /@gmail\.com$/i;
    
    if (!emailRegex.test(email) || !gmailRegex.test(email)) {
        return res.json({ success: false, message: 'Geçerli bir Gmail adresi girin' });
    }
    
    if (password.length < 8) {
        return res.json({ success: false, message: 'Şifre en az 8 karakter olmalıdır' });
    }
    
    // Email kontrolü
    if (findUserByEmail(email)) {
        return res.json({ success: false, message: 'Bu email zaten kayıtlı' });
    }
    
    try {
        // Şifreyi hash'le
        const hashedPassword = await bcrypt.hash(password, 12);
        
        // Yeni kullanıcı oluştur
        const newUser = {
            id: uuidv4(),
            email,
            password: hashedPassword,
            username: email.split('@')[0], // Varsayılan kullanıcı adı
            bio: '',
            avatar: '',
            devices: deviceId ? [deviceId] : [],
            createdAt: new Date().toISOString()
        };
        
        users.push(newUser);
        
        // Hassas bilgileri çıkar
        const { password: _, devices, ...safeUser } = newUser;
        
        res.json({ 
            success: true, 
            user: safeUser,
            message: 'Hesap başarıyla oluşturuldu'
        });
    } catch (error) {
        console.error('Kayıt hatası:', error);
        res.json({ success: false, message: 'Kayıt sırasında bir hata oluştu' });
    }
});

// Giriş
app.post('/api/login', async (req, res) => {
    const { email, password, deviceId } = req.body;
    
    if (!email || !password) {
        return res.json({ success: false, message: 'Email ve şifre gerekli' });
    }
    
    const user = findUserByEmail(email);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    try {
        // Şifre kontrolü
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
            return res.json({ success: false, message: 'Geçersiz şifre' });
        }
        
        // Cihaz ID'sini kaydet
        if (deviceId && !user.devices.includes(deviceId)) {
            user.devices.push(deviceId);
        }
        
        // Hassas bilgileri çıkar
        const { password: _, devices, ...safeUser } = user;
        
        res.json({ 
            success: true, 
            user: safeUser,
            message: 'Başarıyla giriş yapıldı'
        });
    } catch (error) {
        console.error('Giriş hatası:', error);
        res.json({ success: false, message: 'Giriş sırasında bir hata oluştu' });
    }
});

// Profil güncelleme
app.post('/api/update-profile', (req, res) => {
    const { userId, username, bio, avatar } = req.body;
    
    if (!userId) {
        return res.json({ success: false, message: 'Kullanıcı ID gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    // Kullanıcı adı kontrolü
    if (username) {
        const existingUser = users.find(u => u.username === username && u.id !== userId);
        if (existingUser) {
            return res.json({ success: false, message: 'Bu kullanıcı adı zaten alınmış' });
        }
        user.username = username;
    }
    
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    
    // Hassas bilgileri çıkar
    const { password, devices, ...safeUser } = user;
    
    res.json({ 
        success: true, 
        user: safeUser,
        message: 'Profil başarıyla güncellendi'
    });
});

// Kullanıcı bilgisi getir
app.get('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    const user = findUserById(userId);
    
    if (user) {
        const { password, devices, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } else {
        res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
});

// Tüm kullanıcıları getir (demo amaçlı)
app.get('/api/users', (req, res) => {
    const safeUsers = users.map(user => {
        const { password, devices, ...safeUser } = user;
        return safeUser;
    });
    
    res.json({ success: true, users: safeUsers });
});

// Kullanıcı sohbetlerini getir
app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;
    const userChats = getUserChats(userId);
    
    res.json({ success: true, chats: userChats });
});

// Çıkış
app.post('/api/logout', (req, res) => {
    const { userId, deviceId } = req.body;
    
    if (userId && deviceId) {
        const user = findUserById(userId);
        if (user && user.devices) {
            user.devices = user.devices.filter(id => id !== deviceId);
        }
    }
    
    res.json({ success: true, message: 'Başarıyla çıkış yapıldı' });
});

// Socket.IO bağlantıları
io.on('connection', (socket) => {
    console.log('Yeni kullanıcı bağlandı:', socket.id);
    
    // Kimlik doğrulama
    socket.on('authenticate', ({ userId, deviceId }) => {
        const user = findUserById(userId);
        
        if (user && user.devices && user.devices.includes(deviceId)) {
            socket.userId = userId;
            onlineUsers.set(userId, socket.id);
            
            // Kullanıcının çevrimiçi olduğunu bildir
            socket.broadcast.emit('user_online', userId);
            
            console.log(`Kullanıcı doğrulandı: ${user.username} (${userId})`);
        } else {
            console.log('Geçersiz kimlik doğrulama:', userId);
            socket.disconnect();
        }
    });
    
    // Mesaj gönderme
    socket.on('send_message', (messageData) => {
        if (!socket.userId) {
            console.log('Kimlik doğrulaması yapılmamış kullanıcı mesaj göndermeye çalıştı');
            return;
        }
        
        const { chatId, text } = messageData;
        
        if (!chatId || !text) {
            console.log('Geçersiz mesaj verisi');
            return;
        }
        
        // Mesajı oluştur
        const message = {
            id: uuidv4(),
            chatId,
            senderId: socket.userId,
            text: text.trim(),
            timestamp: new Date().toISOString()
        };
        
        // Mesajı kaydet
        messages.push(message);
        
        // Sohbeti bul
        const chat = chats.find(c => c.id === chatId);
        if (!chat) {
            console.log('Sohbet bulunamadı:', chatId);
            return;
        }
        
        // Alıcıyı bul
        const receiverId = chat.participants.find(id => id !== socket.userId);
        
        // Mesajı gönderen ve alıcıya gönder
        socket.emit('new_message', message);
        
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new_message', message);
        }
        
        console.log(`Mesaj gönderildi: ${socket.userId} -> ${receiverId}`);
    });
    
    // Bağlantı kesildiğinde
    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            socket.broadcast.emit('user_offline', socket.userId);
            console.log(`Kullanıcı ayrıldı: ${socket.userId}`);
        }
    });
});

// Hata yakalama
process.on('uncaughtException', (error) => {
    console.error('Beklenmeyen hata:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('İşlenmemiş promise:', promise, 'Sebep:', reason);
});

// Sunucuyu başlat
server.listen(PORT, () => {
    console.log(`🚀 InstaChat sunucusu ${PORT} portunda çalışıyor`);
    console.log(`📱 Socket.IO hazır`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Sunucu kapatılıyor...');
    server.close(() => {
        console.log('✅ Sunucu başarıyla kapatıldı');
        process.exit(0);
    });
});
