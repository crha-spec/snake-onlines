// InstaChat - Anlık Mesajlaşma Uygulaması
class InstaChat {
    constructor() {
        this.socket = null;
        this.currentUser = null;
        this.users = [];
        this.chats = [];
        this.activeChat = null;
        this.deviceId = this.getDeviceId();
        
        this.init();
    }
    
    // Uygulamayı başlat
    init() {
        this.setupEventListeners();
        this.checkExistingSession();
    }
    
    // Cihaz ID'sini al veya oluştur
    getDeviceId() {
        let deviceId = localStorage.getItem('device_id');
        if (!deviceId) {
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('device_id', deviceId);
        }
        return deviceId;
    }
    
    // Event listener'ları kur
    setupEventListeners() {
        // Auth formları
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('registerForm').addEventListener('submit', (e) => this.handleRegister(e));
        
        // Navigasyon
        document.getElementById('homeBtn').addEventListener('click', () => this.showChatSection());
        document.getElementById('chatBtn').addEventListener('click', () => this.showChatSection());
        document.getElementById('profileBtn').addEventListener('click', () => this.showProfileSection());
        
        // Mesajlaşma
        document.getElementById('newChatBtn').addEventListener('click', () => this.showNewChatModal());
        document.getElementById('sendMessageBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('messageInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        
        // Profil düzenleme
        document.getElementById('editProfileBtn').addEventListener('click', () => this.showEditProfileModal());
        document.getElementById('editProfileForm').addEventListener('submit', (e) => this.handleEditProfile(e));
        
        // Modal kapatma
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.modal').classList.add('hidden');
            });
        });
        
        // Çıkış işlemi
        document.getElementById('confirmLogout').addEventListener('click', () => this.handleLogout());
        document.getElementById('cancelLogout').addEventListener('click', () => {
            document.getElementById('logoutModal').classList.add('hidden');
        });
        
        // Kullanıcı arama
        document.getElementById('searchUsersInput').addEventListener('input', (e) => this.searchUsers(e.target.value));
    }
    
    // Mevcut oturumu kontrol et
    async checkExistingSession() {
        if (this.deviceId) {
            try {
                const response = await fetch('/api/verify-device', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ deviceId: this.deviceId })
                });
                
                const data = await response.json();
                
                if (data.success && data.user) {
                    this.currentUser = data.user;
                    this.showApp();
                    this.connectSocket();
                    this.loadUserData();
                }
            } catch (error) {
                console.error('Oturum kontrolü hatası:', error);
            }
        }
    }
    
    // Giriş işlemi
    async handleLogin(e) {
        e.preventDefault();
        
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        if (!this.validateEmail(email)) {
            this.showToast('Lütfen geçerli bir Gmail adresi girin', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password, deviceId: this.deviceId })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                this.showApp();
                this.connectSocket();
                this.showToast('Başarıyla giriş yapıldı', 'success');
            } else {
                this.showToast(data.message || 'Giriş başarısız', 'error');
            }
        } catch (error) {
            console.error('Giriş hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    // Kayıt işlemi
    async handleRegister(e) {
        e.preventDefault();
        
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;
        
        if (!this.validateEmail(email)) {
            this.showToast('Lütfen geçerli bir Gmail adresi girin', 'error');
            return;
        }
        
        if (password.length < 8) {
            this.showToast('Şifre en az 8 karakter olmalıdır', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password, deviceId: this.deviceId })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                this.showApp();
                this.connectSocket();
                this.showEditProfileModal();
                this.showToast('Hesabınız oluşturuldu', 'success');
            } else {
                this.showToast(data.message || 'Kayıt başarısız', 'error');
            }
        } catch (error) {
            console.error('Kayıt hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    // Email doğrulama
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const gmailRegex = /@gmail\.com$/i;
        return emailRegex.test(email) && gmailRegex.test(email);
    }
    
    // Uygulama ekranını göster
    showApp() {
        document.getElementById('authScreen').classList.remove('active');
        document.getElementById('appScreen').classList.add('active');
        this.showChatSection();
    }
    
    // Chat bölümünü göster
    showChatSection() {
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById('chatSection').classList.add('active');
    }
    
    // Profil bölümünü göster
    showProfileSection() {
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById('profileSection').classList.add('active');
        this.updateProfileDisplay();
    }
    
    // Socket bağlantısını kur
    connectSocket() {
        this.socket = io({
            auth: {
                userId: this.currentUser.id,
                deviceId: this.deviceId
            }
        });
        
        this.socket.on('connect', () => {
            console.log('Socket bağlantısı kuruldu');
            this.loadChats();
            this.loadUsers();
        });
        
        this.socket.on('disconnect', () => {
            console.log('Socket bağlantısı kesildi');
        });
        
        this.socket.on('new_message', (message) => {
            this.handleNewMessage(message);
        });
        
        this.socket.on('user_online', (userId) => {
            this.updateUserStatus(userId, true);
        });
        
        this.socket.on('user_offline', (userId) => {
            this.updateUserStatus(userId, false);
        });
    }
    
    // Kullanıcı verilerini yükle
    async loadUserData() {
        try {
            const response = await fetch(`/api/user/${this.currentUser.id}`);
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                this.updateProfileDisplay();
            }
        } catch (error) {
            console.error('Kullanıcı verisi yükleme hatası:', error);
        }
    }
    
    // Sohbetleri yükle
    async loadChats() {
        try {
            const response = await fetch(`/api/chats/${this.currentUser.id}`);
            const data = await response.json();
            
            if (data.success) {
                this.chats = data.chats;
                this.renderChatList();
            }
        } catch (error) {
            console.error('Sohbet yükleme hatası:', error);
        }
    }
    
    // Kullanıcıları yükle
    async loadUsers() {
        try {
            const response = await fetch('/api/users');
            const data = await response.json();
            
            if (data.success) {
                this.users = data.users.filter(user => user.id !== this.currentUser.id);
            }
        } catch (error) {
            console.error('Kullanıcı listesi yükleme hatası:', error);
        }
    }
    
    // Sohbet listesini render et
    renderChatList() {
        const chatItems = document.getElementById('chatItems');
        chatItems.innerHTML = '';
        
        this.chats.forEach(chat => {
            const otherUser = chat.participants.find(p => p.id !== this.currentUser.id);
            const lastMessage = chat.messages[chat.messages.length - 1];
            
            const chatItem = document.createElement('div');
            chatItem.className = `chat-item ${this.activeChat?.id === chat.id ? 'active' : ''}`;
            chatItem.innerHTML = `
                <div class="chat-item-avatar">
                    <div class="avatar medium">
                        <img src="${otherUser.avatar || this.getDefaultAvatar()}" alt="${otherUser.username}">
                    </div>
                </div>
                <div class="chat-item-info">
                    <div class="chat-item-name">${otherUser.username}</div>
                    <div class="chat-item-preview">${lastMessage?.text || 'Henüz mesaj yok'}</div>
                </div>
                <div class="chat-item-time">${lastMessage ? this.formatTime(lastMessage.timestamp) : ''}</div>
            `;
            
            chatItem.addEventListener('click', () => this.openChat(chat, otherUser));
            chatItems.appendChild(chatItem);
        });
    }
    
    // Sohbet aç
    openChat(chat, otherUser) {
        this.activeChat = chat;
        this.renderChatList();
        this.renderChatMessages();
        
        document.getElementById('activeChatName').textContent = otherUser.username;
        document.getElementById('activeChatAvatar').src = otherUser.avatar || this.getDefaultAvatar();
        document.getElementById('activeChatStatus').textContent = 'Çevrimiçi';
        
        document.getElementById('messageInput').disabled = false;
        document.getElementById('sendMessageBtn').disabled = false;
    }
    
    // Sohbet mesajlarını render et
    renderChatMessages() {
        const messagesContainer = document.getElementById('chatMessages');
        messagesContainer.innerHTML = '';
        
        if (!this.activeChat || this.activeChat.messages.length === 0) {
            messagesContainer.innerHTML = `
                <div class="no-chat-selected">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                    </svg>
                    <p>Henüz mesaj yok. İlk mesajı siz gönderin!</p>
                </div>
            `;
            return;
        }
        
        this.activeChat.messages.forEach(message => {
            const messageEl = document.createElement('div');
            messageEl.className = `message ${message.senderId === this.currentUser.id ? 'sent' : 'received'}`;
            messageEl.innerHTML = `
                <div class="message-text">${this.escapeHtml(message.text)}</div>
                <div class="message-time">${this.formatTime(message.timestamp)}</div>
            `;
            messagesContainer.appendChild(messageEl);
        });
        
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    // Mesaj gönder
    sendMessage() {
        const input = document.getElementById('messageInput');
        const text = input.value.trim();
        
        if (!text || !this.activeChat) return;
        
        const message = {
            chatId: this.activeChat.id,
            senderId: this.currentUser.id,
            text: text,
            timestamp: new Date().toISOString()
        };
        
        this.socket.emit('send_message', message);
        
        // Mesajı yerel olarak ekle
        if (!this.activeChat.messages) {
            this.activeChat.messages = [];
        }
        this.activeChat.messages.push(message);
        this.renderChatMessages();
        
        input.value = '';
    }
    
    // Yeni mesaj işleme
    handleNewMessage(message) {
        // Mevcut sohbeti güncelle veya yeni sohbet oluştur
        let chat = this.chats.find(c => c.id === message.chatId);
        
        if (!chat) {
            // Yeni sohbet oluştur
            chat = {
                id: message.chatId,
                participants: [this.currentUser, { id: message.senderId }], // Diğer kullanıcı bilgileri daha sonra doldurulacak
                messages: [message]
            };
            this.chats.unshift(chat);
        } else {
            chat.messages.push(message);
        }
        
        this.renderChatList();
        
        // Eğer bu mesaj aktif sohbetteyse, mesajları güncelle
        if (this.activeChat && this.activeChat.id === message.chatId) {
            this.renderChatMessages();
        }
    }
    
    // Yeni sohbet modalını göster
    showNewChatModal() {
        document.getElementById('newChatModal').classList.remove('hidden');
        this.renderUsersList();
    }
    
    // Kullanıcı listesini render et
    renderUsersList() {
        const usersList = document.getElementById('usersList');
        usersList.innerHTML = '';
        
        this.users.forEach(user => {
            const userItem = document.createElement('div');
            userItem.className = 'user-item';
            userItem.innerHTML = `
                <div class="user-item-avatar">
                    <div class="avatar medium">
                        <img src="${user.avatar || this.getDefaultAvatar()}" alt="${user.username}">
                    </div>
                </div>
                <div class="user-item-info">
                    <div class="user-item-name">${user.username}</div>
                    <div class="user-item-email">${user.email}</div>
                </div>
            `;
            
            userItem.addEventListener('click', () => this.startNewChat(user));
            usersList.appendChild(userItem);
        });
    }
    
    // Kullanıcı ara
    searchUsers(query) {
        const filteredUsers = this.users.filter(user => 
            user.username.toLowerCase().includes(query.toLowerCase()) ||
            user.email.toLowerCase().includes(query.toLowerCase())
        );
        
        const usersList = document.getElementById('usersList');
        usersList.innerHTML = '';
        
        filteredUsers.forEach(user => {
            const userItem = document.createElement('div');
            userItem.className = 'user-item';
            userItem.innerHTML = `
                <div class="user-item-avatar">
                    <div class="avatar medium">
                        <img src="${user.avatar || this.getDefaultAvatar()}" alt="${user.username}">
                    </div>
                </div>
                <div class="user-item-info">
                    <div class="user-item-name">${user.username}</div>
                    <div class="user-item-email">${user.email}</div>
                </div>
            `;
            
            userItem.addEventListener('click', () => this.startNewChat(user));
            usersList.appendChild(userItem);
        });
    }
    
    // Yeni sohbet başlat
    startNewChat(user) {
        document.getElementById('newChatModal').classList.add('hidden');
        
        // Mevcut sohbeti kontrol et
        let existingChat = this.chats.find(chat => 
            chat.participants.some(p => p.id === user.id)
        );
        
        if (existingChat) {
            this.openChat(existingChat, user);
        } else {
            // Yeni sohbet oluştur
            const newChat = {
                id: 'chat_' + Date.now(),
                participants: [this.currentUser, user],
                messages: []
            };
            
            this.chats.unshift(newChat);
            this.openChat(newChat, user);
        }
    }
    
    // Profil düzenleme modalını göster
    showEditProfileModal() {
        document.getElementById('editUsername').value = this.currentUser.username || '';
        document.getElementById('editBio').value = this.currentUser.bio || '';
        document.getElementById('editAvatar').value = this.currentUser.avatar || '';
        
        document.getElementById('editProfileModal').classList.remove('hidden');
    }
    
    // Profil düzenleme işlemi
    async handleEditProfile(e) {
        e.preventDefault();
        
        const username = document.getElementById('editUsername').value.trim();
        const bio = document.getElementById('editBio').value.trim();
        const avatar = document.getElementById('editAvatar').value.trim();
        
        if (!username) {
            this.showToast('Kullanıcı adı gereklidir', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/update-profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    username,
                    bio,
                    avatar
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                this.updateProfileDisplay();
                document.getElementById('editProfileModal').classList.add('hidden');
                this.showToast('Profil güncellendi', 'success');
            } else {
                this.showToast(data.message || 'Profil güncelleme başarısız', 'error');
            }
        } catch (error) {
            console.error('Profil güncelleme hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    // Profil ekranını güncelle
    updateProfileDisplay() {
        document.getElementById('profileUsername').textContent = this.currentUser.username || 'Kullanıcı Adı';
        document.getElementById('profileBio').textContent = this.currentUser.bio || 'Hakkında bilgisi bulunmuyor';
        
        const navAvatar = document.getElementById('navAvatar');
        const profileAvatar = document.getElementById('profileAvatarImg');
        
        if (this.currentUser.avatar) {
            navAvatar.src = this.currentUser.avatar;
            profileAvatar.src = this.currentUser.avatar;
        } else {
            const defaultAvatar = this.getDefaultAvatar();
            navAvatar.src = defaultAvatar;
            profileAvatar.src = defaultAvatar;
        }
    }
    
    // Çıkış işlemi
    async handleLogout() {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    deviceId: this.deviceId
                })
            });
            
            // Yerel verileri temizle
            this.currentUser = null;
            this.chats = [];
            this.activeChat = null;
            
            // Socket bağlantısını kapat
            if (this.socket) {
                this.socket.disconnect();
                this.socket = null;
            }
            
            // Ekranları sıfırla
            document.getElementById('appScreen').classList.remove('active');
            document.getElementById('authScreen').classList.add('active');
            document.getElementById('logoutModal').classList.add('hidden');
            
            // Formları sıfırla
            document.getElementById('loginForm').reset();
            document.getElementById('registerForm').reset();
            
            this.showToast('Başarıyla çıkış yapıldı', 'success');
        } catch (error) {
            console.error('Çıkış hatası:', error);
            this.showToast('Çıkış sırasında bir hata oluştu', 'error');
        }
    }
    
    // Yardımcı fonksiyonlar
    
    // Varsayılan avatar URL'si
    getDefaultAvatar() {
        return `https://ui-avatars.com/api/?name=${encodeURIComponent(this.currentUser?.username || 'User')}&background=random&color=fff&size=150`;
    }
    
    // Zaman formatlama
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) { // 1 dakikadan az
            return 'Şimdi';
        } else if (diff < 3600000) { // 1 saatten az
            return `${Math.floor(diff / 60000)} dk`;
        } else if (diff < 86400000) { // 1 günden az
            return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        } else {
            return date.toLocaleDateString('tr-TR');
        }
    }
    
    // HTML escape
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Kullanıcı durumunu güncelle
    updateUserStatus(userId, isOnline) {
        // Chat listesindeki kullanıcı durumunu güncelle
        const chatItems = document.querySelectorAll('.chat-item');
        chatItems.forEach(item => {
            const userName = item.querySelector('.chat-item-name').textContent;
            // Burada kullanıcı ID'sine göre eşleme yapılmalı, şimdilik basit implementasyon
            if (this.activeChat && this.getOtherUser(this.activeChat).username === userName) {
                const statusEl = document.getElementById('activeChatStatus');
                if (statusEl) {
                    statusEl.textContent = isOnline ? 'Çevrimiçi' : 'Çevrimdışı';
                }
            }
        });
    }
    
    // Aktif sohbetteki diğer kullanıcıyı getir
    getOtherUser(chat) {
        return chat.participants.find(p => p.id !== this.currentUser.id);
    }
    
    // Toast bildirimi göster
    showToast(message, type = 'info') {
        const toastContainer = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <div class="toast-icon">
                ${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}
            </div>
            <div class="toast-message">${message}</div>
            <button class="toast-close">✕</button>
        `;
        
        toastContainer.appendChild(toast);
        
        // Otomatik kapanma
        setTimeout(() => {
            toast.remove();
        }, 5000);
        
        // Manuel kapanma
        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.remove();
        });
    }
}

// Uygulamayı başlat
document.addEventListener('DOMContentLoaded', () => {
    new InstaChat();
});
