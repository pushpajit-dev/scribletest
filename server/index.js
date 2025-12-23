const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

// --- WORD LIST ---
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

// --- HELPERS ---

function getRandomWords(count) {
    const shuffled = wordList.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id;
        io.to(roomCode).emit('update_room', getRoomPublicData(room));
        io.to(roomCode).emit('system_message', `👑 ${room.users[0].username} is now the Admin.`);
    }
}

// Clean data object to send to client (avoids circular refs or massive history dumps repeatedly)
function getRoomPublicData(room) {
    return {
        roomName: room.name,
        users: room.users,
        adminId: room.adminId,
        gameType: room.gameType,
        state: room.state,
        settings: room.settings,
        drawerId: room.gameData?.currentDrawerId || null,
        roundInfo: room.gameData ? { current: room.gameData.currentRound, total: room.settings.rounds } : null
    };
}

// Reveal a random letter in the masked word
function revealHint(roomCode) {
    const room = rooms[roomCode];
    if (!room || !room.gameData.currentWord) return;

    const word = room.gameData.currentWord;
    const masked = room.gameData.maskedWord.split(' '); // "_ _ _ _" -> ["_", "_", "_", "_"]
    
    // Find indices that are still hidden
    const hiddenIndices = [];
    for(let i=0; i<masked.length; i++) {
        if(masked[i] === '_') hiddenIndices.push(i);
    }

    if (hiddenIndices.length > 0) {
        // Reveal one random index
        const revealIndex = hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)];
        masked[revealIndex] = word[revealIndex];
        room.gameData.maskedWord = masked.join(' ');
        
        io.to(roomCode).emit('update_mask', room.gameData.maskedWord);
    }
}

// --- GAME LOGIC ---

function startScribbleRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const maxRounds = parseInt(room.settings?.rounds) || 3;
    
    if (room.gameData.currentRound > maxRounds) {
        const leaderboard = room.users.sort((a, b) => b.score - a.score).slice(0, 5);
        io.to(roomCode).emit('scribble_game_over', leaderboard);
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomPublicData(room));
        return;
    }

    if (room.gameData.drawerIndex >= room.users.length) {
        room.gameData.currentRound++;
        room.gameData.drawerIndex = 0;
        startScribbleRound(roomCode);
        return;
    }

    const drawer = room.users[room.gameData.drawerIndex];
    room.gameData.currentDrawerId = drawer.id;
    room.gameData.currentWord = null;
    room.gameData.guessedUsers = [];
    room.gameData.drawHistory = []; // Clear canvas history for new round
    
    // Clear canvas on all clients
    io.to(roomCode).emit('clear_canvas');
    io.to(roomCode).emit('update_room', getRoomPublicData(room));

    const options = getRandomWords(3);
    
    io.to(roomCode).emit('scribble_turn_waiting', { 
        drawer: drawer.username, 
        round: room.gameData.currentRound,
        total: maxRounds
    });

    io.to(drawer.id).emit('scribble_choose_word', options);
}

// Check Win for Tic-Tac-Toe
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
    // Diagonals
    let d1 = [];
    for (let i = 0; i < sizeInt; i++) d1.push(board[i * (sizeInt + 1)]);
    if (d1[0] && d1.every(val => val === d1[0])) return d1[0];

    let d2 = [];
    for (let i = 0; i < sizeInt; i++) d2.push(board[(i + 1) * (sizeInt - 1)]);
    if (d2[0] && d2.every(val => val === d2[0])) return d2[0];

    if (board.every(cell => cell !== null)) return 'DRAW';
    return null;
}

io.on('connection', (socket) => {
    
    // 1. CREATE ROOM
    socket.on('create_room', ({ roomName, username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        let initialGameData = {};
        
        if (gameType === 'scribble') {
            initialGameData = {
                currentRound: 1,
                drawerIndex: 0,
                currentDrawerId: null,
                currentWord: null,
                maskedWord: "",
                timer: null,
                guessedUsers: [],
                drawHistory: [] // Store strokes for Undo/Redraw
            };
        } else if (gameType === 'chess') {
            const chess = new Chess();
            initialGameData = { fen: chess.fen() }; 
        } else if (gameType === 'tictactoe') {
            const size = parseInt(settings.tttGrid) || 3;
            initialGameData = {
                board: Array(size * size).fill(null),
                turn: 'X',
                size: size
            };
        }

        rooms[roomCode] = {
            name: roomName,
            adminId: socket.id,
            users: [],
            gameType: gameType,
            settings: settings || { rounds: 3, time: 60, tttGrid: 3 },
            gameData: initialGameData,
            state: "LOBBY"
        };

        socket.emit('room_created', roomCode);
    });

    // 2. JOIN ROOM
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }

        // Prevent duplicates
        const existingUser = room.users.find(u => u.id === socket.id);
        if (!existingUser) {
            room.users.push({ id: socket.id, username, avatar, score: 0 });
        }
        socket.join(roomCode);

        // Update everyone
        io.to(roomCode).emit('update_room', getRoomPublicData(room));

        // Sync Game State for Joiner
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            // Send current canvas state to the new joiner
            socket.emit('canvas_history', room.gameData.drawHistory);
            socket.emit('scribble_round_start', {
                drawerId: room.gameData.currentDrawerId,
                maskedWord: room.gameData.maskedWord,
                time: 0 // Client just syncs visual, timer is separate event
            });
        } else if (room.gameType === 'tictactoe') {
            socket.emit('ttt_init', room.gameData.size);
            socket.emit('ttt_update', { board: room.gameData.board });
        } else if (room.gameType === 'chess') {
            socket.emit('chess_state', room.gameData.fen);
        }
        
        io.to(roomCode).emit('system_message', `👋 ${username} joined!`);
    });

    // --- SCRIBBLE EVENTS ---
    socket.on('scribble_start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            room.state = "PLAYING";
            room.gameData.currentRound = 1;
            room.gameData.drawerIndex = 0;
            room.users.forEach(u => u.score = 0);
            io.to(roomCode).emit('update_room', getRoomPublicData(room));
            startScribbleRound(roomCode);
        }
    });

    socket.on('scribble_word_selected', ({ roomCode, word }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        room.gameData.currentWord = word;
        room.gameData.guessedUsers = [];
        // Create mask (e.g., "Apple" -> "_ _ _ _ _")
        room.gameData.maskedWord = word.replace(/[a-zA-Z]/g, '_ ').trim();
        
        const roundTime = parseInt(room.settings?.time) || 60;

        io.to(roomCode).emit('scribble_round_start', {
            drawerId: socket.id,
            maskedWord: room.gameData.maskedWord,
            time: roundTime
        });

        // Timer Logic with Hints
        let timeLeft = roundTime;
        clearInterval(room.gameData.timer);
        
        io.to(roomCode).emit('timer_update', timeLeft);

        room.gameData.timer = setInterval(() => {
            timeLeft--;
            io.to(roomCode).emit('timer_update', timeLeft);

            // HINT LOGIC: Reveal at 75% and 50% time
            if (timeLeft === Math.floor(roundTime * 0.75) || timeLeft === Math.floor(roundTime * 0.5)) {
                revealHint(roomCode);
            }
            
            if (timeLeft <= 0) {
                clearInterval(room.gameData.timer);
                io.to(roomCode).emit('system_message', `⏰ Time's up! The word was '${room.gameData.currentWord}'`);
                room.gameData.drawerIndex++;
                startScribbleRound(roomCode);
            }
        }, 1000);
    });

    // DRAWING - Fixed Logic for History & Sync
    socket.on('draw_event', (data) => {
        // data: { roomCode, type: 'start'|'move'|'end', x, y, color }
        const room = rooms[data.roomCode];
        if (!room) return;

        // Store history for resizing/undo/new joiners
        // We organize history as an array of "strokes". Each stroke is an array of points.
        if (data.type === 'start') {
            room.gameData.currentStroke = { 
                color: data.color, 
                points: [{ x: data.x, y: data.y }] 
            };
        } else if (data.type === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({ x: data.x, y: data.y });
        } else if (data.type === 'end' && room.gameData.currentStroke) {
            room.gameData.drawHistory.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }

        // Broadcast to others
        socket.to(data.roomCode).emit('draw_event', data);
    });

    socket.on('draw_undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.gameData.drawHistory.length > 0) {
            room.gameData.drawHistory.pop(); // Remove last stroke
            io.to(roomCode).emit('canvas_history', room.gameData.drawHistory); // Re-draw everything
        }
    });

    socket.on('clear_canvas', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room) {
            room.gameData.drawHistory = [];
            io.to(roomCode).emit('clear_canvas');
        }
    });

    socket.on('send_reaction', ({ roomCode, type }) => {
        io.to(roomCode).emit('show_reaction', { type });
    });

    // CHAT & GUESSING
    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);

        if (room.gameType === 'scribble' && 
            room.state === "PLAYING" && 
            room.gameData.currentWord && 
            message.toLowerCase().trim() === room.gameData.currentWord.toLowerCase().trim() &&
            socket.id !== room.gameData.currentDrawerId) {
                
            if (!room.gameData.guessedUsers.includes(socket.id)) {
                room.gameData.guessedUsers.push(socket.id);
                if (user) user.score += 100; 
                
                const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                if(drawer) drawer.score += 25;

                io.to(roomCode).emit('system_message', `🎉 ${user.username} guessed the word!`);
                io.to(roomCode).emit('update_room', getRoomPublicData(room)); // Update scores
                
                if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                    clearInterval(room.gameData.timer);
                    io.to(roomCode).emit('system_message', `Everyone guessed it! The word was '${room.gameData.currentWord}'`);
                    room.gameData.drawerIndex++;
                    setTimeout(() => startScribbleRound(roomCode), 3000);
                }
            }
        } else {
            if(user) io.to(roomCode).emit('receive_message', { username: user.username, message });
        }
    });

    // CHESS
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'chess') return;
        const chess = new Chess(room.gameData.fen || undefined);
        try {
            if (chess.move(move)) {
                room.gameData.fen = chess.fen();
                io.to(roomCode).emit('chess_state', room.gameData.fen);
            }
        } catch (e) {}
    });

    // TIC TAC TOE
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if (!room || room.gameType !== 'tictactoe') return;
        const { board, turn, size } = room.gameData;

        if (board[index] === null) {
            board[index] = turn;
            io.to(roomCode).emit('ttt_update', { board });
            const winner = checkTTTWin(board, size);
            if (winner) {
                const msg = winner === 'DRAW' ? "It's a Draw!" : `${winner} Wins!`;
                io.to(roomCode).emit('system_message', msg);
                setTimeout(() => {
                    room.gameData.board = Array(size * size).fill(null);
                    room.gameData.turn = 'X';
                    io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
                    io.to(roomCode).emit('system_message', `New Game Started!`);
                }, 3000);
            } else {
                room.gameData.turn = turn === 'X' ? 'O' : 'X';
            }
        }
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const userIndex = room.users.findIndex(u => u.id === socket.id);
            if (userIndex !== -1) {
                const leavingUser = room.users[userIndex];
                const wasAdmin = room.adminId === socket.id;
                
                room.users.splice(userIndex, 1);
                io.to(code).emit('system_message', `${leavingUser.username} left.`);

                if (room.users.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasAdmin) assignNextAdmin(code);
                    io.to(code).emit('update_room', getRoomPublicData(room));
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
