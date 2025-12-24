const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- SAFE IMPORTS ---
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js not found. Chess mode will fail."); }

const defaultWords = [
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

// Levenshtein distance for "Close Guess"
function getEditDistance(a, b) {
    if(a.length === 0) return b.length; 
    if(b.length === 0) return a.length; 
    var matrix = [];
    var i;
    for(i = 0; i <= b.length; i++){ matrix[i] = [i]; }
    var j;
    for(j = 0; j <= a.length; j++){ matrix[0][j] = j; }
    for(i = 1; i <= b.length; i++){
        for(j = 1; j <= a.length; j++){
            if(b.charAt(i-1) == a.charAt(j-1)){
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, Math.min(matrix[i][j-1] + 1, matrix[i-1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function getRandomWords(count, customWords = []) {
    const pool = [...defaultWords, ...customWords];
    return pool.sort(() => 0.5 - Math.random()).slice(0, count);
}

function getRoomState(room) {
    return {
        roomName: room.name,
        users: room.users,
        adminId: room.adminId,
        gameType: room.gameType,
        state: room.state,
        settings: room.settings,
        drawerId: room.gameData.drawerId,
        roundInfo: { 
            current: room.gameData.round || 1, 
            total: room.settings.rounds 
        },
        boardData: room.gameType === 'tictactoe' ? room.gameData.board : 
                   (room.gameType === 'chess' ? room.gameData.fen : null)
    };
}

// --- SCRIBBL LOGIC ---
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // 1. Check Limits
    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over', room.users.sort((a,b)=>b.score-a.score));
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
        return;
    }

    // 2. Next Drawer
    if (room.gameData.drawerIdx >= room.users.length) {
        room.gameData.drawerIdx = 0;
        room.gameData.round++;
        startScribbleTurn(roomCode); 
        return;
    }

    const drawer = room.users[room.gameData.drawerIdx];
    room.gameData.drawerId = drawer.id;
    room.gameData.word = null;
    room.gameData.guessed = [];
    room.gameData.history = []; 
    room.gameData.redoStack = []; 
    
    // 3. Picking Phase
    io.to(roomCode).emit('clear_canvas'); 
    room.state = "SELECTING";
    
    io.to(roomCode).emit('scribble_state', { 
        state: "SELECTING", 
        drawerId: drawer.id, 
        drawerName: drawer.username,
        round: room.gameData.round,
        totalRounds: room.settings.rounds
    });

    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });

    // 30s Timer for Picking
    let pickTime = 30;
    clearInterval(room.gameData.timer);
    
    // Emit initial time
    io.to(roomCode).emit('pick_timer', pickTime);

    room.gameData.timer = setInterval(() => {
        pickTime--;
        io.to(roomCode).emit('pick_timer', pickTime);
        if(pickTime <= 0) {
            // Auto pick random
            handleWordSelection(roomCode, options[0]); 
        }
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode];
    if(!room) return;
    clearInterval(room.gameData.timer);
    
    room.gameData.word = word;
    room.state = "DRAWING";
    
    const masked = word.replace(/[a-zA-Z]/g, '_');
    
    io.to(roomCode).emit('scribble_state', {
        state: "DRAWING",
        drawerId: room.gameData.drawerId,
        maskedWord: masked,
        time: room.settings.time,
        round: room.gameData.round,
        totalRounds: room.settings.rounds
    });

    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start');

    let time = room.settings.time;
    room.gameData.timer = setInterval(() => {
        time--;
        io.to(roomCode).emit('timer_tick', time);
        
        // Hint Logic (Reveal 1 char at 50%)
        if(time === Math.floor(room.settings.time / 2)) {
            io.to(roomCode).emit('sys_msg', `💡 HINT: The word starts with ${word[0]}`);
        }

        if(time <= 0) {
            endTurn(roomCode, "Time's up!");
        }
    }, 1000);
}

function endTurn(roomCode, reason) {
    const room = rooms[roomCode];
    if(!room) return;
    clearInterval(room.gameData.timer);
    
    // Sort scores for this round view
    const leaderboard = room.users.map(u => ({
        username: u.username,
        avatar: u.avatar,
        score: u.score,
        isCorrect: room.gameData.guessed.includes(u.id) || u.id === room.gameData.drawerId
    })).sort((a,b) => b.score - a.score);

    io.to(roomCode).emit('scribble_end_turn', {
        word: room.gameData.word,
        reason: reason,
        leaderboard: leaderboard
    });

    setTimeout(() => {
        room.gameData.drawerIdx++;
        startScribbleTurn(roomCode);
    }, 5000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Defaults
        const rSettings = {
            rounds: 3,
            time: 60,
            customWords: []
        };

        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], redoStack: [], guessed: [] };
        else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X' };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen() };

        rooms[roomCode] = {
            name: `${username}'s Room`,
            adminId: socket.id,
            users: [],
            gameType,
            settings: rSettings,
            gameData: gd,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if(!room) return socket.emit('error', "Room not found");
        
        if(room.users.length >= 10) return socket.emit('error', "Room is full (Max 10)");

        const existing = room.users.find(u => u.id === socket.id);
        if(!existing) {
            room.users.push({ id: socket.id, username, avatar, score: 0 });
            socket.join(roomCode);
        }

        io.to(roomCode).emit('update_room', getRoomState(room));
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
        socket.emit('sfx', 'join');
    });

    // ADMIN UPDATES SETTINGS AND STARTS
    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            
            // Apply Admin Settings
            if(settings) {
                room.settings.rounds = parseInt(settings.rounds) || 3;
                room.settings.time = parseInt(settings.time) || 60;
                if(settings.customWords) room.settings.customWords = settings.customWords;
            }

            if(room.gameType === 'scribble') {
                room.gameData.round = 1;
                room.gameData.drawerIdx = 0;
                room.users.forEach(u => u.score = 0); 
                startScribbleTurn(roomCode);
            } else {
                room.state = "PLAYING";
                io.to(roomCode).emit('update_room', getRoomState(room));
                io.to(roomCode).emit('sys_msg', "Game Started!");
            }
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode];
        if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Scribble Logic
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            const word = room.gameData.word.toLowerCase();
            const guess = text.trim().toLowerCase();

            if(guess === word) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id);
                    user.score += 100;
                    
                    const drawer = room.users.find(u => u.id === room.gameData.drawerId);
                    if(drawer) drawer.score += 20;

                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed the word!`);
                    io.to(roomCode).emit('sfx', 'success');
                    io.to(roomCode).emit('update_room', getRoomState(room));

                    if(room.gameData.guessed.length >= room.users.length - 1) {
                        endTurn(roomCode, "Everyone guessed it!");
                    }
                }
                return; 
            }
            
            // Close Guess Check (Levenshtein <= 2)
            const dist = getEditDistance(guess, word);
            if(dist <= 2 && dist > 0 && word.length > 3) {
                socket.emit('sys_msg', `🔥 '${text}' is very close!`);
                return; // Don't broadcast close guesses to chat to prevent spoiling
            }
        }

        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
    });

    // --- DRAWING & TOOLS ---
    socket.on('draw_op', (data) => {
        const room = rooms[data.roomCode];
        if(!room) return;
        
        if(data.op === 'start') {
            room.gameData.redoStack = [];
            room.gameData.currentStroke = { color: data.color, width: data.width, points: [{x:data.x, y:data.y}] };
        } else if (data.op === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({x:data.x, y:data.y});
        } else if (data.op === 'end' && room.gameData.currentStroke) {
            room.gameData.history.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }
        socket.to(data.roomCode).emit('draw_op', data);
    });

    socket.on('undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.history.length > 0) {
            room.gameData.redoStack.push(room.gameData.history.pop());
            io.to(roomCode).emit('canvas_history', room.gameData.history);
        }
    });

    socket.on('redo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.redoStack.length > 0) {
            room.gameData.history.push(room.gameData.redoStack.pop());
            io.to(roomCode).emit('canvas_history', room.gameData.history);
        }
    });

    socket.on('clear', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room) { room.gameData.history = []; io.to(roomCode).emit('clear_canvas'); }
    });

    socket.on('word_select', ({ roomCode, word }) => handleWordSelection(roomCode, word));
    
    // Reaction only if not drawer
    socket.on('send_reaction', (d) => {
        const room = rooms[d.roomCode];
        if(room && room.gameData.drawerId !== socket.id) {
            io.to(d.roomCode).emit('show_reaction', d);
        }
    });

    socket.on('disconnect', () => {
        for(const code in rooms) {
            const r = rooms[code];
            const idx = r.users.findIndex(u => u.id === socket.id);
            if(idx !== -1) {
                r.users.splice(idx, 1);
                io.to(code).emit('sys_msg', "A player left.");
                if(r.users.length === 0) delete rooms[code];
                else {
                    if(r.adminId === socket.id) {
                        r.adminId = r.users[0].id;
                        io.to(code).emit('update_room', getRoomState(r));
                    }
                    io.to(code).emit('update_room', getRoomState(r));
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
