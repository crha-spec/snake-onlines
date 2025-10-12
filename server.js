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
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Oyun verileri
const rooms = new Map();
const chatHistory = new Map();
const roomTimeouts = new Map();

// Yemek oluştur fonksiyonu - GÜNCELLENDİ
function generateFood(count = 300) {
    const food = [];
    const WORLD_SIZE = 5000;
    
    for (let i = 0; i < count; i++) {
        food.push({
            x: Math.random() * WORLD_SIZE,
            y: Math.random() * WORLD_SIZE,
            color: `hsl(${Math.random() * 360}, 80%, 60%)`
        });
    }
    
    return food;
}

// Benzersiz 7 haneli oda kodu oluştur
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

// Oda zaman aşımını başlat
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

// Yeni yemek oluşturma fonksiyonu - EKLENDİ
function generateFoodAtRandomPosition(existingFood = [], players = []) {
    const WORLD_SIZE = 5000;
    const minFoodDistance = 80;
    const minPlayerDistance = 150;
    const minWallDistance = 100;
    
    let newX, newY;
    let attempts = 0;
    const maxAttempts = 200;
    
    do {
        newX = Math.random() * (WORLD_SIZE - minWallDistance * 2) + minWallDistance;
        newY = Math.random() * (WORLD_SIZE - minWallDistance * 2) + minWallDistance;
        attempts++;
        
        if (attempts >= maxAttempts) {
            console.log("Uygun yemek pozisyonu bulmak için maksimum deneme sayısına ulaşıldı");
            break;
        }
        
    } while (isFoodPositionOccupied(newX, newY, existingFood, players, minFoodDistance, minPlayerDistance));
    
    return { 
        x: newX, 
        y: newY, 
        color: `hsl(${Math.random() * 360}, 80%, 60%)` 
    };
}

// Yemek pozisyonunun meşgul olup olmadığını kontrol et - EKLENDİ
function isFoodPositionOccupied(x, y, existingFood, players, minFoodDistance, minPlayerDistance) {
    // Diğer yemeklere çok yakın mı kontrol et
    for (const food of existingFood) {
        const dx = x - food.x;
        const dy = y - food.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < minFoodDistance * minFoodDistance) {
            return true;
        }
    }
    
    // Oyunculara çok yakın mı kontrol et
    for (const player of players) {
        const dx = x - (player.x || 0);
        const dy = y - (player.y || 0);
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < minPlayerDistance * minPlayerDistance) {
            return true;
        }
    }
    
    return false;
}

io.on('connection', socket => {
    console.log('✅ Oyuncu bağlandı:', socket.id);
    
    // Oda oluştur
    socket.on('createRoom', (data) => {
        console.log('🎮 Oda oluşturma isteği:', data);
        
        const roomCode = generateRoomCode();
        const players = [{ id: data.playerId, name: data.playerName }];
        
        rooms.set(roomCode, {
            owner: data.playerId,
            players: players,
            status: 'waiting',
            food: generateFood()
        });
        
        chatHistory.set(roomCode, []);
        
        // Oda zaman aşımını başlat
        startRoomTimeout(roomCode);
        
        socket.join(roomCode);
        
        socket.emit('roomCreated', {
            roomCode: roomCode,
            players: players
        });
        
        console.log('✅ Oda oluşturuldu:', roomCode);
    });
    
    // Odaya katıl
    socket.on('joinRoom', (data) => {
        console.log('🚪 Odaya katılma isteği:', data);
        
        const room = rooms.get(data.roomCode);
        
        if (!room) {
            console.log('❌ Oda bulunamadı:', data.roomCode);
            socket.emit('roomNotFound');
            return;
        }
        
        // Oda kodu validasyonu
        if (data.roomCode.length !== 7) {
            socket.emit('roomError', { error: 'Oda kodu 7 haneli olmalıdır!' });
            return;
        }
        
        // Aynı ID'li oyuncu kontrolü
        const existingPlayer = room.players.find(p => p.id === data.playerId);
        if (!existingPlayer) {
            room.players.push({ id: data.playerId, name: data.playerName });
        }
        
        // Zaman aşımını sıfırla
        startRoomTimeout(data.roomCode);
        
        socket.join(data.roomCode);
        
        socket.emit('roomJoined', {
            roomCode: data.roomCode,
            players: room.players,
            roomExpireTime: Date.now() + 3600000 // 1 saat
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
    
    // Yemek yenildi - GÜNCELLENDİ
    socket.on('foodEaten', (data) => {
        const room = rooms.get(data.roomCode);
        if (room) {
            // Yenen yemeği kaldır
            const foodIndex = room.food.findIndex(f => 
                f.x === data.eatenFood.x && f.y === data.eatenFood.y
            );
            
            if (foodIndex !== -1) {
                room.food.splice(foodIndex, 1);
                
                // ESKİ KOD: Otomatik yeni yemek ekleme KALDIRILDI
                // Yeni yemek, client tarafındaki food management sistemi tarafından eklenecek
                
                io.to(data.roomCode).emit('foodUpdate', {
                    food: room.food
                });
                
                console.log('🍎 Yemek yenildi:', data.roomCode);
            }
        }
    });
    
    // Yeni yemek oluştur - EKLENDİ
    socket.on('foodGenerated', (data) => {
        const room = rooms.get(data.roomCode);
        if (room) {
            // Yeni yemekleri ekle
            room.food.push(...data.newFood);
            
            io.to(data.roomCode).emit('foodUpdate', {
                food: room.food
            });
            
            console.log('🍎 Yeni yemekler eklendi:', data.newFood.length, '→', data.roomCode);
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
    
    // Oda zaman aşımı ayarı
    socket.on('setRoomTimeout', (data) => {
        startRoomTimeout(data.roomCode);
    });
    
    // Odadan çık
    socket.on('leaveRoom', (data) => {
        console.log('👋 Oyuncu çıkıyor:', data.playerId, '→', data.roomCode);
        
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
                console.log('👥 Oyuncu güncellendi:', room.players.length, 'oyuncu kaldı');
            }
        }
    });
    
    // Bağlantı kesildi
    socket.on('disconnect', (reason) => {
        console.log('❌ Oyuncu ayrıldı:', socket.id, 'Sebep:', reason);
        
        // Tüm odalardan temizle
        for (const [roomCode, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const playerName = room.players[playerIndex].name;
                room.players.splice(playerIndex, 1);
                
                console.log(`👤 ${playerName} odadan çıkarıldı: ${roomCode}`);
                
                if (room.players.length === 0) {
                    // Son oyuncu çıktığında zamanlayıcıyı temizle
                    if (roomTimeouts.has(roomCode)) {
                        clearTimeout(roomTimeouts.get(roomCode));
                        roomTimeouts.delete(roomCode);
                    }
                    rooms.delete(roomCode);
                    chatHistory.delete(roomCode);
                    console.log('🗑️ Oda silindi:', roomCode);
                } else {
                    io.to(roomCode).emit('playersUpdate', room.players);
                }
            }
        }
    });
});

// Hata yakalama - EKLENDİ
process.on('uncaughtException', (error) => {
    console.error('❌ Beklenmeyen hata:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ İşlenmemiş promise:', promise, 'Sebep:', reason);
});

server.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`🔌 Socket.IO hazır`);
    console.log(`📁 Static dosyalar: ${path.join(__dirname, 'public')}`);
});

// Graceful shutdown - EKLENDİ
process.on('SIGTERM', () => {
    console.log('🛑 Server kapatılıyor...');
    server.close(() => {
        console.log('✅ Server başarıyla kapatıldı');
        process.exit(0);
    });
});
