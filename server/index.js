const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');
const wordList = require('./words');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// --- HELPER FUNCTIONS ---
function getRandomWords(count) {
    const shuffled = wordList.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id; // First person becomes admin
        io.to(roomCode).emit('admin_update', room.adminId);
        io.to(roomCode).emit('system_message', `${room.users[0].username} is now the Admin.`);
    }
}

// --- GAME LOOPS ---
function startScribbleRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if game over (3 Rounds)
    if (room.gameData.currentRound > 3) {
        // End Game - Calculate Leaderboard
        const leaderboard = room.users.sort((a, b) => b.score - a.score).slice(0, 3);
        io.to(roomCode).emit('scribble_game_over', leaderboard);
        room.state = "LOBBY";
        return;
    }

    // Check if all players have drawn this round
    if (room.gameData.drawerIndex >= room.users.length) {
        room.gameData.currentRound++;
        room.gameData.drawerIndex = 0;
        startScribbleRound(roomCode);
        return;
    }

    // Select Drawer
    const drawer = room.users[room.gameData.drawerIndex];
    room.gameData.currentDrawerId = drawer.id;
    room.gameData.currentWord = null;
    
    // Generate 3 Options
    const options = getRandomWords(3);
    
    // Notify everyone
    io.to(roomCode).emit('scribble_turn_waiting', { 
        drawer: drawer.username, 
        round: room.gameData.currentRound 
    });

    // Send options only to drawer
    io.to(drawer.id).emit('scribble_choose_word', options);
}

io.on('connection', (socket) => {
    
    // 1. CREATE ROOM
    socket.on('create_room', ({ roomName, username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        let initialGameData = {};
        
        // Initialize Game Specific Data
        if (gameType === 'scribble') {
            initialGameData = {
                roundTime: parseInt(settings.time) || 60,
                currentRound: 1,
                drawerIndex: 0,
                currentDrawerId: null,
                currentWord: null,
                timer: null,
                guessedUsers: []
            };
        } else if (gameType === 'chess') {
            initialGameData = { fen: 'start' }; // Chess FEN string
        }

        rooms[roomCode] = {
            name: roomName,
            adminId: socket.id,
            users: [],
            gameType: gameType,
            gameData: initialGameData,
            state: "LOBBY"
        };

        socket.emit('room_created', roomCode);
    });

    // 2. JOIN ROOM
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }

        const user = { 
            id: socket.id, 
            username, 
            avatar, 
            score: 0 
        };
        room.users.push(user);
        socket.join(roomCode);

        // Send full room state
        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            adminId: room.adminId,
            gameType: room.gameType,
            state: room.state
        });
    });

    // --- SCRIBBLE GAME EVENTS ---
    socket.on('scribble_start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            room.state = "PLAYING";
            room.gameData.currentRound = 1;
            room.gameData.drawerIndex = 0;
            room.users.forEach(u => u.score = 0); // Reset scores
            io.to(roomCode).emit('game_started');
            startScribbleRound(roomCode);
        }
    });

    socket.on('scribble_word_selected', ({ roomCode, word }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        room.gameData.currentWord = word;
        room.gameData.guessedUsers = [];
        
        // Mask word for others (e.g., "Apple" -> "_ _ _ _ _")
        const masked = word.replace(/[a-zA-Z]/g, '_ ');
        
        io.to(roomCode).emit('scribble_round_start', {
            drawerId: socket.id,
            maskedWord: masked,
            time: room.gameData.roundTime
        });

        // Start Timer Logic
        let timeLeft = room.gameData.roundTime;
        clearInterval(room.gameData.timer);
        room.gameData.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_update', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(room.gameData.timer);
                io.to(roomCode).emit('system_message', `Time's up! The word was ${room.gameData.currentWord}`);
                room.gameData.drawerIndex++;
                startScribbleRound(roomCode);
            }
        }, 1000);
    });

    socket.on('draw_data', ({ roomCode, data }) => {
        socket.to(roomCode).emit('draw_data', data); // Broadcast drawing to others
    });

    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Check if it's a correct guess in Scribble
        if (room.gameType === 'scribble' && 
            room.state === "PLAYING" && 
            room.gameData.currentWord && 
            message.toLowerCase() === room.gameData.currentWord.toLowerCase() &&
            socket.id !== room.gameData.currentDrawerId) {
                
            // Handle Correct Guess
            if (!room.gameData.guessedUsers.includes(socket.id)) {
                room.gameData.guessedUsers.push(socket.id);
                const user = room.users.find(u => u.id === socket.id);
                if (user) {
                    user.score += 100; // Simple scoring
                    io.to(roomCode).emit('system_message', `🎉 ${user.username} guessed the word!`);
                    io.to(roomCode).emit('update_scores', room.users);
                    
                    // If everyone guessed, end turn early
                    if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                        clearInterval(room.gameData.timer);
                        room.gameData.drawerIndex++;
                        startScribbleRound(roomCode);
                    }
                }
            }
        } else {
            // Normal Chat
            const user = room.users.find(u => u.id === socket.id);
            io.to(roomCode).emit('receive_message', { username: user.username, message });
        }
    });

    // --- CHESS EVENTS ---
    socket.on('chess_move', ({ roomCode, move }) => {
        socket.to(roomCode).emit('chess_move', move);
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const userIndex = room.users.findIndex(u => u.id === socket.id);
            
            if (userIndex !== -1) {
                const wasAdmin = room.adminId === socket.id;
                room.users.splice(userIndex, 1);
                
                // Remove room if empty
                if (room.users.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasAdmin) assignNextAdmin(code);
                    io.to(code).emit('update_room', {
                        roomName: room.name,
                        users: room.users,
                        adminId: room.adminId,
                        gameType: room.gameType,
                        state: room.state
                    });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));