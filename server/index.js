const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');
const wordList = require('./words'); // Ensure you have your words.js file

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// --- HELPER: CHECK CLOSE GUESS (Levenshtein Distance) ---
function isCloseGuess(guess, actual) {
    if (!guess || !actual) return false;
    const s = guess.toLowerCase();
    const t = actual.toLowerCase();
    if (Math.abs(s.length - t.length) > 2) return false;
    
    // Simple checks for common partials
    if (t.includes(s) && t.length - s.length < 3 && s.length > 2) return true;
    return false; // Keep it simple for performance
}

// --- TIC TAC TOE LOGIC ---
function checkTicTacToeWin(board) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], 
        [0, 3, 6], [1, 4, 7], [2, 5, 8], 
        [0, 4, 8], [2, 4, 6]
    ];
    for (let line of lines) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return board.includes(null) ? null : 'draw';
}

io.on('connection', (socket) => {
    
    // 1. CREATE ROOM
    socket.on('create_room', ({ username, avatar, roomName, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        let gameData = {};
        if (gameType === 'scribble') {
            gameData = { 
                roundTime: parseInt(settings.time) || 60, currentRound: 1, 
                drawerIndex: 0, currentDrawerId: null, currentWord: null, 
                guessedUsers: [], timer: null 
            };
        } else if (gameType === 'tictactoe') {
            gameData = { board: Array(9).fill(null), turn: 0 }; // 0 = X, 1 = O
        } else if (gameType === 'chess') {
            gameData = { fen: 'start' };
        }

        rooms[roomCode] = {
            name: roomName,
            adminId: socket.id,
            users: [],
            gameType,
            gameData,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    // 2. JOIN ROOM
    socket.on('join_room', ({ roomCode, username, avatar, gender }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }

        const user = { id: socket.id, username, avatar, gender, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        // Sort users A-Z for list display
        room.users.sort((a, b) => a.username.localeCompare(b.username));

        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            adminId: room.adminId,
            gameType: room.gameType,
            state: room.state,
            gameData: room.gameType === 'tictactoe' ? room.gameData : null
        });
    });

    // --- TIC TAC TOE MOVES ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'tictactoe') return;

        // Check turn
        const turnPlayerIndex = room.gameData.turn % 2;
        const turnPlayer = room.users[turnPlayerIndex];
        
        if (turnPlayer.id !== socket.id) return; // Not your turn
        if (room.gameData.board[index]) return; // Taken

        // Update Board
        const symbol = turnPlayerIndex === 0 ? 'X' : 'O';
        room.gameData.board[index] = symbol;
        
        // Check Win
        const winner = checkTicTacToeWin(room.gameData.board);
        
        if (winner) {
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board, turn: room.gameData.turn });
            io.to(roomCode).emit('system_message', winner === 'draw' ? "It's a Draw!" : `${turnPlayer.username} Won!`);
            
            // Reset after 3s
            setTimeout(() => {
                room.gameData.board = Array(9).fill(null);
                room.gameData.turn = 0;
                io.to(roomCode).emit('ttt_update', { board: room.gameData.board, turn: 0 });
            }, 3000);
        } else {
            room.gameData.turn++;
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board, turn: room.gameData.turn });
        }
    });

    // --- SCRIBBLE LOGIC ---
    socket.on('scribble_start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            room.state = "PLAYING";
            room.users.forEach(u => u.score = 0);
            io.to(roomCode).emit('game_started');
            startScribbleRound(roomCode);
        }
    });

    socket.on('scribble_word_selected', ({ roomCode, word }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        room.gameData.currentWord = word;
        room.gameData.guessedUsers = [];
        const masked = word.replace(/[a-zA-Z]/g, '_ ');

        io.to(roomCode).emit('scribble_round_start', {
            drawerId: socket.id,
            maskedWord: masked,
            time: room.gameData.roundTime
        });

        // Timer Logic
        let timeLeft = room.gameData.roundTime;
        clearInterval(room.gameData.timer);
        room.gameData.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_update', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(room.gameData.timer);
                io.to(roomCode).emit('system_message', `⏰ Time's up! Word was: ${room.gameData.currentWord}`);
                nextDrawer(roomCode);
            }
        }, 1000);
    });

    function nextDrawer(roomCode) {
        const room = rooms[roomCode];
        room.gameData.drawerIndex++;
        if (room.gameData.drawerIndex >= room.users.length) {
            // End of full rotation, check rounds
            room.gameData.drawerIndex = 0;
            room.gameData.currentRound++;
        }
        startScribbleRound(roomCode);
    }

    function startScribbleRound(roomCode) {
        const room = rooms[roomCode];
        if (room.gameData.currentRound > 3) {
            // Game Over - Leaderboard Sorted by Score
            const leaderboard = [...room.users].sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('scribble_game_over', leaderboard);
            room.state = "LOBBY";
            return;
        }
        
        const drawer = room.users[room.gameData.drawerIndex];
        room.gameData.currentDrawerId = drawer.id;
        room.gameData.currentWord = null;

        const options = require('./words').sort(() => 0.5 - Math.random()).slice(0, 3);

        io.to(roomCode).emit('scribble_turn_waiting', { 
            drawer: drawer.username, 
            round: room.gameData.currentRound 
        });
        io.to(drawer.id).emit('scribble_choose_word', options);
    }

    // --- CHAT & GUESSING ---
    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const user = room.users.find(u => u.id === socket.id);
        
        // 1. If Scribble & User is Drawer -> BLOCK
        if (room.gameType === 'scribble' && room.state === "PLAYING" && socket.id === room.gameData.currentDrawerId) {
            socket.emit('system_message', "⚠️ You are drawing! You cannot chat/cheat.");
            return;
        }

        // 2. Scribble Guessing Logic
        if (room.gameType === 'scribble' && room.state === "PLAYING" && room.gameData.currentWord) {
            const word = room.gameData.currentWord;
            
            if (message.toLowerCase() === word.toLowerCase()) {
                // Correct Guess
                if (!room.gameData.guessedUsers.includes(socket.id)) {
                    room.gameData.guessedUsers.push(socket.id);
                    user.score += 100;
                    io.to(roomCode).emit('system_message', `🎉 ${user.username} guessed it!`);
                    io.to(roomCode).emit('update_scores', room.users);
                    
                    if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                        clearInterval(room.gameData.timer);
                        nextDrawer(roomCode);
                    }
                }
            } else if (isCloseGuess(message, word)) {
                // Close Guess (Only show to the user)
                socket.emit('system_message', `🔥 '${message}' is very close!`);
            } else {
                io.to(roomCode).emit('receive_message', { username: user.username, message });
            }
        } else {
            io.to(roomCode).emit('receive_message', { username: user.username, message });
        }
    });

    // --- DRAWING & CHESS RELAY ---
    socket.on('draw_data', (d) => socket.to(d.roomCode).emit('draw_data', d));
    socket.on('chess_move', (d) => socket.to(d.roomCode).emit('chess_move', d.move));

    socket.on('disconnect', () => { /* (Keep previous disconnect logic) */ });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
