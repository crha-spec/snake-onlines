const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket'] });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
let players = {};

io.on('connection', socket => {
  console.log('🟢 New connection:', socket.id);
  // Create player with random position/color
  players[socket.id] = {
    x: Math.floor(Math.random() * 800),
    y: Math.floor(Math.random() * 600),
    color: '#' + Math.floor(Math.random()*16777215).toString(16)
  };

  // send current players to the new client
  socket.emit('currentPlayers', players);
  // notify others
  socket.broadcast.emit('newPlayer', { id: socket.id, data: players[socket.id] });

  socket.on('move', pos => {
    if (!players[socket.id]) return;
    players[socket.id].x = pos.x;
    players[socket.id].y = pos.y;
    // broadcast to others (except sender) to reduce echo
    socket.broadcast.emit('playerMoved', { id: socket.id, data: players[socket.id] });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
