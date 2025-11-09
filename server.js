// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO connection logic
io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  // Listen for a user joining a room
  socket.on('join-room', ({ username, room }) => {
    // Store user data on the socket object
    socket.username = username;
    socket.room = room;

    // Get a list of other users in the room
    const roomClients = io.sockets.adapter.rooms.get(room);
    const otherUsers = [];
    if (roomClients) {
      roomClients.forEach(clientId => {
        // Find the socket object for each client ID
        const clientSocket = io.sockets.sockets.get(clientId);
        if (clientSocket && clientSocket.id !== socket.id) {
          otherUsers.push({
            id: clientSocket.id,
            username: clientSocket.username
          });
        }
      });
    }

    // Join the specified room
    socket.join(room);

    console.log(`User ${username} (Socket ${socket.id}) joined room: ${room}`);

    // Notify the user they have successfully joined and send list of others
    socket.emit('joined-room', { room, otherUsers });

    // Notify everyone else in the room that a new user has joined
    socket.to(room).emit('user-joined', {
      id: socket.id,
      username: username
    });
  });

  // Listen for chat messages
  socket.on('chat-message', ({ room, message }) => {
    // Broadcast the message to everyone in the room
    io.to(room).emit('new-message', {
      username: socket.username,
      message: message
    });
  });

  // --- WebRTC Signaling Handlers ---

  // Forward an offer to a specific target user
  socket.on('offer', (payload) => {
    console.log(`Forwarding offer from ${socket.id} to ${payload.target}`);
    io.to(payload.target).emit('offer', {
      source: socket.id,
      sdp: payload.sdp,
      username: socket.username
    });
  });

  // Forward an answer back to the source user
  socket.on('answer', (payload) => {
    console.log(`Forwarding answer from ${socket.id} to ${payload.target}`);
    io.to(payload.target).emit('answer', {
      source: socket.id,
      sdp: payload.sdp
    });
  });

  // Forward an ICE candidate to a specific target user
  socket.on('ice-candidate', (payload) => {
    io.to(payload.target).emit('ice-candidate', {
      source: socket.id,
      candidate: payload.candidate
    });
  });

  // Listen for a user disconnecting
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // If the user was in a room, notify the room
    if (socket.username && socket.room) {
      io.to(socket.room).emit('user-left', {
        id: socket.id,
        username: socket.username
      });
      console.log(`User ${socket.username} left room: ${socket.room}`);
    }
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});