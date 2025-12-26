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
function getRandomWords(count, customWords = []) {
    const pool = customWords.length > 0 ? customWords : wordList;
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
        drawerId: room.gameData?.drawerId || null, 
        roundInfo: { current: room.gameData?.round || 1, total: room.settings?.rounds || 3 },
        gameData: room.gameData
    };
}

// --- SCRIBBLE HELPERS ---
function getMaskedWord(word, revealIndices) {
    let m = "";
    for(let i=0; i<word.length; i++) {
        if(word[i] === ' ') m += "  "; 
        else if (revealIndices.includes(i)) m += word[i] + " ";
        else m += "_ ";
    }
    return m.trim();
}

function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check End Game
    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        const sorted = room.users.sort((a,b)=>b.score-a.score);
        io.to(roomCode).emit('game_over_alert', { 
            title: "🏆 FINAL SCORES", 
            msg: `Winner: ${sorted[0].username}`, 
            leaderboard: sorted 
        });
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
        return;
    }

    // Check Drawer Cycle
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
    room.gameData.revealIndices = [];
    
    io.to(roomCode).emit('clear_canvas'); 
    room.state = "SELECTING";
    
    // Notify Room
    io.to(roomCode).emit('scribble_state', { 
        state: "SELECTING", drawerId: drawer.id, drawerName: drawer.username, 
        round: room.gameData.round, totalRounds: room.settings.rounds 
    });
    
    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    let pickTime = 30;
    clearInterval(room.gameData.timerInterval);
    io.to(roomCode).emit('timer_sync', { total: pickTime, msg: `${drawer.username} is picking...` }); 
    
    room.gameData.timerInterval = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_sync', { total: pickTime, msg: `${drawer.username} is picking...` });
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]);
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timerInterval);
    
    room.gameData.word = word; 
    room.state = "DRAWING";
    const masked = getMaskedWord(word, []);
    
    io.to(roomCode).emit('scribble_state', { 
        state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: masked, 
        time: room.settings.time, round: room.gameData.round, totalRounds: room.settings.rounds 
    });
    
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); 
    
    let time = room.settings.time;
    const totalTime = time;
    io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

    room.gameData.timerInterval = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

        // --- HINT LOGIC: Reveal at 50% and 25% time ---
        if(time === Math.floor(totalTime * 0.5) || time === Math.floor(totalTime * 0.25)) {
            const unrevealed = [];
            for(let i=0; i<word.length; i++) {
                if(!room.gameData.revealIndices.includes(i) && word[i] !== ' ') unrevealed.push(i);
            }
            if(unrevealed.length > 0) {
                // Reveal 1 random character
                room.gameData.revealIndices.push(unrevealed[Math.floor(Math.random() * unrevealed.length)]);
                io.to(roomCode).emit('scribble_mask_update', getMaskedWord(word, room.gameData.revealIndices));
            }
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
    const lb = room.users.map(u => ({ username: u.username, score: u.score })).sort((a,b) => b.score - a.score);
    io.to(roomCode).emit('scribble_end_turn', { word: room.gameData.word, reason: reason, leaderboard: lb });
    setTimeout(() => { room.gameData.drawerIdx++; startScribbleTurn(roomCode); }, 5000);
}

// --- CHESS & TTT LOGIC (Preserved) ---
function startChessGame(roomCode) {
    const room = rooms[roomCode]; if(!room || !Chess) return;
    room.state = "PLAYING"; room.gameData.fen = new Chess().fen(); room.gameData.turn = 'w'; room.gameData.history = [];
    const t = room.settings.time || 600; room.gameData.timers = { w: t, b: t };
    const p1 = room.users[0], p2 = room.users[1];
    let ac = room.settings.startColor === 'black' ? 'b' : 'w', oc = ac === 'w' ? 'b' : 'w';
    if(room.settings.botMode || !p2) { room.gameData.players = { [ac]: p1.id, [oc]: 'BOT' }; room.settings.botMode = true; }
    else { room.gameData.players = { [ac]: p1.id, [oc]: p2.id }; }
    io.to(roomCode).emit('update_room', getRoomState(room)); io.to(roomCode).emit('sys_msg', "Chess Started!");
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; room.gameData.timers[turn]--;
        io.to(roomCode).emit('timer_sync', { w: room.gameData.timers.w, b: room.gameData.timers.b, turn: turn });
        if(room.gameData.timers[turn] <= 0) endChessGame(roomCode, turn === 'w' ? 'b' : 'w', "Time Out");
    }, 1000);
}
function endChessGame(roomCode, winnerColor, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timerInterval); room.state = "GAME_OVER";
    let wName = "Bot"; if(winnerColor==='draw') wName="Draw"; else { const u = room.users.find(u=>u.id===room.gameData.players[winnerColor]); if(u) { u.score+=100; wName=u.username; } }
    io.to(roomCode).emit('game_over_alert', { title: "CHECKMATE", msg: winnerColor==='draw'?"Draw":`${wName} Won!`, leaderboard: room.users });
    io.to(roomCode).emit('update_room', getRoomState(room));
}
function startTTTGame(roomCode) {
    const room = rooms[roomCode]; if(!room) return;
    room.state = "PLAYING"; room.gameData.board = Array(9).fill(null); room.gameData.turn = room.settings.startSymbol || 'X';
    room.gameData.moveTime = room.settings.time || 30; room.gameData.currentMoveTimer = room.gameData.moveTime;
    const p1 = room.users[0], p2 = room.users[1], as = room.settings.startSymbol||'X', os = as==='X'?'O':'X';
    room.gameData.players = { [as]: p1.id, [os]: p2 ? p2.id : 'BOT' };
    io.to(roomCode).emit('update_room', getRoomState(room)); io.to(roomCode).emit('sys_msg', "TTT Started!");
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        room.gameData.currentMoveTimer--; io.to(roomCode).emit('timer_sync', { total: room.gameData.currentMoveTimer, msg: `${room.gameData.turn}'s Turn` });
        if(room.gameData.currentMoveTimer <= 0) { room.gameData.currentMoveTimer=room.gameData.moveTime; room.gameData.turn=room.gameData.turn==='X'?'O':'X'; io.to(roomCode).emit('update_room', getRoomState(room)); }
    }, 1000);
}
function checkTTTWin(board) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for(let w of wins) if(board[w[0]] && board[w[0]]===board[w[1]] && board[w[0]]===board[w[2]]) return board[w[0]];
    if(board.every(v=>v!==null)) return 'draw'; return null;
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const rSettings = { rounds: 3, time: 60, customWords: [], botMode: false, startSymbol: 'X', chessTheme: 'wikipedia' };
        
        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], redoStack: [], guessed: [], revealIndices: [] };
        else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X', round: 1, moveTime:30, currentMoveTimer:30, players:{} };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen(), round: 1, turn: 'w', timers: {w:600, b:600}, players: {} };
        
        rooms[roomCode] = { name: `${username}'s Room`, adminId: socket.id, users: [], gameType, settings: rSettings, gameData: gd, state: "LOBBY" };
        socket.emit('room_created', roomCode);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if(!room) return socket.emit('error', "Room not found");
        if(room.users.length >= 10) return socket.emit('error', "Room Full");
        
        const existing = room.users.find(u => u.id === socket.id);
        if(!existing) {
            const av = avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`;
            room.users.push({ id: socket.id, username, avatar: av, score: 0 });
            socket.join(roomCode);
        }
        
        io.to(roomCode).emit('update_room', getRoomState(room));
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
        
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            socket.emit('canvas_history', room.gameData.history);
            socket.emit('scribble_state', { 
                state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: getMaskedWord(room.gameData.word, room.gameData.revealIndices), 
                time: room.settings.time, round: room.gameData.round, totalRounds: room.settings.rounds 
            });
        }
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) Object.assign(room.settings, settings);
            if(room.gameType === 'scribble') { room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0); startScribbleTurn(roomCode); }
            else if (room.gameType === 'chess') startChessGame(roomCode);
            else if (room.gameType === 'tictactoe') startTTTGame(roomCode);
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Scribble Guess Logic
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            const guess = text.trim().toLowerCase();
            const actual = room.gameData.word.toLowerCase();

            if(guess === actual) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); 
                    user.score += Math.floor(100 + (50 * Math.random()));
                    const drawer = room.users.find(u=>u.id===room.gameData.drawerId);
                    if(drawer) drawer.score+=20;
                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed it!`);
                    io.to(roomCode).emit('sfx', 'pop');
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    if(room.gameData.guessed.length >= room.users.length-1) endScribbleTurn(roomCode, "All Guessed!");
                }
                return;
            } else if(actual.includes(guess) && guess.length > 2) {
                 // Close Guess Check
                 socket.emit('sys_msg', `🔥 '${text}' is close!`);
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
    });

    // Drawing
    socket.on('draw_op', (data) => {
        const room = rooms[data.roomCode]; if(!room) return;
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

    socket.on('clear', d => { const r = rooms[d.roomCode]; if(r) { r.gameData.history=[]; io.to(d.roomCode).emit('clear_canvas'); } });
    socket.on('undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.history.length > 0) {
            room.gameData.redoStack.push(room.gameData.history.pop());
            io.to(roomCode).emit('canvas_history', room.gameData.history);
        }
    });

    // Chess/TTT Moves (Preserved)
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode]; if(!room || room.gameType !== 'chess') return;
        const c = new Chess(room.gameData.fen); const m = c.move(move);
        if(m) {
             room.gameData.fen = c.fen(); room.gameData.turn = c.turn();
             io.to(roomCode).emit('chess_move_update', { fen: c.fen(), move: m });
             if(c.isGameOver()) endChessGame(roomCode, c.isCheckmate()?room.gameData.turn:'draw', "End");
        }
    });
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode]; if(!room || room.gameData.board[index]!==null) return;
        room.gameData.board[index] = room.gameData.turn;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: room.gameData.turn });
        const w = checkTTTWin(room.gameData.board);
        if(w) { 
            let winner="Draw"; if(w!=='draw'){ const u=room.users.find(u=>u.id===room.gameData.players[w]); if(u){u.score+=100; winner=u.username;} }
            io.to(roomCode).emit('game_over_alert', { title:"Round Over", msg:w==='draw'?"Draw":`${winner} Wins!`, leaderboard:room.users});
            setTimeout(()=>{room.gameData.board=Array(9).fill(null); startTTTGame(roomCode);},3000);
        } else {
            room.gameData.turn = room.gameData.turn==='X'?'O':'X';
            room.gameData.currentMoveTimer = room.gameData.moveTime;
            io.to(roomCode).emit('timer_sync', { total: room.gameData.currentMoveTimer, msg: `${room.gameData.turn}'s Turn` });
        }
    });

    socket.on('word_select', d => handleWordSelection(d.roomCode, d.word));
    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));
    
    socket.on('disconnect', () => {
         for(const c in rooms) {
             const r = rooms[c];
             const i = r.users.findIndex(u=>u.id===socket.id);
             if(i!==-1){
                 r.users.splice(i,1); io.to(c).emit('sys_msg', "User left.");
                 if(r.users.length===0) delete rooms[c];
                 else { if(r.adminId===socket.id) r.adminId=r.users[0].id; io.to(c).emit('update_room', getRoomState(r)); }
                 break;
             }
         }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
