// InstaChat - Anlık Mesajlaşma Uygulaması
class InstaChat {
    constructor() {
        this.socket = null;
        this.currentUser = null;
        this.users = [];
        this.chats = [];
        this.activeChat = null;
        this.deviceId = this.getDeviceId();
        this.stories = [];
        this.currentStoryIndex = 0;
        this.currentStoryGroupIndex = 0;
        this.storyLikes = [];
        this.onlineUsers = [];
        this.typingTimeout = null;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.checkExistingSession();
    }
    
    getDeviceId() {
        let deviceId = localStorage.getItem('device_id');
        if (!deviceId) {
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('device_id', deviceId);
            console.log('Yeni cihaz ID oluşturuldu:', deviceId);
        }
        return deviceId;
    }
    
    setupEventListeners() {
        // Auth formları
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('registerForm').addEventListener('submit', (e) => this.handleRegister(e));
        
        // Navigasyon
        document.getElementById('homeBtn').addEventListener('click', () => this.showChatSection());
        document.getElementById('storiesBtn').addEventListener('click', () => this.showStoriesSection());
        document.getElementById('chatBtn').addEventListener('click', () => this.showChatSection());
        document.getElementById('profileBtn').addEventListener('click', () => this.showProfileSection());
        document.getElementById('settingsBtn').addEventListener('click', () => this.toggleSettingsMenu());
        document.getElementById('likesBtn').addEventListener('click', () => this.showLikesModal());
        
        // Ayarlar menüsü
        document.getElementById('hideActivityBtn').addEventListener('click', () => this.toggleHideActivity());
        document.getElementById('changePasswordBtn').addEventListener('click', () => this.showChangePasswordModal());
        document.getElementById('logoutBtn').addEventListener('click', () => this.showLogoutModal());
        
        // Mesajlaşma
        document.getElementById('newChatBtn').addEventListener('click', () => this.showNewChatModal());
        document.getElementById('sendMessageBtn').addEventListener('click', () => this.sendMessage());
        
        const messageInput = document.getElementById('messageInput');
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        
        messageInput.addEventListener('input', () => this.handleTyping());
        
        // Story yükleme
        document.getElementById('uploadStoryBtn').addEventListener('click', () => this.uploadStory());
        document.getElementById('storyFileInput').addEventListener('change', (e) => this.handleStoryFileSelect(e));
        
        // Profil düzenleme
        document.getElementById('editProfileBtn').addEventListener('click', () => this.showEditProfileModal());
        document.getElementById('editProfileBtn2').addEventListener('click', () => this.showEditProfileModal());
        document.getElementById('editProfileForm').addEventListener('submit', (e) => this.handleEditProfile(e));
        
        // Şifre değiştirme
        document.getElementById('changePasswordForm').addEventListener('submit', (e) => this.handleChangePassword(e));
        
        // Modal kapatma - TÜM close butonları için
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('close-modal') || 
                e.target.closest('.close-modal')) {
                const modal = e.target.closest('.modal');
                if (modal) {
                    modal.classList.add('hidden');
                }
            }
            
            // Modal backdrop'a tıklanınca kapat
            if (e.target.classList.contains('modal')) {
                e.target.classList.add('hidden');
            }
        });
        
        // Çıkış işlemi
        document.getElementById('confirmLogout').addEventListener('click', () => this.handleLogout());
        document.getElementById('cancelLogout').addEventListener('click', () => {
            document.getElementById('logoutModal').classList.add('hidden');
        });
        
        // Kullanıcı arama
        document.getElementById('searchUsersInput').addEventListener('input', (e) => this.searchUsers(e.target.value));
        
        // Story viewer
        document.getElementById('closeStoryViewer').addEventListener('click', () => this.closeStoryViewer());
        document.getElementById('prevStory').addEventListener('click', () => this.previousStory());
        document.getElementById('nextStory').addEventListener('click', () => this.nextStory());
        document.getElementById('likeStoryBtn').addEventListener('click', () => this.likeStory());
        
        // Dışarıya tıklama ile menüleri kapat
        document.addEventListener('click', (e) => {
            const settingsMenu = document.getElementById('settingsDropdown');
            const settingsBtn = document.getElementById('settingsBtn');
            
            if (!settingsMenu.classList.contains('hidden') && 
                !settingsMenu.contains(e.target) && 
                !settingsBtn.contains(e.target)) {
                settingsMenu.classList.add('hidden');
            }
        });
    }
    
    async checkExistingSession() {
        console.log('Oturum kontrolü başlatıldı, cihaz ID:', this.deviceId);
        
        if (this.deviceId) {
            try {
                const response = await fetch('/api/verify-device', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId: this.deviceId })
                });
                
                const data = await response.json();
                console.log('Oturum kontrolü yanıtı:', data);
                
                if (data.success && data.user) {
                    this.currentUser = data.user;
                    this.showApp();
                    this.connectSocket();
                    await this.loadUserData();
                    this.showToast('Otomatik giriş yapıldı', 'success');
                }
            } catch (error) {
                console.error('Oturum kontrolü hatası:', error);
            }
        }
    }
    
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email, 
                    password, 
                    deviceId: this.deviceId 
                })
            });
            
            const data = await response.json();
            console.log('Giriş yanıtı:', data);
            
            if (data.success) {
                this.currentUser = data.user;
                this.showApp();
                this.connectSocket();
                this.showToast('Başarıyla giriş yapıldı', 'success');
                document.getElementById('loginForm').reset();
                
                // Kullanıcı bilgilerini localStorage'a kaydet
                localStorage.setItem('current_user', JSON.stringify(data.user));
            } else {
                this.showToast(data.message || 'Giriş başarısız', 'error');
            }
        } catch (error) {
            console.error('Giriş hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email, 
                    password, 
                    deviceId: this.deviceId 
                })
            });
            
            const data = await response.json();
            console.log('Kayıt yanıtı:', data);
            
            if (data.success) {
                this.currentUser = data.user;
                this.showApp();
                this.connectSocket();
                
                // Kullanıcı bilgilerini localStorage'a kaydet
                localStorage.setItem('current_user', JSON.stringify(data.user));
                
                this.showEditProfileModal();
                this.showToast('Hesabınız oluşturuldu! Profilinizi tamamlayın', 'success');
                document.getElementById('registerForm').reset();
            } else {
                this.showToast(data.message || 'Kayıt başarısız', 'error');
            }
        } catch (error) {
            console.error('Kayıt hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const gmailRegex = /@gmail\.com$/i;
        return emailRegex.test(email) && gmailRegex.test(email);
    }
    
    showApp() {
        document.getElementById('authScreen').classList.remove('active');
        document.getElementById('appScreen').classList.add('active');
        this.showChatSection();
        this.updateProfileDisplay();
    }
    
    showChatSection() {
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById('chatSection').classList.add('active');
    }
    
    showStoriesSection() {
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById('storiesSection').classList.add('active');
        this.loadStories();
    }
    
    showProfileSection() {
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById('profileSection').classList.add('active');
        this.updateProfileDisplay();
    }
    
    toggleSettingsMenu() {
        const dropdown = document.getElementById('settingsDropdown');
        dropdown.classList.toggle('hidden');
    }
    
    async toggleHideActivity() {
        const newStatus = !this.currentUser.hideActivity;
        
        try {
            const response = await fetch('/api/update-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    hideActivity: newStatus
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                document.getElementById('hideActivityToggle').checked = newStatus;
                
                // localStorage'ı güncelle
                localStorage.setItem('current_user', JSON.stringify(this.currentUser));
                
                this.showToast(newStatus ? 'Aktiflik durumu gizlendi' : 'Aktiflik durumu gösteriliyor', 'success');
            }
        } catch (error) {
            console.error('Ayar güncelleme hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
        
        document.getElementById('settingsDropdown').classList.add('hidden');
    }
    
    showChangePasswordModal() {
        document.getElementById('settingsDropdown').classList.add('hidden');
        document.getElementById('changePasswordModal').classList.remove('hidden');
    }
    
    async handleChangePassword(e) {
        e.preventDefault();
        
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        
        console.log('Şifre değiştirme denemesi:', { currentPassword, newPassword, confirmPassword });
        
        if (newPassword !== confirmPassword) {
            this.showToast('Yeni şifreler eşleşmiyor', 'error');
            return;
        }
        
        if (newPassword.length < 8) {
            this.showToast('Yeni şifre en az 8 karakter olmalıdır', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    currentPassword,
                    newPassword
                })
            });
            
            const data = await response.json();
            console.log('Şifre değiştirme yanıtı:', data);
            
            if (data.success) {
                this.showToast('Şifre başarıyla değiştirildi', 'success');
                document.getElementById('changePasswordModal').classList.add('hidden');
                document.getElementById('changePasswordForm').reset();
            } else {
                this.showToast(data.message || 'Şifre değiştirme başarısız', 'error');
            }
        } catch (error) {
            console.error('Şifre değiştirme hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    showLogoutModal() {
        document.getElementById('settingsDropdown').classList.add('hidden');
        document.getElementById('logoutModal').classList.remove('hidden');
    }
    
    async handleLogout() {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    deviceId: this.deviceId
                })
            });
            
            if (this.socket) {
                this.socket.disconnect();
            }
            
            this.currentUser = null;
            this.chats = [];
            this.activeChat = null;
            
            // localStorage'ı temizle
            localStorage.removeItem('current_user');
            
            document.getElementById('logoutModal').classList.add('hidden');
            document.getElementById('appScreen').classList.remove('active');
            document.getElementById('authScreen').classList.add('active');
            
            this.showToast('Başarıyla çıkış yapıldı', 'success');
        } catch (error) {
            console.error('Çıkış hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    connectSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Socket bağlandı');
            this.socket.emit('authenticate', {
                userId: this.currentUser.id,
                deviceId: this.deviceId
            });
            this.loadChats();
            this.loadUsers();
            this.loadOnlineUsers();
            this.loadStories();
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
        
        this.socket.on('user_typing', ({ chatId, userId }) => {
            if (this.activeChat && this.activeChat.id === chatId) {
                this.showTypingIndicator();
            }
        });
        
        this.socket.on('user_stop_typing', ({ chatId }) => {
            if (this.activeChat && this.activeChat.id === chatId) {
                this.hideTypingIndicator();
            }
        });
        
        this.socket.on('story_liked', (like) => {
            this.handleStoryLiked(like);
        });
    }
    
    async loadUserData() {
        try {
            const response = await fetch(`/api/user/${this.currentUser.id}`);
            const data = await response.json();
            
            if (data.success) {
                this.currentUser = data.user;
                this.updateProfileDisplay();
                
                // localStorage'ı güncelle
                localStorage.setItem('current_user', JSON.stringify(this.currentUser));
            }
        } catch (error) {
            console.error('Kullanıcı verisi yükleme hatası:', error);
        }
    }
    
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
    
    async loadOnlineUsers() {
        try {
            const response = await fetch('/api/online-users');
            const data = await response.json();
            
            if (data.success) {
                this.onlineUsers = data.onlineUsers;
                this.renderChatList();
            }
        } catch (error) {
            console.error('Online kullanıcılar yükleme hatası:', error);
        }
    }
    
    async loadStories() {
        try {
            const response = await fetch('/api/stories');
            const data = await response.json();
            
            if (data.success) {
                this.stories = data.stories;
                this.renderStories();
            }
        } catch (error) {
            console.error('Story yükleme hatası:', error);
        }
    }
    
    renderStories() {
        const storiesGrid = document.getElementById('storiesGrid');
        storiesGrid.innerHTML = '';
        
        // Kendi story yükleme butonu
        const uploadBtn = document.createElement('div');
        uploadBtn.className = 'story-item';
        uploadBtn.innerHTML = `
            <div class="upload-story-btn" id="uploadStoryBtn">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
            </div>
            <div class="story-username">Story Ekle</div>
        `;
        uploadBtn.addEventListener('click', () => this.uploadStory());
        storiesGrid.appendChild(uploadBtn);
        
        // Diğer kullanıcıların storyleri
        this.stories.forEach((storyGroup, groupIndex) => {
            const storyItem = document.createElement('div');
            storyItem.className = 'story-item';
            storyItem.innerHTML = `
                <div class="story-ring">
                    <div class="story-avatar">
                        <img src="${storyGroup.user.avatar || this.getDefaultAvatar()}" alt="${storyGroup.user.username}">
                    </div>
                </div>
                <div class="story-username">${storyGroup.user.username}</div>
            `;
            storyItem.addEventListener('click', () => this.openStoryViewer(groupIndex));
            storiesGrid.appendChild(storyItem);
        });
    }
    
    uploadStory() {
        document.getElementById('storyFileInput').click();
    }
    
    async handleStoryFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        if (!file.type.startsWith('image/')) {
            this.showToast('Lütfen bir resim dosyası seçin', 'error');
            return;
        }
        
        if (file.size > 5 * 1024 * 1024) {
            this.showToast('Dosya boyutu 5MB\'dan küçük olmalıdır', 'error');
            return;
        }
        
        // Progress göster
        const progressEl = document.getElementById('uploadProgress');
        progressEl.classList.remove('hidden');
        
        const reader = new FileReader();
        
        reader.onprogress = (e) => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                document.getElementById('uploadPercentage').textContent = Math.round(percentComplete) + '%';
                document.getElementById('uploadProgressFill').style.width = percentComplete + '%';
            }
        };
        
        reader.onload = async (e) => {
            try {
                const response = await fetch('/api/upload-story', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: this.currentUser.id,
                        imageData: e.target.result
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    this.showToast('Story başarıyla yüklendi', 'success');
                    await this.loadStories();
                } else {
                    this.showToast(data.message || 'Story yükleme başarısız', 'error');
                }
            } catch (error) {
                console.error('Story yükleme hatası:', error);
                this.showToast('Bir hata oluştu', 'error');
            } finally {
                progressEl.classList.add('hidden');
                document.getElementById('uploadProgressFill').style.width = '0%';
                document.getElementById('uploadPercentage').textContent = '0%';
                e.target.value = '';
            }
        };
        
        reader.readAsDataURL(file);
    }
    
    openStoryViewer(groupIndex) {
        this.currentStoryGroupIndex = groupIndex;
        this.currentStoryIndex = 0;
        document.getElementById('storyViewer').classList.remove('hidden');
        this.showCurrentStory();
    }
    
    showCurrentStory() {
        const storyGroup = this.stories[this.currentStoryGroupIndex];
        if (!storyGroup) {
            this.closeStoryViewer();
            return;
        }
        
        const story = storyGroup.stories[this.currentStoryIndex];
        if (!story) {
            this.nextStoryGroup();
            return;
        }
        
        // Story bilgilerini göster
        document.getElementById('storyUserAvatar').src = storyGroup.user.avatar || this.getDefaultAvatar();
        document.getElementById('storyUsername').textContent = storyGroup.user.username;
        document.getElementById('storyTime').textContent = this.formatTime(story.createdAt);
        document.getElementById('storyImage').src = story.imageData;
        
        // Beğeni durumu
        const likeBtn = document.getElementById('likeStoryBtn');
        const isLiked = story.likes.includes(this.currentUser.id);
        likeBtn.classList.toggle('liked', isLiked);
        document.getElementById('storyLikeCount').textContent = story.likes.length;
        
        // Progress bar güncelle
        this.updateStoryProgress();
        
        // Otomatik geçiş
        this.storyTimeout = setTimeout(() => {
            this.nextStory();
        }, 5000);
    }
    
    updateStoryProgress() {
        const storyGroup = this.stories[this.currentStoryGroupIndex];
        const progressContainer = document.getElementById('storyProgress');
        progressContainer.innerHTML = '';
        
        storyGroup.stories.forEach((_, index) => {
            const bar = document.createElement('div');
            bar.className = 'story-progress-bar';
            
            const fill = document.createElement('div');
            fill.className = 'story-progress-fill';
            
            if (index < this.currentStoryIndex) {
                fill.style.width = '100%';
            } else if (index === this.currentStoryIndex) {
                fill.classList.add('active');
            }
            
            bar.appendChild(fill);
            progressContainer.appendChild(bar);
        });
    }
    
    previousStory() {
        if (this.storyTimeout) clearTimeout(this.storyTimeout);
        
        if (this.currentStoryIndex > 0) {
            this.currentStoryIndex--;
            this.showCurrentStory();
        } else if (this.currentStoryGroupIndex > 0) {
            this.currentStoryGroupIndex--;
            const prevGroup = this.stories[this.currentStoryGroupIndex];
            this.currentStoryIndex = prevGroup.stories.length - 1;
            this.showCurrentStory();
        }
    }
    
    nextStory() {
        if (this.storyTimeout) clearTimeout(this.storyTimeout);
        
        const storyGroup = this.stories[this.currentStoryGroupIndex];
        
        if (this.currentStoryIndex < storyGroup.stories.length - 1) {
            this.currentStoryIndex++;
            this.showCurrentStory();
        } else {
            this.nextStoryGroup();
        }
    }
    
    nextStoryGroup() {
        if (this.currentStoryGroupIndex < this.stories.length - 1) {
            this.currentStoryGroupIndex++;
            this.currentStoryIndex = 0;
            this.showCurrentStory();
        } else {
            this.closeStoryViewer();
        }
    }
    
    closeStoryViewer() {
        if (this.storyTimeout) clearTimeout(this.storyTimeout);
        document.getElementById('storyViewer').classList.add('hidden');
    }
    
    async likeStory() {
        const storyGroup = this.stories[this.currentStoryGroupIndex];
        const story = storyGroup.stories[this.currentStoryIndex];
        
        if (story.likes.includes(this.currentUser.id)) {
            this.showToast('Bu story\'yi zaten beğendiniz', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/like-story', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    storyId: story.id,
                    userId: this.currentUser.id
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                story.likes.push(this.currentUser.id);
                document.getElementById('likeStoryBtn').classList.add('liked');
                document.getElementById('storyLikeCount').textContent = story.likes.length;
                this.showToast('Story beğenildi', 'success');
            }
        } catch (error) {
            console.error('Story beğenme hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    async loadStoryLikes() {
        try {
            const response = await fetch(`/api/story-likes/${this.currentUser.id}`);
            const data = await response.json();
            
            if (data.success) {
                this.storyLikes = data.likes;
                this.updateLikesNotification();
            }
        } catch (error) {
            console.error('Story beğenileri yükleme hatası:', error);
        }
    }
    
    updateLikesNotification() {
        const badge = document.getElementById('likesBadge');
        if (this.storyLikes.length > 0) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
    
    handleStoryLiked(like) {
        this.storyLikes.unshift(like);
        this.updateLikesNotification();
        this.showToast('Birileri story\'nizi beğendi', 'success');
    }
    
    showLikesModal() {
        this.loadStoryLikes();
        document.getElementById('likesModal').classList.remove('hidden');
        this.renderLikes();
    }
    
    renderLikes() {
        const likesList = document.getElementById('likesList');
        likesList.innerHTML = '';
        
        if (this.storyLikes.length === 0) {
            likesList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Henüz beğeni yok</p>';
            return;
        }
        
        this.storyLikes.forEach(like => {
            if (!like.user) return;
            
            const likeItem = document.createElement('div');
            likeItem.className = 'user-item';
            likeItem.innerHTML = `
                <div class="user-item-avatar">
                    <div class="avatar medium">
                        <img src="${like.user.avatar || this.getDefaultAvatar()}" alt="${like.user.username}">
                    </div>
                </div>
                <div class="user-item-info">
                    <div class="user-item-name">${like.user.username}</div>
                    <div class="user-item-email">${this.formatTime(like.createdAt)}</div>
                </div>
            `;
            likesList.appendChild(likeItem);
        });
    }
    
    renderChatList() {
        const chatItems = document.getElementById('chatItems');
        chatItems.innerHTML = '';
        
        if (this.chats.length === 0) {
            chatItems.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Henüz sohbet yok</p>';
            return;
        }
        
        this.chats.forEach(chat => {
            const otherUser = chat.otherUser;
            if (!otherUser) return;
            
            const lastMessage = chat.lastMessage;
            const isOnline = this.onlineUsers.includes(otherUser.id);
            
            const chatItem = document.createElement('div');
            chatItem.className = `chat-item ${this.activeChat?.id === chat.id ? 'active' : ''}`;
            chatItem.innerHTML = `
                <div class="chat-item-avatar">
                    <div class="avatar medium">
                        <img src="${otherUser.avatar || this.getDefaultAvatar()}" alt="${otherUser.username}">
                    </div>
                    ${isOnline ? '<div class="online-indicator"></div>' : ''}
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
    
    openChat(chat, otherUser) {
        this.activeChat = chat;
        this.renderChatList();
        this.renderChatMessages();
        
        const isOnline = this.onlineUsers.includes(otherUser.id);
        
        // Aktif sohbet başlığını göster
        document.getElementById('activeChatHeader').style.display = 'flex';
        document.getElementById('activeChatName').textContent = otherUser.username;
        document.getElementById('activeChatAvatar').src = otherUser.avatar || this.getDefaultAvatar();
        document.getElementById('activeChatStatus').textContent = isOnline ? 'Çevrimiçi' : 'Çevrimdışı';
        document.getElementById('activeChatStatus').className = isOnline ? 'online-status' : '';
        
        // Mesaj yazma alanını göster
        document.getElementById('chatInputContainer').style.display = 'block';
        
        // "Henüz sohbet yok" mesajını gizle
        document.querySelector('.no-chat-selected').style.display = 'none';
        
        document.getElementById('messageInput').disabled = false;
        document.getElementById('sendMessageBtn').disabled = false;
        
        console.log('Sohbet açıldı:', otherUser.username);
    }
    
    renderChatMessages() {
        const messagesContainer = document.getElementById('chatMessages');
        messagesContainer.innerHTML = '';
        
        if (!this.activeChat || !this.activeChat.messages || this.activeChat.messages.length === 0) {
            messagesContainer.innerHTML = `
                <div class="no-chat-selected" style="display: flex;">
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
    
    handleTyping() {
        if (!this.activeChat) return;
        
        this.socket.emit('typing_start', { chatId: this.activeChat.id });
        
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            this.socket.emit('typing_stop', { chatId: this.activeChat.id });
        }, 1000);
    }
    
    showTypingIndicator() {
        const messagesContainer = document.getElementById('chatMessages');
        
        let indicator = document.getElementById('typingIndicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'typingIndicator';
            indicator.className = 'typing-indicator';
            indicator.innerHTML = `
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            `;
            messagesContainer.appendChild(indicator);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }
    
    hideTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.remove();
        }
    }
    
    sendMessage() {
        const input = document.getElementById('messageInput');
        const text = input.value.trim();
        
        if (!text || !this.activeChat) return;
        
        const messageData = {
            chatId: this.activeChat.id,
            text: text
        };
        
        this.socket.emit('send_message', messageData);
        input.value = '';
        
        this.socket.emit('typing_stop', { chatId: this.activeChat.id });
    }
    
    handleNewMessage(message) {
        let chat = this.chats.find(c => c.id === message.chatId);
        
        if (!chat) {
            this.loadChats();
            return;
        }
        
        if (!chat.messages) {
            chat.messages = [];
        }
        
        chat.messages.push(message);
        chat.lastMessage = message;
        
        this.renderChatList();
        
        if (this.activeChat && this.activeChat.id === message.chatId) {
            this.hideTypingIndicator();
            this.renderChatMessages();
        }
    }
    
    updateUserStatus(userId, isOnline) {
        if (isOnline) {
            if (!this.onlineUsers.includes(userId)) {
                this.onlineUsers.push(userId);
            }
        } else {
            this.onlineUsers = this.onlineUsers.filter(id => id !== userId);
        }
        
        this.renderChatList();
        
        if (this.activeChat) {
            const otherUser = this.activeChat.otherUser;
            if (otherUser && otherUser.id === userId) {
                const statusEl = document.getElementById('activeChatStatus');
                statusEl.textContent = isOnline ? 'Çevrimiçi' : 'Çevrimdışı';
                statusEl.className = isOnline ? 'online-status' : '';
            }
        }
    }
    
    showNewChatModal() {
        document.getElementById('newChatModal').classList.remove('hidden');
        this.renderUsersList();
    }
    
    renderUsersList() {
        const usersList = document.getElementById('usersList');
        usersList.innerHTML = '';
        
        if (this.users.length === 0) {
            usersList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Başka kullanıcı yok</p>';
            return;
        }
        
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
    
    searchUsers(query) {
        const filteredUsers = this.users.filter(user => 
            user.username.toLowerCase().includes(query.toLowerCase()) ||
            user.email.toLowerCase().includes(query.toLowerCase())
        );
        
        const usersList = document.getElementById('usersList');
        usersList.innerHTML = '';
        
        if (filteredUsers.length === 0) {
            usersList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Kullanıcı bulunamadı</p>';
            return;
        }
        
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
    
    async startNewChat(user) {
        try {
            const response = await fetch('/api/start-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    otherUserId: user.id
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                document.getElementById('newChatModal').classList.add('hidden');
                
                // Sohbet listesini yenile
                await this.loadChats();
                
                // Yeni sohbeti aç
                if (data.chat) {
                    this.openChat(data.chat, user);
                }
                
                this.showToast('Yeni sohbet başlatıldı', 'success');
            } else {
                this.showToast(data.message || 'Sohbet başlatılamadı', 'error');
            }
        } catch (error) {
            console.error('Yeni sohbet başlatma hatası:', error);
            this.showToast('Bir hata oluştu', 'error');
        }
    }
    
    showEditProfileModal() {
        document.getElementById('editUsername').value = this.currentUser.username || '';
        document.getElementById('editBio').value = this.currentUser.bio || '';
        document.getElementById('editAvatar').value = this.currentUser.avatar || '';
        
        document.getElementById('editProfileModal').classList.remove('hidden');
    }
    
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
                headers: { 'Content-Type': 'application/json' },
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
                
                // localStorage'ı güncelle
                localStorage.setItem('current_user', JSON.stringify(this.currentUser));
                
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
    
    updateProfileDisplay() {
        if (!this.currentUser) return;
        
        document.getElementById('profileUsername').textContent = this.currentUser.username || 'Kullanıcı Adı';
        document.getElementById('profileBio').textContent = this.currentUser.bio || 'Hakkında bilgisi bulunmuyor';
        
        const navAvatar = document.getElementById('navAvatar');
        const profileAvatar = document.getElementById('profileAvatarImg');
        
        const avatarUrl = this.currentUser.avatar || this.getDefaultAvatar();
        if (navAvatar) navAvatar.src = avatarUrl;
        if (profileAvatar) profileAvatar.src = avatarUrl;
        
        if (document.getElementById('hideActivityToggle')) {
            document.getElementById('hideActivityToggle').checked = this.currentUser.hideActivity || false;
        }
    }
    
    getDefaultAvatar() {
        return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="50" fill="%23e0e0e0"/%3E%3Cpath d="M50 50c8.284 0 15-6.716 15-15s-6.716-15-15-15-15 6.716-15 15 6.716 15 15 15zm0 5c-10 0-30 5-30 15v10h60V70c0-10-20-15-30-15z" fill="%23999"/%3E%3C/svg%3E';
    }
    
    formatTime(timestamp) {
        if (!timestamp) return '';
        
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) return 'Şimdi';
        if (minutes < 60) return minutes + ' dk';
        if (hours < 24) return hours + ' sa';
        if (days < 7) return days + ' gün';
        
        return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    showToast(message, type = 'success') {
        const container = document.getElementById('toastContainer');
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <div class="toast-icon">
                ${type === 'success' ? `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                ` : `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                    </svg>
                `}
            </div>
            <div class="toast-message">${this.escapeHtml(message)}</div>
            <button class="toast-close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
            </button>
        `;
        
        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.remove();
        });
        
        container.appendChild(toast);
        
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 5000);
    }
}

// Uygulamayı başlat
document.addEventListener('DOMContentLoaded', () => {
    window.app = new InstaChat();
});
