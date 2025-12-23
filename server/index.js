const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

// Helper word list for Scribble
const wordList = [
    "apple", "banana", "cherry", "dog", "cat", "elephant", "guitar", "house", "island", 
    "jungle", "kite", "lemon", "mountain", "notebook", "ocean", "penguin", "queen", 
    "robot", "sun", "tree", "umbrella", "violin", "whale", "xylophone", "yacht", "zebra",
    "airplane", "book", "car", "dragon", "egg", "flower", "ghost", "hammer", "ice", 
    "jacket", "key", "lamp", "moon", "nose", "owl", "pencil", "quilt", "rainbow", 
    "snake", "train", "unicorn", "volcano", "watch", "box", "yo-yo", "zipper"
];

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
        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            adminId: room.adminId,
            gameType: room.gameType,
            state: room.state
        });
        io.to(roomCode).emit('system_message', `${room.users[0].username} is now the Admin.`);
    }
}

// Check Win for Tic-Tac-Toe (Dynamic Grid Size)
function checkTTTWin(board, size) {
    const sizeInt = parseInt(size);
    
    // Rows
    for (let i = 0; i < sizeInt * sizeInt; i += sizeInt) {
        if (board[i] && board.slice(i, i + sizeInt).every(val => val === board[i])) return board[i];
    }
    
    // Columns
    for (let i = 0; i < sizeInt; i++) {
        let col = [];
        for (let j = 0; j < sizeInt; j++) col.push(board[i + (j * sizeInt)]);
        if (col[0] && col.every(val => val === col[0])) return col[0];
    }
    
    // Diagonal 1 (Top-Left to Bottom-Right)
    let d1 = [];
    for (let i = 0; i < sizeInt; i++) d1.push(board[i * (sizeInt + 1)]);
    if (d1[0] && d1.every(val => val === d1[0])) return d1[0];

    // Diagonal 2 (Top-Right to Bottom-Left)
    let d2 = [];
    for (let i = 0; i < sizeInt; i++) d2.push(board[(i + 1) * (sizeInt - 1)]);
    if (d2[0] && d2.every(val => val === d2[0])) return d2[0];

    // Draw?
    if (board.every(cell => cell !== null)) return 'DRAW';
    
    return null;
}

// --- GAME LOOPS ---

function startScribbleRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if game over (Max Rounds reached)
    const maxRounds = parseInt(room.settings?.rounds) || 3;
    
    if (room.gameData.currentRound > maxRounds) {
        // End Game - Calculate Leaderboard
        const leaderboard = room.users.sort((a, b) => b.score - a.score).slice(0, 5);
        io.to(roomCode).emit('scribble_game_over', leaderboard);
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', { ...room, state: "LOBBY" }); // Refresh UI to lobby
        return;
    }

    // Check if all players have drawn this round
    if (room.gameData.drawerIndex >= room.users.length) {
        room.gameData.currentRound++;
        room.gameData.drawerIndex = 0;
        startScribbleRound(roomCode); // Start next round immediately
        return;
    }

    // Select Drawer
    const drawer = room.users[room.gameData.drawerIndex];
    room.gameData.currentDrawerId = drawer.id;
    room.gameData.currentWord = null;
    room.gameData.guessedUsers = [];
    
    // Generate 3 Options
    const options = getRandomWords(3);
    
    // Notify everyone who is drawing
    io.to(roomCode).emit('scribble_turn_waiting', { 
        drawer: drawer.username, 
        round: room.gameData.currentRound,
        total: maxRounds
    });

    // Send options ONLY to the drawer
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
                currentRound: 1,
                drawerIndex: 0,
                currentDrawerId: null,
                currentWord: null,
                timer: null,
                guessedUsers: []
            };
        } else if (gameType === 'chess') {
            const chess = new Chess();
            initialGameData = { 
                fen: chess.fen(),
                pgn: chess.pgn() 
            }; 
        } else if (gameType === 'tictactoe') {
            const size = parseInt(settings.tttGrid) || 3;
            initialGameData = {
                board: Array(size * size).fill(null),
                turn: 'X', // X always starts
                size: size
            };
        }

        rooms[roomCode] = {
            name: roomName,
            adminId: socket.id,
            users: [],
            gameType: gameType,
            settings: settings, // Store settings (time, rounds, grid size)
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
            state: room.state,
            settings: room.settings,
            drawerId: room.gameData.currentDrawerId // Important for re-joins
        });

        // If TTT, send grid size initialization immediately
        if (room.gameType === 'tictactoe') {
            socket.emit('ttt_init', room.gameData.size);
            socket.emit('ttt_update', { board: room.gameData.board });
        }
        
        // If Chess, send current board state
        if (room.gameType === 'chess') {
            socket.emit('chess_move', { fen: room.gameData.fen }); // Sync board
        }
        
        // Send join message
        io.to(roomCode).emit('system_message', `${username} joined the room!`);
    });

    // --- SCRIBBLE GAME EVENTS ---
    socket.on('scribble_start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            room.state = "PLAYING";
            room.gameData.currentRound = 1;
            room.gameData.drawerIndex = 0;
            room.users.forEach(u => u.score = 0); // Reset scores
            
            // Notify clients to switch views
            io.to(roomCode).emit('update_room', {
                roomName: room.name,
                users: room.users,
                adminId: room.adminId,
                gameType: room.gameType,
                state: room.state,
                settings: room.settings
            });

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
        
        const roundTime = parseInt(room.settings?.time) || 60;

        io.to(roomCode).emit('scribble_round_start', {
            drawerId: socket.id,
            maskedWord: masked,
            time: roundTime
        });

        // Start Timer Logic
        let timeLeft = roundTime;
        clearInterval(room.gameData.timer);
        
        // Immediate update
        io.to(roomCode).emit('timer_update', timeLeft);

        room.gameData.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_update', timeLeft);
            
            if (timeLeft <= 0) {
                clearInterval(room.gameData.timer);
                io.to(roomCode).emit('system_message', `⏰ Time's up! The word was '${room.gameData.currentWord}'`);
                room.gameData.drawerIndex++;
                startScribbleRound(roomCode);
            }
        }, 1000);
    });

    socket.on('draw_data', (payload) => {
        // payload: { roomCode, x, y, color, type }
        // Broadcast to everyone ELSE in the room
        socket.to(payload.roomCode).emit('draw_data', payload);
    });

    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const user = room.users.find(u => u.id === socket.id);

        // Check if it's a correct guess in Scribble
        if (room.gameType === 'scribble' && 
            room.state === "PLAYING" && 
            room.gameData.currentWord && 
            message.toLowerCase().trim() === room.gameData.currentWord.toLowerCase().trim() &&
            socket.id !== room.gameData.currentDrawerId) {
                
            // Handle Correct Guess
            if (!room.gameData.guessedUsers.includes(socket.id)) {
                room.gameData.guessedUsers.push(socket.id);
                
                if (user) {
                    // Score calculation: more points for guessing faster? 
                    // For now simple +100
                    user.score += 100; 
                    
                    // Give Drawer some points too?
                    const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                    if(drawer) drawer.score += 25;

                    io.to(roomCode).emit('system_message', `🎉 ${user.username} guessed the word!`);
                    
                    // Update scores in UI
                    io.to(roomCode).emit('update_room', {
                        roomName: room.name,
                        users: room.users, // Send updated scores
                        adminId: room.adminId,
                        gameType: room.gameType,
                        state: room.state,
                        settings: room.settings,
                        drawerId: room.gameData.currentDrawerId
                    });
                    
                    // If everyone (except drawer) guessed, end turn early
                    if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                        clearInterval(room.gameData.timer);
                        io.to(roomCode).emit('system_message', `Everyone guessed it! The word was '${room.gameData.currentWord}'`);
                        room.gameData.drawerIndex++;
                        // Small delay before next round
                        setTimeout(() => startScribbleRound(roomCode), 3000);
                    }
                }
            }
        } else {
            // Normal Chat
            if(user) {
                io.to(roomCode).emit('receive_message', { username: user.username, message });
            }
        }
    });

    // --- CHESS EVENTS ---
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'chess') return;

        // Server-side validation
        const chess = new Chess(room.gameData.fen || undefined);
        
        try {
            const result = chess.move(move); // Try the move
            if (result) {
                // Move was valid
                room.gameData.fen = chess.fen();
                io.to(roomCode).emit('chess_move', move); // Broadcast valid move
            }
        } catch (e) {
            console.log("Invalid move attempt:", move);
        }
    });

    // --- TIC TAC TOE EVENTS ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'tictactoe') return;

        const { board, turn, size } = room.gameData;

        // Valid Move?
        if (board[index] === null) {
            board[index] = turn;
            
            // Broadcast Move
            io.to(roomCode).emit('ttt_update', { board });

            // Check Win
            const winner = checkTTTWin(board, size);
            if (winner) {
                if (winner === 'DRAW') {
                    io.to(roomCode).emit('system_message', `It's a Draw!`);
                } else {
                    io.to(roomCode).emit('system_message', `${winner} Wins!`);
                }
                // Reset Board after 3 seconds
                setTimeout(() => {
                    room.gameData.board = Array(size * size).fill(null);
                    room.gameData.turn = 'X';
                    io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
                    io.to(roomCode).emit('system_message', `New Game Started!`);
                }, 3000);
            } else {
                // Switch Turn
                room.gameData.turn = turn === 'X' ? 'O' : 'X';
            }
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const userIndex = room.users.findIndex(u => u.id === socket.id);
            
            if (userIndex !== -1) {
                const wasAdmin = room.adminId === socket.id;
                const leavingUser = room.users[userIndex];
                
                room.users.splice(userIndex, 1);
                io.to(code).emit('system_message', `${leavingUser.username} left the room.`);

                // Remove room if empty
                if (room.users.length === 0) {
                    delete rooms[code];
                    console.log(`Room ${code} deleted.`);
                } else {
                    if (wasAdmin) assignNextAdmin(code);
                    
                    io.to(code).emit('update_room', {
                        roomName: room.name,
                        users: room.users,
                        adminId: room.adminId,
                        gameType: room.gameType,
                        state: room.state,
                        settings: room.settings,
                        drawerId: room.gameData.currentDrawerId
                    });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));