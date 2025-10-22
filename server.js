require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';

// ------------------- MIDDLEWARE ----------------
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // prod: true if https
}));

// ------------------- MONGODB ------------------
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(()=>console.log('MongoDB bağlandı')).catch(err=>console.error('MongoDB hata:', err));

// ------------------- SCHEMAS ------------------
const userSchema = new mongoose.Schema({
  email: { type: String, required:true, unique:true },
  username: String,
  profilePhoto: String,
  nameColor: String,
  server: { type:String, default:'TR' },
  createdAt: { type: Date, default: Date.now }
});
const messageSchema = new mongoose.Schema({
  serverId: String,
  userId: String,
  username: String,
  profilePhoto: String,
  nameColor: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  edited: { type: Boolean, default: false }
});
const verificationSchema = new mongoose.Schema({
  email: { type:String, required:true },
  code: String,
  createdAt: { type:Date, default: Date.now, expires: 300 } // 5dk
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Verification = mongoose.model('Verification', verificationSchema);

// ------------------- MAILER -------------------
let transporter;
if(process.env.SMTP_HOST){
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// ------------------- API ----------------------

// send verification code
app.post('/api/send-code', async (req,res)=>{
  const { email } = req.body;
  if(!email) return res.json({ success:false, error:'Email boş' });

  const code = (''+Math.floor(100000 + Math.random()*900000));
  await Verification.findOneAndDelete({ email });

  const ver = new Verification({ email, code });
  await ver.save();

  // send mail
  if(transporter){
    try {
      await transporter.sendMail({
        from: '"Global Chat" <no-reply@globalchat.com>',
        to: email,
        subject: 'Doğrulama Kodu',
        text: `Doğrulama Kodunuz: ${code}`
      });
    } catch(e){
      console.error('Mail gönderilemedi:', e);
    }
  } else {
    console.log(`DEBUG Mail: ${email} Kodu: ${code}`);
  }

  res.json({ success:true, code }); // debug code client görebilir
});

// verify code
app.post('/api/verify-code', async (req,res)=>{
  const { email, code } = req.body;
  if(!email || !code) return res.json({ success:false, error:'Eksik bilgi' });

  const ver = await Verification.findOne({ email, code });
  if(!ver) return res.json({ success:false, error:'Kod geçersiz veya süresi dolmuş' });

  // get or create user
  let user = await User.findOne({ email });
  if(!user){
    user = new User({ email });
    await user.save();
  }

  req.session.userId = user._id;
  res.json({ success:true, user });
});

// profile setup
app.post('/api/profile-setup', async (req,res)=>{
  const { username, nameColor, profilePhoto, email } = req.body;
  if(!username) return res.json({ success:false, error:'Kullanıcı adı gerekli' });

  let user;
  if(req.session.userId){
    user = await User.findById(req.session.userId);
  } else if(email){
    user = await User.findOne({ email });
  }

  if(!user) return res.json({ success:false, error:'Kullanıcı bulunamadı' });

  user.username = username;
  user.nameColor = nameColor || '#4285F4';
  if(profilePhoto) user.profilePhoto = profilePhoto;
  await user.save();

  req.session.userId = user._id;
  res.json({ success:true, user });
});

// get current user
app.get('/api/user', async (req,res)=>{
  if(!req.session.userId) return res.json({ user:null });
  const user = await User.findById(req.session.userId);
  res.json({ user });
});

// get messages
app.get('/api/messages/:serverId', async (req,res)=>{
  const { serverId } = req.params;
  const msgs = await Message.find({ serverId }).sort({ timestamp:1 }).limit(200);
  res.json(msgs);
});

// logout
app.get('/logout', (req,res)=>{
  req.session.destroy(err=>{ res.redirect('/'); });
});

// ------------------- SOCKET.IO ----------------
io.on('connection', socket=>{
  let currentServer = null;
  let currentUserId = null;

  socket.on('join-server', async ({ serverId, userId })=>{
    currentServer = serverId || 'TR';
    currentUserId = userId;
    socket.join(currentServer);

    const count = io.sockets.adapter.rooms.get(currentServer)?.size || 0;
    io.to(currentServer).emit('user-count', { count });
  });

  socket.on('send-message', async (msg)=>{
    const m = new Message(msg);
    await m.save();
    io.to(msg.serverId).emit('new-message', m);
  });

  socket.on('edit-message', async ({ messageId, newMessage })=>{
    const m = await Message.findById(messageId);
    if(m){
      m.message = newMessage;
      m.edited = true;
      await m.save();
      io.to(m.serverId).emit('message-edited', { messageId:m._id, newMessage });
    }
  });

  socket.on('typing', ({ serverId, username, isTyping })=>{
    socket.to(serverId).emit('user-typing', { username, isTyping });
  });

  socket.on('disconnect', ()=>{
    if(currentServer){
      const count = io.sockets.adapter.rooms.get(currentServer)?.size || 0;
      io.to(currentServer).emit('user-count', { count });
    }
  });
});

// ------------------- START SERVER -------------
server.listen(PORT, ()=>console.log(`Server ${PORT} portunda çalışıyor`));
