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
function getRandomWords(count, customWords = []) {
    const pool = customWords.length > 0 ? customWords : wordList;
    return pool.sort(() => 0.5 - Math.random()).slice(0, count);
}

function getEditDistance(a, b) {
    if(a.length === 0) return b.length; 
    if(b.length === 0) return a.length; 
    var matrix = [];
    for(var i = 0; i <= b.length; i++){ matrix[i] = [i]; }
    for(var j = 0; j <= a.length; j++){ matrix[0][j] = j; }
    for(var i = 1; i <= b.length; i++){
        for(var j = 1; j <= a.length; j++){
            if(b.charAt(i-1) == a.charAt(j-1)){
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, Math.min(matrix[i][j-1] + 1, matrix[i-1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function getRoomState(room) {
    return {
        roomName: room.name,
        users: room.users,
        adminId: room.adminId,
        gameType: room.gameType,
        state: room.state,
        settings: room.settings,
        drawerId: room.gameData.drawerId, // Scribble specific
        
        // Unified Round Info
        roundInfo: { 
            current: room.gameData.round, 
            total: room.settings.rounds 
        },
        
        // Game Specific Data
        gameData: {
            fen: room.gameData.fen,         // Chess
            turn: room.gameData.turn,       // Chess/TTT
            board: room.gameData.board,     // TTT
            timers: room.gameData.timers,   // Chess
            players: room.gameData.players  // Chess (Who is White/Black)
        }
    };
}

// --- CHESS LOGIC ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;

    room.state = "PLAYING";
    
    // Assign Players (Admin is White by default, can be swapped in settings)
    const p1 = room.users[0];
    const p2 = room.users[1]; // Or Bot

    // Initial Chess State
    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w'; // White starts
    room.gameData.history = [];
    
    // Set Timers (Minutes -> Seconds)
    const timeLimit = room.settings.time || 600; 
    room.gameData.timers = { w: timeLimit, b: timeLimit };

    // Set Colors
    if(room.settings.botMode) {
        room.gameData.players = { w: p1.id, b: 'BOT' };
    } else {
        if(room.settings.invertColors) {
            room.gameData.players = { w: p2?.id, b: p1.id };
        } else {
            room.gameData.players = { w: p1.id, b: p2?.id };
        }
    }

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sfx', 'start');
    startChessTimer(roomCode);
}

function startChessTimer(roomCode) {
    const room = rooms[roomCode];
    if(!room) return;
    
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; // 'w' or 'b'
        room.gameData.timers[turn]--;

        // Sync Timer to Client
        io.to(roomCode).emit('chess_timer_update', room.gameData.timers);

        if(room.gameData.timers[turn] <= 0) {
            clearInterval(room.gameData.timerInterval);
            const winnerColor = turn === 'w' ? 'b' : 'w';
            endChessGame(roomCode, winnerColor, "Timeout");
        }
    }, 1000);
}

function endChessGame(roomCode, winnerColor, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timerInterval);
    room.state = "GAME_OVER";
    
    let winnerName = "Bot";
    if(winnerColor === 'draw') winnerName = "Draw";
    else {
        const winnerId = room.gameData.players[winnerColor];
        if(winnerId !== 'BOT') {
            const u = room.users.find(u => u.id === winnerId);
            if(u) {
                u.score += 10; // Win points
                winnerName = u.username;
            }
        }
    }

    io.to(roomCode).emit('game_over_alert', { 
        title: reason === "Checkmate" ? "CHECKMATE!" : "GAME OVER",
        msg: winnerColor === 'draw' ? "Game Drawn!" : `${winnerName} Wins! (${reason})`,
        winner: winnerName
    });
    
    io.to(roomCode).emit('update_room', getRoomState(room));
}

// --- TIC TAC TOE LOGIC ---
function checkTTTWin(board, size) {
    const s = parseInt(size);
    const lines = [];
    
    // Rows & Cols
    for(let i=0; i<s; i++) {
        const row = [], col = [];
        for(let j=0; j<s; j++) {
            row.push(board[i*s + j]);
            col.push(board[j*s + i]);
        }
        lines.push(row, col);
    }
    // Diagonals
    const d1 = [], d2 = [];
    for(let i=0; i<s; i++) {
        d1.push(board[i*s + i]);
        d2.push(board[i*s + (s-1-i)]);
    }
    lines.push(d1, d2);

    for(let line of lines) {
        if(line[0] && line.every(v => v === line[0])) return line[0];
    }
    if(board.every(c => c)) return 'draw';
    return null;
}

// --- SCRIBBL LOGIC (UNCHANGED) ---
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over', room.users.sort((a,b)=>b.score-a.score));
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
        return;
    }

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
    
    io.to(roomCode).emit('clear_canvas'); 
    room.state = "SELECTING";
    io.to(roomCode).emit('scribble_state', { 
        state: "SELECTING", 
        drawerId: drawer.id, 
        drawerName: drawer.username,
        drawerAvatar: drawer.avatar,
        round: room.gameData.round,
        totalRounds: room.settings.rounds
    });

    const options = getRandomWords(3, room.settings.customWords || []);
    io.to(drawer.id).emit('pick_word', { words: options });

    let pickTime = 30;
    clearInterval(room.gameData.timer);
    io.to(roomCode).emit('pick_timer', pickTime);

    room.gameData.timer = setInterval(() => {
        pickTime--;
        io.to(roomCode).emit('pick_timer', pickTime);
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]); 
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
        
        if(time === Math.floor(room.settings.time / 2) || time === 10) {
             io.to(roomCode).emit('sys_msg', `💡 HINT: Word starts with '${word[0]}'`);
        }

        if(time <= 0) {
            io.to(roomCode).emit('sfx', 'timeover');
            endTurn(roomCode, "Time's up!");
        }
    }, 1000);
}

function endTurn(roomCode, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timer);
    
    const lb = room.users.map(u => ({
        username: u.username,
        avatar: u.avatar,
        score: u.score,
        guessed: room.gameData.guessed.includes(u.id) || u.id === room.gameData.drawerId
    })).sort((a,b) => b.score - a.score);

    io.to(roomCode).emit('scribble_end_turn', {
        word: room.gameData.word,
        reason: reason,
        leaderboard: lb
    });

    setTimeout(() => {
        room.gameData.drawerIdx++;
        startScribbleTurn(roomCode);
    }, 5000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('create_room', ({ username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const rSettings = { rounds: 3, time: 60, customWords: [], botMode: false, invertColors: false, gridSize: 3 };

        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], redoStack: [], guessed: [] };
        else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X', round: 1 };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen(), round: 1, turn: 'w', timers: {w:600, b:600}, players: {} };

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
            const av = avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`;
            room.users.push({ id: socket.id, username, avatar: av, score: 0 });
            socket.join(roomCode);
        }

        io.to(roomCode).emit('update_room', getRoomState(room));
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
        socket.emit('sfx', 'join');
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            // Apply Settings
            if(settings) {
                room.settings = { ...room.settings, ...settings };
                // Type safety
                room.settings.rounds = parseInt(settings.rounds);
                room.settings.time = parseInt(settings.time);
                room.settings.gridSize = parseInt(settings.gridSize);
            }

            if(room.gameType === 'scribble') {
                room.gameData.round = 1;
                room.gameData.drawerIdx = 0;
                room.users.forEach(u => u.score = 0); 
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') {
                // If Bot mode, ensure only admin is playing
                if(room.settings.botMode) {
                     // Logic handled in startChessGame
                }
                startChessGame(roomCode);
            } else if (room.gameType === 'tictactoe') {
                room.state = "PLAYING";
                // Reset Grid
                const s = room.settings.gridSize || 3;
                room.gameData.board = Array(s*s).fill(null);
                room.gameData.turn = 'X';
                io.to(roomCode).emit('update_room', getRoomState(room));
            }
        }
    });

    // --- CHESS EVENTS ---
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'chess' || room.state !== 'PLAYING') return;
        
        // Check if it's correct player's turn
        const turnColor = room.gameData.turn; // 'w' or 'b'
        const authorizedId = room.gameData.players[turnColor];
        
        if(socket.id !== authorizedId && authorizedId !== 'BOT') return; // Not your turn

        const chess = new Chess(room.gameData.fen);
        try {
            const result = chess.move(move); 
            if(result) {
                room.gameData.fen = chess.fen();
                room.gameData.turn = chess.turn(); // switch turn
                
                // Broadcast Move
                io.to(roomCode).emit('chess_move_update', { 
                    fen: room.gameData.fen, 
                    move: result 
                });
                io.to(roomCode).emit('sfx', 'pop');

                // Check Game Over
                if(chess.isGameOver()) {
                    let reason = "";
                    let winner = 'draw';
                    if(chess.isCheckmate()) {
                        reason = "Checkmate";
                        winner = turnColor; // The one who made the move won
                    } else if(chess.isDraw()) reason = "Draw";
                    
                    endChessGame(roomCode, winner, reason);
                } else {
                    startChessTimer(roomCode); // Restart timer for next player
                }
            }
        } catch(e) {}
    });

    // --- TTT EVENTS ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'tictactoe' || room.state !== 'PLAYING') return;

        // Player check: Admin is X, P2 is O
        const isX = room.users[0].id === socket.id;
        const isO = room.users[1]?.id === socket.id;
        
        if(room.gameData.turn === 'X' && !isX) return;
        if(room.gameData.turn === 'O' && !isO) return;
        if(room.gameData.board[index] !== null) return;

        // Make Move
        room.gameData.board[index] = room.gameData.turn;
        io.to(roomCode).emit('ttt_update', { 
            board: room.gameData.board, 
            index, 
            sym: room.gameData.turn 
        });
        io.to(roomCode).emit('sfx', 'pop');

        // Check Win
        const win = checkTTTWin(room.gameData.board, room.settings.gridSize);
        if(win) {
            let winnerName = "Draw";
            if(win !== 'draw') {
                const u = win === 'X' ? room.users[0] : room.users[1];
                if(u) {
                    u.score += 1; // Round win
                    winnerName = u.username;
                }
            }
            io.to(roomCode).emit('game_over_alert', { 
                title: "ROUND OVER", 
                msg: win === 'draw' ? "It's a Draw!" : `${winnerName} Wins!`,
                winner: winnerName
            });
            io.to(roomCode).emit('update_room', getRoomState(room)); // Leaderboard update
            
            // Auto restart TTT round?
            setTimeout(() => {
                const s = room.settings.gridSize || 3;
                room.gameData.board = Array(s*s).fill(null);
                room.gameData.turn = 'X';
                io.to(roomCode).emit('update_room', getRoomState(room));
            }, 3000);
        } else {
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
        }
    });

    // --- SHARED EVENTS ---
    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode];
        if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // CHESS RESTRICTION: Active players can't chat
        if(room.gameType === 'chess' && room.state === 'PLAYING') {
            const isPlayer = Object.values(room.gameData.players).includes(socket.id);
            if(isPlayer) return; // Silent reject
        }

        // SCRIBBLE GUESS LOGIC (Preserved)
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            const guess = text.trim().toLowerCase();
            const actual = room.gameData.word.toLowerCase();
            if(guess === actual) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id);
                    user.score += 100;
                    const drawer = room.users.find(u => u.id === room.gameData.drawerId);
                    if(drawer) drawer.score += 20;
                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed it!`);
                    io.to(roomCode).emit('sfx', 'success');
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    if(room.gameData.guessed.length >= room.users.length - 1) endTurn(roomCode, "Everyone guessed!");
                }
                return; 
            }
            if(actual.length > 2 && getEditDistance(guess, actual) <= 2) {
                socket.emit('sys_msg_close', `🔥 '${text}' is very close!`);
                return;
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
        io.to(roomCode).emit('sfx', 'msg');
    });

    socket.on('draw_op', (data) => {
        const room = rooms[data.roomCode];
        if(room) {
            if(data.op === 'start') { room.gameData.redoStack = []; room.gameData.currentStroke = { color: data.color, width: data.width, points: [{x:data.x, y:data.y}] }; } 
            else if (data.op === 'move' && room.gameData.currentStroke) room.gameData.currentStroke.points.push({x:data.x, y:data.y}); 
            else if (data.op === 'end' && room.gameData.currentStroke) { room.gameData.history.push(room.gameData.currentStroke); room.gameData.currentStroke = null; }
            socket.to(data.roomCode).emit('draw_op', data);
        }
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
        if(room) { room.gameData.history = []; room.gameData.redoStack = []; io.to(roomCode).emit('clear_canvas'); }
    });

    socket.on('word_select', ({ roomCode, word }) => handleWordSelection(roomCode, word));
    socket.on('send_reaction', (d) => io.to(d.roomCode).emit('show_reaction', d));

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
