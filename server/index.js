const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Safe Chess Import
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) {
    console.error("⚠️ Chess.js error. Run: npm install chess.js");
}

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// Word lists by complexity
const WORDS = {
    easy: ["sun", "cat", "dog", "cup", "hat", "car", "bus", "tree", "book", "key"],
    medium: ["planet", "guitar", "jungle", "doctor", "police", "turtle", "robot", "circus"],
    hard: ["electricity", "philosophy", "orchestra", "cathedral", "hemisphere", "kaleidoscope"]
};

// --- HELPER FUNCTIONS ---

function getRoomPublicData(room) {
    return {
        roomName: room.name,
        users: room.users,
        adminId: room.adminId,
        gameType: room.gameType,
        state: room.state,
        settings: room.settings,
        drawerId: room.gameData?.currentDrawerId || null,
        roundInfo: room.gameData ? { 
            round: room.gameData.currentRound, 
            total: room.settings.rounds,
            turn: room.gameData.drawerIndex + 1
        } : null,
        gameData: room.gameType === 'tictactoe' ? room.gameData : undefined // Send TTT board
    };
}

function getRandomWords(complexity = 'easy', count = 3) {
    const list = WORDS[complexity] || WORDS['easy'];
    return list.sort(() => 0.5 - Math.random()).slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id;
        io.to(roomCode).emit('update_room', getRoomPublicData(room));
        io.to(roomCode).emit('system_message', { text: `👑 ${room.users[0].username} is now the Admin.`, type: 'sys' });
    }
}

// --- GAME LOOPS ---

// 1. Selection Phase (30s to pick word)
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if Game Over
    if (room.gameData.currentRound > parseInt(room.settings.rounds)) {
        endScribbleGame(roomCode);
        return;
    }

    const drawer = room.users[room.gameData.drawerIndex];
    room.gameData.currentDrawerId = drawer.id;
    room.state = "SELECTING_WORD";
    
    // Reset Round Data
    room.gameData.drawHistory = [];
    room.gameData.guessedUsers = [];
    room.gameData.currentWord = null;
    
    // Notify Room
    io.to(roomCode).emit('update_room', getRoomPublicData(room));
    io.to(roomCode).emit('clear_canvas');
    io.to(roomCode).emit('scribble_state_change', { 
        state: 'SELECTING', 
        drawer: drawer.username,
        drawerId: drawer.id
    });

    // Send Words to Drawer
    const words = getRandomWords(room.settings.complexity);
    io.to(drawer.id).emit('scribble_your_turn_pick', { words, time: 30 });

    // Auto-pick timer (30s)
    let selectionTime = 30;
    clearInterval(room.gameData.timer);
    room.gameData.timer = setInterval(() => {
        selectionTime--;
        // Emit specific timer for selection if needed, or re-use general timer event
        io.to(roomCode).emit('timer_update', selectionTime);

        if (selectionTime <= 0) {
            clearInterval(room.gameData.timer);
            // Auto pick first word
            handleWordSelection(roomCode, words[0]);
        }
    }, 1000);
}

// 2. Drawing Phase
function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode];
    if (!room) return;

    clearInterval(room.gameData.timer); // Clear selection timer

    room.gameData.currentWord = word;
    room.gameData.maskedWord = word.replace(/[a-zA-Z]/g, '_'); // No spaces for cleaner look, or '_ '
    room.state = "PLAYING";

    const drawTime = parseInt(room.settings.time) || 60;
    
    io.to(roomCode).emit('scribble_state_change', {
        state: 'DRAWING',
        drawerId: room.gameData.currentDrawerId,
        maskedWord: room.gameData.maskedWord,
        wordLength: word.length,
        time: drawTime
    });

    // Start Draw Timer
    let timeLeft = drawTime;
    io.to(roomCode).emit('timer_update', timeLeft);

    room.gameData.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timer_update', timeLeft);

        // --- HINT LOGIC ---
        // Reveal at 75%, 50%, 25% time remaining if word is long enough
        if ((timeLeft === Math.floor(drawTime * 0.5) || timeLeft === Math.floor(drawTime * 0.25))) {
             revealHint(room);
             io.to(roomCode).emit('update_mask', room.gameData.maskedWord);
             io.to(roomCode).emit('system_message', { text: "💡 A hint has been revealed!", type: 'sys' });
        }

        if (timeLeft <= 0) {
            endScribbleTurn(roomCode, "Time's Up!");
        }
    }, 1000);
}

function revealHint(room) {
    const word = room.gameData.currentWord;
    let mask = room.gameData.maskedWord.split('');
    const indices = [];
    
    // Find hidden indices
    for(let i=0; i<mask.length; i++) {
        if(mask[i] === '_') indices.push(i);
    }
    
    if (indices.length > 0) {
        const idx = indices[Math.floor(Math.random() * indices.length)];
        mask[idx] = word[idx];
        room.gameData.maskedWord = mask.join('');
    }
}

// 3. Turn End (Intermission)
function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.gameData.timer);

    // Show answer and scores
    io.to(roomCode).emit('scribble_turn_end', {
        word: room.gameData.currentWord,
        reason: reason,
        scores: room.users.map(u => ({ username: u.username, score: u.score, avatar: u.avatar }))
    });

    // Wait 10 seconds then start next turn
    let intermission = 10;
    room.state = "INTERMISSION";
    
    const intTimer = setInterval(() => {
        intermission--;
        // Optional: emit intermission countdown if ui wants it
        if (intermission <= 0) {
            clearInterval(intTimer);
            
            // Advance Logic
            room.gameData.drawerIndex++;
            if (room.gameData.drawerIndex >= room.users.length) {
                room.gameData.drawerIndex = 0;
                room.gameData.currentRound++;
            }
            
            startScribbleTurn(roomCode);
        }
    }, 1000);
}

function endScribbleGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    const leaderboard = room.users.sort((a,b) => b.score - a.score);
    io.to(roomCode).emit('game_over', { leaderboard });
    room.state = "LOBBY";
    io.to(roomCode).emit('update_room', getRoomPublicData(room));
}


io.on('connection', (socket) => {
    
    // --- CREATE ROOM ---
    socket.on('create_room', ({ username, avatar, settings, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        let initialGameData = {};
        if (gameType === 'scribble') {
            initialGameData = { currentRound: 1, drawerIndex: 0, currentDrawerId: null, drawHistory: [], guessedUsers: [] };
        } else if (gameType === 'chess') {
            if(Chess) initialGameData = { fen: new Chess().fen() };
        } else if (gameType === 'tictactoe') {
            const s = parseInt(settings.tttGrid) || 3;
            initialGameData = { board: Array(s*s).fill(null), turn: 'X', size: s };
        }

        rooms[roomCode] = {
            name: "Game Room",
            adminId: socket.id,
            users: [],
            gameType: gameType,
            settings: settings,
            gameData: initialGameData,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    // --- JOIN ROOM ---
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }

        const user = { id: socket.id, username, avatar, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        io.to(roomCode).emit('update_room', getRoomPublicData(room));
        io.to(roomCode).emit('system_message', { text: `${username} joined!`, type: 'sys' });

        // Auto-sync game state
        if (room.gameType === 'chess') socket.emit('chess_state', room.gameData.fen);
        if (room.gameType === 'tictactoe') {
            socket.emit('ttt_init', room.gameData.size);
            socket.emit('ttt_update', { board: room.gameData.board });
        }
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            // Send history to new joiner
            socket.emit('canvas_history', room.gameData.drawHistory);
            socket.emit('scribble_state_change', { 
                state: 'DRAWING', 
                drawerId: room.gameData.currentDrawerId,
                maskedWord: room.gameData.maskedWord 
            });
        }
    });

    // --- SCRIBBLE EVENTS ---
    socket.on('start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            if(room.gameType === 'scribble') {
                room.gameData.currentRound = 1;
                room.gameData.drawerIndex = 0;
                room.users.forEach(u => u.score = 0);
                startScribbleTurn(roomCode);
            }
        }
    });

    socket.on('word_selected', ({ roomCode, word }) => {
        handleWordSelection(roomCode, word);
    });

    // Drawing: Save Normalized Coordinates (0-1) to allow resizing
    socket.on('draw_data', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        
        if (data.type === 'start') {
            room.gameData.currentStroke = { color: data.color, points: [{x: data.x, y: data.y}], size: data.size };
        } else if (data.type === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({x: data.x, y: data.y});
        } else if (data.type === 'end' && room.gameData.currentStroke) {
            room.gameData.drawHistory.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }
        socket.to(data.roomCode).emit('draw_data', data);
    });

    socket.on('undo_draw', ({roomCode}) => {
        const room = rooms[roomCode];
        if(room && room.gameData.drawHistory.length > 0) {
            room.gameData.drawHistory.pop();
            io.to(roomCode).emit('canvas_history', room.gameData.drawHistory);
        }
    });

    socket.on('clear_draw', ({roomCode}) => {
        const room = rooms[roomCode];
        if(room) {
            room.gameData.drawHistory = [];
            io.to(roomCode).emit('clear_canvas');
        }
    });

    // Chat / Guessing
    socket.on('chat_msg', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user) return;

        // Scribble Logic
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            if (room.gameData.currentWord && msg.trim().toLowerCase() === room.gameData.currentWord.toLowerCase()) {
                if (socket.id !== room.gameData.currentDrawerId && !room.gameData.guessedUsers.includes(socket.id)) {
                    // Correct Guess
                    const points = 100 - (room.gameData.guessedUsers.length * 10); // Simple scoring
                    user.score += Math.max(points, 10);
                    room.gameData.guessedUsers.push(socket.id);
                    
                    // Drawer gets points too
                    const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                    if (drawer) drawer.score += 20;

                    io.to(roomCode).emit('system_message', { text: `🎉 ${user.username} guessed the word!`, type: 'correct' });
                    io.to(roomCode).emit('update_room', getRoomPublicData(room));

                    // If everyone guessed
                    if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                        endScribbleTurn(roomCode, "Everyone Guessed!");
                    }
                    return; // Don't show the word in chat
                }
            }
        }

        io.to(roomCode).emit('chat_msg', { username: user.username, avatar: user.avatar, text: msg });
    });

    // --- CHESS ---
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(room) {
             const chess = new Chess(room.gameData.fen);
             if(chess.move(move)) {
                 room.gameData.fen = chess.fen();
                 io.to(roomCode).emit('chess_state', room.gameData.fen);
             }
        }
    });

    // --- TTT ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room) return;
        if(room.gameData.board[index] === null) {
            room.gameData.board[index] = room.gameData.turn;
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
            
            // Simple check win logic omitted for brevity, add if needed or trust clients to sync
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
        }
    });

    socket.on('disconnect', () => {
        for(const code in rooms) {
            const room = rooms[code];
            const idx = room.users.findIndex(u => u.id === socket.id);
            if(idx !== -1) {
                const u = room.users[idx];
                room.users.splice(idx, 1);
                io.to(code).emit('system_message', { text: `${u.username} left.`, type: 'sys' });
                
                if(room.users.length === 0) delete rooms[code];
                else {
                    if(room.adminId === socket.id) assignNextAdmin(code);
                    io.to(code).emit('update_room', getRoomPublicData(room));
                }
            }
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
