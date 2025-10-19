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

// Veri saklama
let users = [];
let chats = [];
let messages = [];
let stories = [];
let onlineUsers = new Map();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Yardımcı fonksiyonlar
function findUserById(id) {
    return users.find(user => user.id === id);
}

function findUserByEmail(email) {
    return users.find(user => user.email === email);
}

function findUserByDeviceId(deviceId) {
    return users.find(user => user.devices && user.devices.includes(deviceId));
}

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

function getUserChats(userId) {
    return chats
        .filter(chat => chat.participants.includes(userId))
        .map(chat => {
            const otherUserId = chat.participants.find(id => id !== userId);
            const otherUser = findUserById(otherUserId);
            const chatMessages = messages.filter(msg => msg.chatId === chat.id);
            
            return {
                ...chat,
                otherUser: otherUser,
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
    
    // Email formatı kontrolü
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const gmailRegex = /@gmail\.com$/i;
    
    if (!emailRegex.test(email) || !gmailRegex.test(email)) {
        return res.json({ success: false, message: 'Geçerli bir Gmail adresi girin' });
    }
    
    if (password.length < 8) {
        return res.json({ success: false, message: 'Şifre en az 8 karakter olmalıdır' });
    }
    
    // Email kontrolü - aynı email ile kayıt olunamaz
    const existingUser = findUserByEmail(email);
    if (existingUser) {
        return res.json({ success: false, message: 'Bu email zaten kayıtlı' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 12);
        
        const newUser = {
            id: uuidv4(),
            email,
            password: hashedPassword,
            username: email.split('@')[0],
            bio: '',
            avatar: '/assets/default-avatar.png',
            devices: deviceId ? [deviceId] : [],
            hideOnlineStatus: false,
            createdAt: new Date().toISOString()
        };
        
        users.push(newUser);
        
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
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
            return res.json({ success: false, message: 'Geçersiz şifre' });
        }
        
        if (deviceId && !user.devices.includes(deviceId)) {
            user.devices.push(deviceId);
        }
        
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

// Şifre değiştirme
app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    
    if (!userId || !currentPassword || !newPassword) {
        return res.json({ success: false, message: 'Tüm alanlar gereklidir' });
    }
    
    if (newPassword.length < 8) {
        return res.json({ success: false, message: 'Yeni şifre en az 8 karakter olmalıdır' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    try {
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
        
        if (!isCurrentPasswordValid) {
            return res.json({ success: false, message: 'Mevcut şifre yanlış' });
        }
        
        user.password = await bcrypt.hash(newPassword, 12);
        
        res.json({ 
            success: true, 
            message: 'Şifre başarıyla değiştirildi'
        });
    } catch (error) {
        console.error('Şifre değiştirme hatası:', error);
        res.json({ success: false, message: 'Şifre değiştirme sırasında bir hata oluştu' });
    }
});

// Profil güncelleme
app.post('/api/update-profile', (req, res) => {
    const { userId, username, bio, avatar, hideOnlineStatus } = req.body;
    
    if (!userId) {
        return res.json({ success: false, message: 'Kullanıcı ID gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    if (username) {
        const existingUser = users.find(u => u.username === username && u.id !== userId);
        if (existingUser) {
            return res.json({ success: false, message: 'Bu kullanıcı adı zaten alınmış' });
        }
        user.username = username;
    }
    
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    if (hideOnlineStatus !== undefined) user.hideOnlineStatus = hideOnlineStatus;
    
    const { password, devices, ...safeUser } = user;
    
    res.json({ 
        success: true, 
        user: safeUser,
        message: 'Profil başarıyla güncellendi'
    });
});

// Story yükleme (URL versiyonu)
app.post('/api/upload-story', (req, res) => {
    const { userId, imageUrl } = req.body;
    
    if (!userId || !imageUrl) {
        return res.json({ success: false, message: 'Kullanıcı ID ve resim URL gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    const story = {
        id: uuidv4(),
        userId: userId,
        imageUrl: imageUrl,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 saat
        likes: []
    };
    
    stories.push(story);
    
    res.json({ 
        success: true, 
        story: story,
        message: 'Story başarıyla yüklendi'
    });
});

// Story beğenme
app.post('/api/like-story', (req, res) => {
    const { storyId, userId } = req.body;
    
    if (!storyId || !userId) {
        return res.json({ success: false, message: 'Story ID ve kullanıcı ID gerekli' });
    }
    
    const story = stories.find(s => s.id === storyId);
    
    if (!story) {
        return res.json({ success: false, message: 'Story bulunamadı' });
    }
    
    if (!story.likes.includes(userId)) {
        story.likes.push(userId);
    }
    
    res.json({ 
        success: true, 
        likes: story.likes,
        message: 'Story beğenildi'
    });
});

// Aktif story'leri getir
app.get('/api/stories', (req, res) => {
    const now = new Date().toISOString();
    const activeStories = stories.filter(story => story.expiresAt > now);
    
    const storiesWithUsers = activeStories.map(story => {
        const user = findUserById(story.userId);
        return {
            ...story,
            user: user ? { 
                id: user.id, 
                username: user.username, 
                avatar: user.avatar,
                hideOnlineStatus: user.hideOnlineStatus 
            } : null
        };
    });
    
    res.json({ success: true, stories: storiesWithUsers });
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

// Tüm kullanıcıları getir
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

// Ana sayfa route'u
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO bağlantıları
io.on('connection', (socket) => {
    console.log('Yeni kullanıcı bağlandı:', socket.id);
    
    socket.on('authenticate', ({ userId, deviceId }) => {
        const user = findUserById(userId);
        
        if (user && user.devices && user.devices.includes(deviceId)) {
            socket.userId = userId;
            onlineUsers.set(userId, socket.id);
            
            // Kullanıcı çevrimiçi olduğunu bildir (eğer gizli değilse)
            if (!user.hideOnlineStatus) {
                socket.broadcast.emit('user_online', userId);
            }
            
            console.log(`Kullanıcı doğrulandı: ${user.username} (${userId})`);
        } else {
            console.log('Geçersiz kimlik doğrulama:', userId);
            socket.disconnect();
        }
    });
    
    socket.on('send_message', (messageData) => {
        if (!socket.userId) {
            console.log('Kimlik doğrulaması yapılmamış kullanıcı mesaj göndermeye çalıştı');
            return;
        }
        
        const { chatId, text, receiverId } = messageData;
        
        if (!chatId || !text) {
            console.log('Geçersiz mesaj verisi');
            return;
        }
        
        let chat = chats.find(c => c.id === chatId);
        if (!chat) {
            // Yeni sohbet oluştur
            chat = {
                id: chatId,
                participants: [socket.userId, receiverId],
                createdAt: new Date().toISOString()
            };
            chats.push(chat);
        }
        
        const message = {
            id: uuidv4(),
            chatId,
            senderId: socket.userId,
            text: text.trim(),
            timestamp: new Date().toISOString()
        };
        
        messages.push(message);
        
        // Mesajı gönderen ve alıcıya gönder
        socket.emit('new_message', message);
        
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new_message', message);
        }
        
        console.log(`Mesaj gönderildi: ${socket.userId} -> ${receiverId}`);
    });
    
    socket.on('user_typing', (data) => {
        const { chatId, receiverId, isTyping } = data;
        
        if (receiverId) {
            const receiverSocketId = onlineUsers.get(receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('user_typing', {
                    userId: socket.userId,
                    chatId,
                    isTyping
                });
            }
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            
            const user = findUserById(socket.userId);
            if (user && !user.hideOnlineStatus) {
                socket.broadcast.emit('user_offline', socket.userId);
            }
            
            console.log(`Kullanıcı ayrıldı: ${socket.userId}`);
        }
    });
});

// Eski story'leri temizleme
setInterval(() => {
    const now = new Date().toISOString();
    const expiredCount = stories.filter(story => story.expiresAt <= now).length;
    stories = stories.filter(story => story.expiresAt > now);
    
    if (expiredCount > 0) {
        console.log(`${expiredCount} eski story temizlendi`);
    }
}, 60 * 60 * 1000); // Her saat temizle

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
    console.log(`📁 Public dosyaları: ${path.join(__dirname, 'public')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Sunucu kapatılıyor...');
    server.close(() => {
        console.log('✅ Sunucu başarıyla kapatıldı');
        process.exit(0);
    });
});
