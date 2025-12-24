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
    return wordList.sort(() => 0.5 - Math.random()).slice(0, count);
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
            current: room.gameData.round, 
            total: room.settings.rounds 
        },
        // Chess/TTT data
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
        startScribbleTurn(roomCode); // Recursively start next round
        return;
    }

    const drawer = room.users[room.gameData.drawerIdx];
    room.gameData.drawerId = drawer.id;
    room.gameData.word = null;
    room.gameData.guessed = [];
    room.gameData.history = []; // Clear canvas history
    room.gameData.redoStack = []; 
    
    // 3. Notify All -> Clear Canvas
    io.to(roomCode).emit('clear_canvas'); 
    io.to(roomCode).emit('scribble_state', { 
        state: "SELECTING", 
        drawerId: drawer.id, 
        drawerName: drawer.username 
    });

    // 4. Send Words to Drawer
    const options = getRandomWords(3);
    io.to(drawer.id).emit('pick_word', { words: options });

    // 5. Auto-select timeout (15s)
    let pickTime = 15;
    clearInterval(room.gameData.timer);
    room.gameData.timer = setInterval(() => {
        pickTime--;
        if(pickTime <= 0) {
            handleWordSelection(roomCode, options[0]); // Auto pick
        }
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timer);
    
    room.gameData.word = word;
    room.state = "DRAWING";
    
    // Mask word (e.g., "Apple" -> "_ _ _ _ _")
    const masked = word.replace(/[a-zA-Z]/g, '_');
    
    io.to(roomCode).emit('scribble_state', {
        state: "DRAWING",
        drawerId: room.gameData.drawerId,
        maskedWord: masked,
        time: room.settings.time
    });

    // Send secret word ONLY to drawer
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); // Play start sound

    // Game Timer
    let time = room.settings.time;
    room.gameData.timer = setInterval(() => {
        time--;
        io.to(roomCode).emit('timer_tick', time);
        
        // Hint Logic (Reveal 1 letter at 50% time)
        if(time === Math.floor(room.settings.time / 2)) {
            const indices = [];
            for(let i=0; i<word.length; i++) indices.push(i);
            const revealIdx = indices[Math.floor(Math.random()*indices.length)];
            const currentMask = masked.split('');
            currentMask[revealIdx] = word[revealIdx]; 
            // We don't update the mask global variable to keep it simple, 
            // but we send a hint event
            io.to(roomCode).emit('sys_msg', `💡 HINT: The word starts with ${word[0]}`);
        }

        if(time <= 0) {
            endTurn(roomCode, "Time's up!");
        }
    }, 1000);
}

function endTurn(roomCode, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timer);
    
    io.to(roomCode).emit('scribble_end_turn', {
        word: room.gameData.word,
        reason: reason,
        scores: room.users
    });

    // 5 Second cooldown before next turn
    setTimeout(() => {
        room.gameData.drawerIdx++;
        startScribbleTurn(roomCode);
    }, 5000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('create_room', ({ username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Parse settings securely
        const rSettings = {
            rounds: parseInt(settings?.rounds) || 3,
            time: parseInt(settings?.time) || 60,
            grid: parseInt(settings?.grid) || 3
        };

        let gd = {};
        if(gameType === 'scribble') {
            gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], redoStack: [], guessed: [] };
        } else if (gameType === 'tictactoe') {
            gd = { board: Array(9).fill(null), turn: 'X' };
        } else if (gameType === 'chess' && Chess) {
            gd = { fen: new Chess().fen() };
        }

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

        const user = { id: socket.id, username, avatar, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        // Notify
        io.to(roomCode).emit('update_room', getRoomState(room));
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
        socket.emit('sfx', 'join');

        // Sync State for Late Joiners
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            socket.emit('canvas_history', room.gameData.history);
            socket.emit('scribble_state', {
                state: "DRAWING",
                drawerId: room.gameData.drawerId,
                maskedWord: room.gameData.word.replace(/[a-zA-Z]/g, '_'),
                time: room.settings.time
            });
        }
    });

    socket.on('start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(room.gameType === 'scribble') {
                room.gameData.round = 1;
                room.gameData.drawerIdx = 0;
                room.users.forEach(u => u.score = 0); // Reset scores
                startScribbleTurn(roomCode);
            }
        }
    });

    // --- CHAT & GUESSING ---
    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode];
        if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Logic: Is this a correct guess?
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            if(text.trim().toLowerCase() === room.gameData.word.toLowerCase()) {
                // Correct Guess
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id);
                    user.score += 100;
                    
                    // Drawer gets points too
                    const drawer = room.users.find(u => u.id === room.gameData.drawerId);
                    if(drawer) drawer.score += 20;

                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed the word!`);
                    io.to(roomCode).emit('sfx', 'success');
                    io.to(roomCode).emit('update_room', getRoomState(room)); // Update scores

                    // If everyone guessed
                    const guessers = room.gameData.guessed.length;
                    const totalGuessers = room.users.length - 1; // excluding drawer
                    if(guessers >= totalGuessers) {
                        endTurn(roomCode, "Everyone guessed it!");
                    }
                }
                return; // Don't show the word in chat
            }
        }

        // Normal Chat Broadcast
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
    });

    // --- DRAWING ENGINE ---
    socket.on('draw_op', (data) => {
        const room = rooms[data.roomCode];
        if(!room) return;

        // Store history for undo/late joiners
        if(data.op === 'start') {
            room.gameData.redoStack = []; // New action clears redo
            room.gameData.currentStroke = { 
                color: data.color, 
                width: data.width, 
                points: [{x:data.x, y:data.y}] 
            };
        } else if (data.op === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({x:data.x, y:data.y});
        } else if (data.op === 'end' && room.gameData.currentStroke) {
            room.gameData.history.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }

        // Broadcast to everyone (including sender for smoother sync or sender handles locally? 
        // Usually sender handles locally, broadcast to others)
        socket.to(data.roomCode).emit('draw_op', data);
    });

    socket.on('undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.history.length > 0) {
            const last = room.gameData.history.pop();
            room.gameData.redoStack.push(last);
            io.to(roomCode).emit('canvas_history', room.gameData.history);
        }
    });

    socket.on('redo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.redoStack.length > 0) {
            const stroke = room.gameData.redoStack.pop();
            room.gameData.history.push(stroke);
            io.to(roomCode).emit('canvas_history', room.gameData.history);
        }
    });

    socket.on('clear', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room) {
            room.gameData.history = [];
            room.gameData.redoStack = [];
            io.to(roomCode).emit('clear_canvas');
        }
    });

    socket.on('word_select', ({ roomCode, word }) => handleWordSelection(roomCode, word));
    socket.on('send_reaction', (d) => io.to(d.roomCode).emit('show_reaction', d));

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        // Cleanup logic...
        for(const code in rooms) {
            const r = rooms[code];
            const idx = r.users.findIndex(u => u.id === socket.id);
            if(idx !== -1) {
                r.users.splice(idx, 1);
                io.to(code).emit('sys_msg', "A player left.");
                
                if(r.users.length === 0) delete rooms[code];
                else {
                    if(r.adminId === socket.id) {
                        r.adminId = r.users[0].id; // New Admin
                        io.to(code).emit('sys_msg', `${r.users[0].username} is now Admin.`);
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
