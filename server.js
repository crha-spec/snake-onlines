const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

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
let stories = [];
let storyLikes = [];
let onlineUsers = new Map();

// Middleware
app.use(express.json({ limit: '10mb' }));
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
        (c.participants.includes(user1Id) && c.participants.includes(user2Id))
    );
    
    if (!chat) {
        chat = {
            id: uuidv4(),
            participants: [user1Id, user2Id],
            createdAt: new Date().toISOString()
        };
        chats.push(chat);
        
        console.log('Yeni sohbet oluşturuldu:', chat.id);
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
                messages: chatMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
                lastMessage: chatMessages[chatMessages.length - 1]
            };
        })
        .sort((a, b) => {
            const aLastMessage = a.lastMessage;
            const bLastMessage = b.lastMessage;
            
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
    
    // Email formatı kontrolü (Gmail)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const gmailRegex = /@gmail\.com$/i;
    
    if (!emailRegex.test(email) || !gmailRegex.test(email)) {
        return res.json({ success: false, message: 'Geçerli bir Gmail adresi girin' });
    }
    
    if (password.length < 8) {
        return res.json({ success: false, message: 'Şifre en az 8 karakter olmalıdır' });
    }
    
    // Email kontrolü - AYNI EMAIL İLE KAYIT ENGELLENDİ
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
            username: email.split('@')[0],
            bio: '',
            avatar: '',
            devices: deviceId ? [deviceId] : [],
            hideActivity: false,
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
    
    if (username) {
        const existingUser = users.find(u => u.username === username && u.id !== userId);
        if (existingUser) {
            return res.json({ success: false, message: 'Bu kullanıcı adı zaten alınmış' });
        }
        user.username = username;
    }
    
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    
    const { password, devices, ...safeUser } = user;
    
    res.json({ 
        success: true, 
        user: safeUser,
        message: 'Profil başarıyla güncellendi'
    });
});

// Ayarları güncelle
app.post('/api/update-settings', (req, res) => {
    const { userId, hideActivity } = req.body;
    
    if (!userId) {
        return res.json({ success: false, message: 'Kullanıcı ID gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    if (hideActivity !== undefined) user.hideActivity = hideActivity;
    
    const { password, devices, ...safeUser } = user;
    
    res.json({ 
        success: true, 
        user: safeUser,
        message: 'Ayarlar güncellendi'
    });
});

// Şifre değiştirme
app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    
    if (!userId || !currentPassword || !newPassword) {
        return res.json({ success: false, message: 'Tüm alanlar gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    try {
        const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
        
        if (!isPasswordValid) {
            return res.json({ success: false, message: 'Mevcut şifre yanlış' });
        }
        
        if (newPassword.length < 8) {
            return res.json({ success: false, message: 'Yeni şifre en az 8 karakter olmalıdır' });
        }
        
        // Yeni şifreyi hash'le
        const hashedNewPassword = await bcrypt.hash(newPassword, 12);
        user.password = hashedNewPassword;
        
        console.log('Şifre güncellendi - Kullanıcı:', user.email);
        
        res.json({ 
            success: true, 
            message: 'Şifre başarıyla değiştirildi'
        });
    } catch (error) {
        console.error('Şifre değiştirme hatası:', error);
        res.json({ success: false, message: 'Bir hata oluştu' });
    }
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

// Online kullanıcıları getir
app.get('/api/online-users', (req, res) => {
    const onlineUserIds = Array.from(onlineUsers.keys());
    res.json({ success: true, onlineUsers: onlineUserIds });
});

// Kullanıcı sohbetlerini getir
app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;
    const userChats = getUserChats(userId);
    
    res.json({ success: true, chats: userChats });
});

// Yeni sohbet başlat
app.post('/api/start-chat', (req, res) => {
    const { userId, otherUserId } = req.body;
    
    if (!userId || !otherUserId) {
        return res.json({ success: false, message: 'Kullanıcı ID gerekli' });
    }
    
    const user = findUserById(userId);
    const otherUser = findUserById(otherUserId);
    
    if (!user || !otherUser) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    const chat = findOrCreateChat(userId, otherUserId);
    const userChats = getUserChats(userId);
    
    res.json({ 
        success: true, 
        chat: userChats.find(c => c.id === chat.id),
        message: 'Sohbet başlatıldı'
    });
});

// Story yükleme
app.post('/api/upload-story', (req, res) => {
    const { userId, imageData } = req.body;
    
    if (!userId || !imageData) {
        return res.json({ success: false, message: 'Kullanıcı ID ve resim gerekli' });
    }
    
    const user = findUserById(userId);
    
    if (!user) {
        return res.json({ success: false, message: 'Kullanıcı bulunamadı' });
    }
    
    const story = {
        id: uuidv4(),
        userId,
        imageData,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 saat
        views: [],
        likes: []
    };
    
    stories.push(story);
    
    // Eski storyleri temizle (24 saatten eski)
    stories = stories.filter(s => new Date(s.expiresAt) > new Date());
    
    res.json({ 
        success: true, 
        story,
        message: 'Story başarıyla yüklendi'
    });
});

// Storyleri getir
app.get('/api/stories', (req, res) => {
    // Aktif storyleri getir (24 saatten yeni)
    const activeStories = stories.filter(s => new Date(s.expiresAt) > new Date());
    
    // Kullanıcıya göre grupla
    const groupedStories = {};
    
    activeStories.forEach(story => {
        const user = findUserById(story.userId);
        if (user) {
            if (!groupedStories[story.userId]) {
                groupedStories[story.userId] = {
                    user: {
                        id: user.id,
                        username: user.username,
                        avatar: user.avatar
                    },
                    stories: []
                };
            }
            groupedStories[story.userId].stories.push(story);
        }
    });
    
    res.json({ success: true, stories: Object.values(groupedStories) });
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
        
        // Beğeni bildirimi oluştur
        const like = {
            id: uuidv4(),
            storyId,
            userId,
            storyOwnerId: story.userId,
            createdAt: new Date().toISOString()
        };
        storyLikes.push(like);
        
        // Socket ile bildirim gönder
        const ownerSocketId = onlineUsers.get(story.userId);
        if (ownerSocketId) {
            io.to(ownerSocketId).emit('story_liked', like);
        }
    }
    
    res.json({ 
        success: true, 
        likes: story.likes.length,
        message: 'Story beğenildi'
    });
});

// Story beğenilerini getir
app.get('/api/story-likes/:userId', (req, res) => {
    const { userId } = req.params;
    
    const userStoryLikes = storyLikes.filter(like => like.storyOwnerId === userId);
    
    const enrichedLikes = userStoryLikes.map(like => {
        const user = findUserById(like.userId);
        const story = stories.find(s => s.id === like.storyId);
        
        return {
            ...like,
            user: user ? {
                id: user.id,
                username: user.username,
                avatar: user.avatar
            } : null,
            story
        };
    });
    
    res.json({ success: true, likes: enrichedLikes });
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

// Ana sayfa
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
            
            // Kullanıcının çevrimiçi olduğunu bildir
            io.emit('user_online', userId);
            
            console.log(`Kullanıcı doğrulandı: ${user.username} (${userId})`);
        } else {
            console.log('Geçersiz kimlik doğrulama:', userId);
            socket.disconnect();
        }
    });
    
    socket.on('send_message', (messageData) => {
        if (!socket.userId) {
            console.log('Kimlik doğrulaması yapılmamış');
            return;
        }
        
        const { chatId, text } = messageData;
        
        if (!chatId || !text) {
            console.log('Geçersiz mesaj verisi');
            return;
        }
        
        const message = {
            id: uuidv4(),
            chatId,
            senderId: socket.userId,
            text: text.trim(),
            timestamp: new Date().toISOString()
        };
        
        messages.push(message);
        
        const chat = chats.find(c => c.id === chatId);
        if (!chat) {
            console.log('Sohbet bulunamadı:', chatId);
            return;
        }
        
        const receiverId = chat.participants.find(id => id !== socket.userId);
        
        // Mesajı gönderen ve alıcıya gönder
        socket.emit('new_message', message);
        
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('new_message', message);
        }
        
        console.log(`Mesaj gönderildi: ${socket.userId} -> ${receiverId}`);
    });
    
    socket.on('typing_start', ({ chatId }) => {
        const chat = chats.find(c => c.id === chatId);
        if (chat) {
            const receiverId = chat.participants.find(id => id !== socket.userId);
            const receiverSocketId = onlineUsers.get(receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('user_typing', { chatId, userId: socket.userId });
            }
        }
    });
    
    socket.on('typing_stop', ({ chatId }) => {
        const chat = chats.find(c => c.id === chatId);
        if (chat) {
            const receiverId = chat.participants.find(id => id !== socket.userId);
            const receiverSocketId = onlineUsers.get(receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('user_stop_typing', { chatId, userId: socket.userId });
            }
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            io.emit('user_offline', socket.userId);
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
