const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// const { Chess } = require('chess.js'); // Optional: Backend validation
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
    // If words.js is missing or empty, use fallback
    const list = (wordList && wordList.length > 0) ? wordList : ["Apple", "Banana", "Cat", "Dog", "Sun"];
    const shuffled = list.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// Levenshtein Distance for "Close Guess"
function isCloseGuess(guess, actual) {
    if (!guess || !actual) return false;
    const s = guess.toLowerCase();
    const t = actual.toLowerCase();
    if (Math.abs(s.length - t.length) > 2) return false;
    if (t.includes(s) && t.length - s.length < 3 && s.length > 2) return true;
    return false;
}

// Tic-Tac-Toe Win Logic
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
        
        let initialGameData = {};
        
        if (gameType === 'scribble') {
            initialGameData = {
                roundTime: parseInt(settings?.time) || 60,
                currentRound: 1,
                drawerIndex: 0,
                currentDrawerId: null,
                currentWord: null,
                timer: null,
                guessedUsers: []
            };
        } else if (gameType === 'tictactoe') {
            initialGameData = { board: Array(9).fill(null), turn: 0 };
        } else if (gameType === 'chess') {
            initialGameData = { fen: 'start' };
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
    socket.on('join_room', ({ roomCode, username, avatar, gender }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }

        const user = { id: socket.id, username, avatar, gender, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        // Notify everyone in room
        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            adminId: room.adminId,
            gameType: room.gameType,
            state: room.state,
            gameData: (room.gameType === 'tictactoe') ? room.gameData : null
        });
    });

    // --- TIC TAC TOE MOVES ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'tictactoe') return;

        const turnPlayerIndex = room.gameData.turn % 2;
        // Ensure we have enough players
        if (room.users.length < 2) return; 
        
        const turnPlayer = room.users[turnPlayerIndex];
        
        if (turnPlayer.id !== socket.id) return; // Not your turn
        if (room.gameData.board[index]) return; // Cell taken

        // Update Board
        const symbol = turnPlayerIndex === 0 ? 'X' : 'O';
        room.gameData.board[index] = symbol;
        
        // Check Win
        const winnerSymbol = checkTicTacToeWin(room.gameData.board);
        
        if (winnerSymbol) {
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board, turn: room.gameData.turn });
            
            let winMsg = (winnerSymbol === 'draw') ? "It's a Draw!" : `${turnPlayer.username} Won!`;
            io.to(roomCode).emit('system_message', winMsg);
            
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

    function startScribbleRound(roomCode) {
        const room = rooms[roomCode];
        // Game Over Check
        if (room.gameData.currentRound > 3) {
            const leaderboard = [...room.users].sort((a, b) => b.score - a.score);
            io.to(roomCode).emit('scribble_game_over', leaderboard);
            room.state = "LOBBY";
            return;
        }

        const drawer = room.users[room.gameData.drawerIndex];
        room.gameData.currentDrawerId = drawer.id;
        room.gameData.currentWord = null;

        const options = getRandomWords(3);

        io.to(roomCode).emit('scribble_turn_waiting', { 
            drawer: drawer.username, 
            round: room.gameData.currentRound 
        });
        io.to(drawer.id).emit('scribble_choose_word', options);
    }

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

        // Timer
        let timeLeft = room.gameData.roundTime;
        if (room.gameData.timer) clearInterval(room.gameData.timer);
        
        room.gameData.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_update', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(room.gameData.timer);
                io.to(roomCode).emit('system_message', `⏰ Time's up! Word: ${room.gameData.currentWord}`);
                nextDrawer(roomCode);
            }
        }, 1000);
    });

    function nextDrawer(roomCode) {
        const room = rooms[roomCode];
        room.gameData.drawerIndex++;
        if (room.gameData.drawerIndex >= room.users.length) {
            room.gameData.drawerIndex = 0;
            room.gameData.currentRound++;
        }
        startScribbleRound(roomCode);
    }

    // --- DRAWING & CHESS RELAY ---
    socket.on('draw_data', (d) => socket.to(d.roomCode).emit('draw_data', d));
    socket.on('chess_move', (d) => socket.to(d.roomCode).emit('chess_move', d.move));

    // --- CHAT & GUESSING ---
    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const user = room.users.find(u => u.id === socket.id);
        if(!user) return;

        // Block drawer from chatting in Scribble
        if (room.gameType === 'scribble' && room.state === "PLAYING" && socket.id === room.gameData.currentDrawerId) {
            socket.emit('system_message', "⚠️ Shh! Drawers can't chat.");
            return;
        }

        // Check Guess
        if (room.gameType === 'scribble' && room.state === "PLAYING" && room.gameData.currentWord) {
            if (message.toLowerCase() === room.gameData.currentWord.toLowerCase()) {
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
            } else if (isCloseGuess(message, room.gameData.currentWord)) {
                socket.emit('system_message', `🔥 '${message}' is close!`);
            } else {
                io.to(roomCode).emit('receive_message', { username: user.username, message });
            }
        } else {
            io.to(roomCode).emit('receive_message', { username: user.username, message });
        }
    });

    socket.on('disconnect', () => {
        // Simple disconnect cleanup
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.users.findIndex(u => u.id === socket.id);
            if (idx !== -1) {
                room.users.splice(idx, 1);
                if (room.users.length === 0) delete rooms[code];
                else io.to(code).emit('update_room', { ...room }); // basic update
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
