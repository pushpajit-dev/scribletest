const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- SAFE IMPORTS ---
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js not found. Run: npm install chess.js"); }

// --- WORD LIST (Scribble) ---
const wordList = [
    "apple", "banana", "cherry", "dog", "cat", "elephant", "guitar", "house", "island", 
    "jungle", "kite", "lemon", "mountain", "notebook", "ocean", "penguin", "queen", 
    "robot", "sun", "tree", "umbrella", "violin", "whale", "xylophone", "yacht", "zebra",
    "airplane", "book", "car", "dragon", "egg", "flower", "ghost", "hammer", "ice", 
    "jacket", "key", "lamp", "moon", "nose", "owl", "pencil", "quilt", "rainbow", 
    "snake", "train", "unicorn", "volcano", "watch", "box", "yo-yo", "zipper",
    "pizza", "burger", "camera", "radio", "television", "laptop", "mouse", "keyboard"
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

// Levenshtein Distance for "Close Call"
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
        gameData: room.gameData
    };
}

// --- CHESS LOGIC ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;

    room.state = "PLAYING";
    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w'; 
    room.gameData.history = [];
    const t = room.settings.time || 600; 
    room.gameData.timers = { w: t, b: t };

    const p1 = room.users[0]; 
    const p2 = room.users[1]; 

    let adminColor = room.settings.startColor === 'black' ? 'b' : 'w';
    let oppColor = adminColor === 'w' ? 'b' : 'w';

    if(room.settings.botMode || !p2) {
        room.gameData.players = { [adminColor]: p1.id, [oppColor]: 'BOT' };
        room.settings.botMode = true;
    } else {
        room.gameData.players = { [adminColor]: p1.id, [oppColor]: p2.id };
    }

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sys_msg', "Chess Game Started!");
    
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; 
        room.gameData.timers[turn]--;
        io.to(roomCode).emit('timer_sync', { w: room.gameData.timers.w, b: room.gameData.timers.b, turn: turn });
        if(room.gameData.timers[turn] <= 0) endChessGame(roomCode, turn === 'w' ? 'b' : 'w', "Time Out");
    }, 1000);
}

function endChessGame(roomCode, winnerColor, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timerInterval);
    room.state = "GAME_OVER";
    
    let winnerName = "Bot";
    if(winnerColor === 'draw') winnerName = "Draw";
    else {
        const wid = room.gameData.players[winnerColor];
        const u = room.users.find(u => u.id === wid);
        if(u) { u.score += 100; winnerName = u.username; }
    }
    io.to(roomCode).emit('game_over_alert', { title: "CHECKMATE", msg: `${winnerName} Won!`, leaderboard: room.users });
    io.to(roomCode).emit('update_room', getRoomState(room));
}

// --- TTT LOGIC ---
function startTTTGame(roomCode) {
    const room = rooms[roomCode]; if(!room) return;
    room.state = "PLAYING";
    room.gameData.board = Array(9).fill(null);
    room.gameData.turn = room.settings.startSymbol || 'X';
    const p1 = room.users[0];
    const p2 = room.users[1];
    const adminSym = room.settings.startSymbol || 'X';
    const oppSym = adminSym === 'X' ? 'O' : 'X';
    room.gameData.players = { [adminSym]: p1.id, [oppSym]: p2 ? p2.id : 'BOT' };
    
    io.to(roomCode).emit('update_room', getRoomState(room));
    
    // TTT Timer
    room.gameData.moveTime = 30;
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        room.gameData.moveTime--;
        io.to(roomCode).emit('timer_sync', { total: room.gameData.moveTime, msg: `${room.gameData.turn}'s Turn` });
        if(room.gameData.moveTime <= 0) {
            room.gameData.moveTime = 30;
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
            io.to(roomCode).emit('sys_msg', "Time skip!");
            io.to(roomCode).emit('update_room', getRoomState(room));
        }
    }, 1000);
}

function checkTTTWin(board) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for(let w of wins) {
        if(board[w[0]] && board[w[0]] === board[w[1]] && board[w[0]] === board[w[2]]) return board[w[0]];
    }
    if(board.every(v => v !== null)) return 'draw';
    return null;
}

// --- SCRIBBLE LOGIC ---
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check Limits
    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', { 
            title:"FINAL STANDINGS", 
            msg:"Game Over!", 
            leaderboard:room.users.sort((a,b)=>b.score-a.score) 
        });
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
        return;
    }

    if (room.gameData.drawerIdx >= room.users.length) {
        room.gameData.drawerIdx = 0; room.gameData.round++;
        startScribbleTurn(roomCode); return;
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
        round: room.gameData.round, 
        totalRounds: room.settings.rounds 
    });
    
    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    let pickTime = 30;
    clearInterval(room.gameData.timerInterval);
    io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." }); 
    
    room.gameData.timerInterval = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." });
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]); 
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timerInterval);
    
    room.gameData.word = word; 
    room.state = "DRAWING";
    
    // Initial Mask (All Underscores)
    let masked = word.replace(/[a-zA-Z]/g, '_');
    
    io.to(roomCode).emit('scribble_state', { 
        state: "DRAWING", 
        drawerId: room.gameData.drawerId, 
        maskedWord: masked, 
        round: room.gameData.round, 
        totalRounds: room.settings.rounds 
    });
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); 
    
    let time = room.settings.time;
    io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

    // Hint Logic indices
    let hintIndices = [];
    if(word.length > 3) {
        // Reveal 2 letters over time
        while(hintIndices.length < 2) {
            let r = Math.floor(Math.random() * word.length);
            if(hintIndices.indexOf(r) === -1) hintIndices.push(r);
        }
    }

    room.gameData.timerInterval = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

        // Reveal Hints
        if(time === Math.floor(room.settings.time * 0.75) && hintIndices.length > 0) {
            let idx = hintIndices[0];
            let chars = masked.split(''); chars[idx] = word[idx]; masked = chars.join('');
            io.to(roomCode).emit('update_mask', masked);
        }
        if(time === Math.floor(room.settings.time * 0.4) && hintIndices.length > 1) {
            let idx = hintIndices[1];
            let chars = masked.split(''); chars[idx] = word[idx]; masked = chars.join('');
            io.to(roomCode).emit('update_mask', masked);
        }

        if(time <= 0) { 
            io.to(roomCode).emit('sfx', 'timeover'); 
            endScribbleTurn(roomCode, "Time's up!"); 
        }
    }, 1000);
}

function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode]; 
    clearInterval(room.gameData.timerInterval);
    
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
    }, 5000); // 5s break to show result
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        // Simulate Loading Time for UI
        setTimeout(() => {
            const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
            const rSettings = { rounds: 3, time: 60, customWords: [], botMode: false, maxScore: 10000 };
            let gd = {};
            if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], redoStack: [], guessed: [] };
            else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X' };
            else if (gameType === 'chess') gd = { fen: new Chess().fen() };
            
            rooms[roomCode] = { name: `${username}'s Room`, adminId: socket.id, users: [], gameType, settings: rSettings, gameData: gd, state: "LOBBY" };
            socket.emit('room_created', roomCode);
        }, 1500); // 1.5s delay for loading effect
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if(!room) return socket.emit('error', "Room not found");
        const existing = room.users.find(u => u.id === socket.id);
        if(!existing) {
            const av = avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`;
            room.users.push({ id: socket.id, username, avatar: av, score: 0 });
            socket.join(roomCode);
        }
        io.to(roomCode).emit('update_room', getRoomState(room));
        // Late join sync
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            socket.emit('canvas_history', room.gameData.history);
            let masked = room.gameData.word.replace(/[a-zA-Z]/g, '_'); // Simplified mask for late joiner
            socket.emit('scribble_state', { 
                state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: masked, 
                round: room.gameData.round, totalRounds: room.settings.rounds 
            });
        }
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) {
                room.settings = { ...room.settings, ...settings };
                room.settings.rounds = parseInt(settings.rounds) || 3;
                room.settings.time = parseInt(settings.time) || 60;
            }
            if(room.gameType === 'scribble') {
                room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0);
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') startChessGame(roomCode);
            else if (room.gameType === 'tictactoe') startTTTGame(roomCode);
        }
    });

    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'chess') return;
        const turnColor = room.gameData.turn;
        const authId = room.gameData.players[turnColor];
        if(socket.id !== authId && authId !== 'BOT') return;

        const c = new Chess(room.gameData.fen);
        try {
            const m = c.move(move);
            if(m) {
                room.gameData.fen = c.fen();
                room.gameData.turn = c.turn(); 
                io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: m });
                io.to(roomCode).emit('sfx', 'pop');
                if(c.isGameOver()) {
                    let w = c.isCheckmate() ? turnColor : 'draw';
                    endChessGame(roomCode, w, "Checkmate/Draw");
                }
            }
        } catch(e){}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe') return;
        const authId = room.gameData.players[room.gameData.turn];
        if(socket.id !== authId && authId !== 'BOT') return;
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = room.gameData.turn;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: room.gameData.turn });
        io.to(roomCode).emit('sfx', 'pop');

        const win = checkTTTWin(room.gameData.board);
        if(win) {
            clearInterval(room.gameData.timerInterval);
            let winner = "Draw";
            if(win !== 'draw') {
                 const wid = room.gameData.players[win];
                 const u = room.users.find(u=>u.id===wid);
                 if(u) { u.score += 100; winner = u.username; }
            }
            io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: win==='draw'?"Draw":`${winner} Wins!`, leaderboard: room.users });
            setTimeout(() => {
                 room.gameData.board = Array(9).fill(null);
                 room.gameData.turn = room.settings.startSymbol || 'X';
                 io.to(roomCode).emit('update_room', getRoomState(room));
                 startTTTGame(roomCode);
            }, 3000);
        } else {
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
            room.gameData.moveTime = 30; // reset
            io.to(roomCode).emit('timer_sync', { total: 30, msg: `${room.gameData.turn}'s Turn` });
        }
    });

    // Drawing
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
    
    socket.on('clear', d => { 
        if(rooms[d.roomCode]) { rooms[d.roomCode].gameData.history=[]; io.to(d.roomCode).emit('clear_canvas'); } 
    });
    socket.on('undo', d => {
        const r = rooms[d.roomCode];
        if(r && r.gameData.history.length > 0) {
            r.gameData.redoStack.push(r.gameData.history.pop());
            io.to(d.roomCode).emit('canvas_history', r.gameData.history);
        }
    });
    socket.on('redo', d => {
        const r = rooms[d.roomCode];
        if(r && r.gameData.redoStack.length > 0) {
            r.gameData.history.push(r.gameData.redoStack.pop());
            io.to(d.roomCode).emit('canvas_history', r.gameData.history);
        }
    });

    socket.on('word_select', d => handleWordSelection(d.roomCode, d.word));

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Scribble Logic
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            // Prevent Drawer from chatting
            if(socket.id === room.gameData.drawerId) return;

            const actual = room.gameData.word.toLowerCase();
            const guess = text.trim().toLowerCase();
            
            if(guess === actual) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); 
                    user.score += 100; // Guesser points
                    const dr = room.users.find(u=>u.id===room.gameData.drawerId);
                    if(dr) dr.score += 20; // Drawer bonus

                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed the word!`);
                    io.to(roomCode).emit('sfx', 'success');
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    if(room.gameData.guessed.length >= room.users.length - 1) endScribbleTurn(roomCode, "Everyone Guessed!");
                }
                return;
            } else {
                // Close Call Logic
                const dist = getEditDistance(guess, actual);
                if(dist <= 2 && actual.length > 3) {
                     socket.emit('sys_msg', `🔥 '${text}' is very close!`);
                }
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
    });

    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));

    socket.on('disconnect', () => {
         for(const c in rooms) {
             const r = rooms[c];
             const i = r.users.findIndex(u=>u.id===socket.id);
             if(i!==-1){
                 r.users.splice(i,1); 
                 io.to(c).emit('sys_msg', "User left.");
                 if(r.users.length===0) delete rooms[c];
                 else { if(r.adminId===socket.id) r.adminId=r.users[0].id; io.to(c).emit('update_room', getRoomState(r)); }
                 break;
             }
         }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
