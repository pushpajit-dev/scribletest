// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Setup Socket.io to allow connections from your future Netlify site
const io = new Server(server, {
    cors: {
        origin: "*", // Allows access from any link (easier for beginners)
        methods: ["GET", "POST"]
    }
});

// Store room data in memory
const rooms = {}; 

io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // 1. Create a Room
    socket.on('create_room', (data) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit code
        rooms[roomCode] = {
            users: [],
            maxUsers: 10,
            settings: data.settings
        };
        socket.emit('room_created', roomCode);
    });

    // 2. Join a Room
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error', 'Room does not exist');
            return;
        }
        if (room.users.length >= room.maxUsers) {
            socket.emit('error', 'Room is full');
            return;
        }

        // Add user to room
        const user = { id: socket.id, username, avatar };
        room.users.push(user);
        socket.join(roomCode);

        // Send updated user list to everyone in that room
        io.to(roomCode).emit('update_users', room.users);
        
        // Send a welcome system message
        io.to(roomCode).emit('receive_message', {
            username: 'System',
            message: `${username} has joined!`,
            isSystem: true
        });
    });

    // 3. Handle Chat Messages
    socket.on('send_message', (data) => {
        io.to(data.roomCode).emit('receive_message', data);
    });

    // 4. Handle Disconnect
    socket.on('disconnect', () => {
        // Find the room the user was in and remove them
        for (const code in rooms) {
            const index = rooms[code].users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                rooms[code].users.splice(index, 1);
                io.to(code).emit('update_users', rooms[code].users);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});