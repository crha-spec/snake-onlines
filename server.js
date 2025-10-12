const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// CORS ve transport ayarları
const io = new Server(server, { 
    cors: { 
        origin: '*',
        methods: ["GET", "POST"]
    }, 
    transports: ['websocket', 'polling'] // Polling de ekledik
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Oyun verileri
const rooms = new Map();
const chatHistory = new Map();
const roomTimeouts = new Map(); // Oda zaman aşımı için EKLENDİ

// Yemek oluştur fonksiyonu
function generateFood() {
    const food = [];
    const WORLD_SIZE = 5000;
    const FOOD_COUNT = 300;
    
    for (let i = 0; i < FOOD_COUNT; i++) {
        food.push({
            x: Math.random() * WORLD_SIZE,
            y: Math.random() * WORLD_SIZE,
            color: `hsl(${Math.random() * 360}, 80%, 60%)`
        });
    }
    
    return food;
}

// Benzersiz 7 haneli oda kodu oluştur EKLENDİ
function generateRoomCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    
    let attempts = 0;
    const maxAttempts = 100;
    
    do {
        result = '';
        for (let i = 0; i < 7; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        attempts++;
        
        if (attempts >= maxAttempts) {
            result = 'RM' + Date.now().toString().slice(-5);
            break;
        }
    } while (rooms.has(result));
    
    return result;
}

// Oda zaman aşımını başlat EKLENDİ
function startRoomTimeout(roomCode) {
    // Önceki zamanlayıcıyı temizle
    if (roomTimeouts.has(roomCode)) {
        clearTimeout(roomTimeouts.get(roomCode));
    }
    
    const timeout = setTimeout(() => {
        console.log(`⏰ Oda süresi doldu: ${roomCode}`);
        
        // Tüm oyunculara bildir
        io.to(roomCode).emit('roomExpired');
        
        // Verileri temizle
        rooms.delete(roomCode);
        chatHistory.delete(roomCode);
        roomTimeouts.delete(roomCode);
        
        console.log(`🗑️ Oda silindi: ${roomCode}`);
    }, 3600000); // 1 saat
    
    roomTimeouts.set(roomCode, timeout);
}

io.on('connection', socket => {
    console.log('✅ Oyuncu bağlandı:', socket.id);
    
    // Oda oluştur - GÜNCELLENDİ
    socket.on('createRoom', (data) => {
        console.log('🎮 Oda oluşturma isteği:', data);
        
        const roomCode = generateRoomCode(); // GÜNCELLENDİ
        const players = [{ id: data.playerId, name: data.playerName }];
        
        rooms.set(roomCode, {
            owner: data.playerId,
            players: players,
            status: 'waiting',
            food: generateFood()
        });
        
        chatHistory.set(roomCode, []);
        
        // Oda zaman aşımını başlat - EKLENDİ
        startRoomTimeout(roomCode);
        
        socket.join(roomCode);
        
        socket.emit('roomCreated', {
            roomCode: roomCode,
            players: players
        });
        
        console.log('✅ Oda oluşturuldu:', roomCode);
    });
    
    // Odaya katıl - GÜNCELLENDİ
    socket.on('joinRoom', (data) => {
        console.log('🚪 Odaya katılma isteği:', data);
        
        const room = rooms.get(data.roomCode);
        
        if (!room) {
            console.log('❌ Oda bulunamadı:', data.roomCode);
            socket.emit('roomNotFound');
            return;
        }
        
        // Oda kodu validasyonu - EKLENDİ
        if (data.roomCode.length !== 7) {
            socket.emit('roomError', { error: 'Oda kodu 7 haneli olmalıdır!' });
            return;
        }
        
        room.players.push({ id: data.playerId, name: data.playerName });
        
        // Zaman aşımını sıfırla - EKLENDİ
        startRoomTimeout(data.roomCode);
        
        socket.join(data.roomCode);
        
        socket.emit('roomJoined', {
            roomCode: data.roomCode,
            players: room.players
        });
        
        io.to(data.roomCode).emit('playersUpdate', room.players);
        
        const history = chatHistory.get(data.roomCode) || [];
        socket.emit('chatHistory', history);
        
        console.log('✅ Oyuncu katıldı:', data.playerName, '→', data.roomCode);
    });
    
    // Oyunu başlat
    socket.on('startGame', (data) => {
        console.log('🎮 Oyun başlatılıyor:', data.roomCode);
        
        const room = rooms.get(data.roomCode);
        if (room) {
            room.status = 'playing';
            io.to(data.roomCode).emit('gameStarted', {
                food: room.food
            });
            console.log('✅ Oyun başladı:', data.roomCode);
        }
    });
    
    // Oyuncu hareketi
    socket.on('playerMove', (data) => {
        socket.to(data.roomCode).emit('playerMoved', data);
    });
    
    // Yemek yenildi
    socket.on('foodEaten', (data) => {
        const room = rooms.get(data.roomCode);
        if (room && data.newFood) {
            // Yeni yemeği ekle
            room.food.push(data.newFood);
            
            io.to(data.roomCode).emit('foodUpdate', {
                food: room.food
            });
        }
    });
    
    // Skor transferi
    socket.on('scoreTransfer', (data) => {
        io.to(data.roomCode).emit('scoreTransfer', data);
    });
    
    // Oyuncu öldü
    socket.on('playerDied', (data) => {
        io.to(data.roomCode).emit('playerDiedFood', {
            segments: data.segments
        });
    });
    
    // Chat mesajı
    socket.on('chatMessage', (data) => {
        const message = {
            playerName: data.playerName,
            message: data.message,
            timestamp: Date.now()
        };
        
        const history = chatHistory.get(data.roomCode) || [];
        history.push(message);
        
        if (history.length > 50) {
            history.shift();
        }
        
        chatHistory.set(data.roomCode, history);
        
        io.to(data.roomCode).emit('chatMessage', message);
        
        console.log('💬 Chat:', data.playerName, '→', data.message);
    });
    
    // Oda zaman aşımı ayarı - EKLENDİ
    socket.on('setRoomTimeout', (data) => {
        startRoomTimeout(data.roomCode);
    });
    
    // Chat temizleme - EKLENDİ
    socket.on('clearChat', (data) => {
        if (chatHistory.has(data.roomCode)) {
            chatHistory.set(data.roomCode, []);
            io.to(data.roomCode).emit('chatCleared');
        }
    });
    
    // Mesaj silme - EKLENDİ
    socket.on('deleteMessage', (data) => {
        const history = chatHistory.get(data.roomCode);
        if (history) {
            // Bu özellik için daha gelişmiş bir implementasyon gerekebilir
            io.to(data.roomCode).emit('messageDeleted', { 
                messageId: data.messageId 
            });
        }
    });
    
    // Odadan çık - GÜNCELLENDİ
    socket.on('leaveRoom', (data) => {
        socket.leave(data.roomCode);
        
        const room = rooms.get(data.roomCode);
        if (room) {
            room.players = room.players.filter(p => p.id !== data.playerId);
            
            if (room.players.length === 0) {
                // Son oyuncu çıktığında zamanlayıcıyı temizle
                if (roomTimeouts.has(data.roomCode)) {
                    clearTimeout(roomTimeouts.get(data.roomCode));
                    roomTimeouts.delete(data.roomCode);
                }
                rooms.delete(data.roomCode);
                chatHistory.delete(data.roomCode);
                console.log('🗑️ Oda silindi:', data.roomCode);
            } else {
                io.to(data.roomCode).emit('playersUpdate', room.players);
            }
        }
        
        console.log('👋 Oyuncu çıktı:', data.playerId);
    });
    
    // Bağlantı kesildi - GÜNCELLENDİ
    socket.on('disconnect', () => {
        console.log('❌ Oyuncu ayrıldı:', socket.id);
        
        // Tüm odalardan temizle
        for (const [roomCode, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    // Son oyuncu çıktığında zamanlayıcıyı temizle
                    if (roomTimeouts.has(roomCode)) {
                        clearTimeout(roomTimeouts.get(roomCode));
                        roomTimeouts.delete(roomCode);
                    }
                    rooms.delete(roomCode);
                    chatHistory.delete(roomCode);
                } else {
                    io.to(roomCode).emit('playersUpdate', room.players);
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`🔌 Socket.IO hazır`);
});
