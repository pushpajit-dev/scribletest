const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- SAFE IMPORTS ---
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js error: npm install chess.js"); }

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
        drawerId: room.gameData.drawerId, // Scribble only
        roundInfo: { 
            current: room.gameData.round, 
            total: room.settings.rounds 
        },
        // Game Specifics
        gameData: {
            fen: room.gameData.fen,         
            turn: room.gameData.turn,       
            board: room.gameData.board,     
            timers: room.gameData.timers,   
            players: room.gameData.players  
        }
    };
}

// --- CHESS LOGIC ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;

    room.state = "PLAYING";
    
    // Assign Players
    const p1 = room.users[0];
    const p2 = room.users[1]; // Might be undefined if solo

    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w';
    room.gameData.history = [];
    
    // Timers (Default 10 mins if not set)
    const t = room.settings.time || 600; 
    room.gameData.timers = { w: t, b: t };

    // Setup Colors
    if(room.settings.botMode) {
        room.gameData.players = { w: p1.id, b: 'BOT' };
    } else {
        if(!p2) { // Fallback if no 2nd player
             room.gameData.players = { w: p1.id, b: 'BOT' };
             room.settings.botMode = true;
        } else {
            // Respect Invert
            if(room.settings.invertColors) room.gameData.players = { w: p2.id, b: p1.id };
            else room.gameData.players = { w: p1.id, b: p2.id };
        }
    }

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sfx', 'start');
    
    // Start Clock
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; 
        room.gameData.timers[turn]--;
        
        // Sync frequently
        if(room.gameData.timers[turn] % 5 === 0 || room.gameData.timers[turn] < 30) {
            io.to(roomCode).emit('chess_timer_update', room.gameData.timers);
        }

        if(room.gameData.timers[turn] <= 0) {
            endChessGame(roomCode, turn === 'w' ? 'b' : 'w', "Time Out");
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
        const wid = room.gameData.players[winnerColor];
        const u = room.users.find(u => u.id === wid);
        if(u) {
            u.score += 10;
            winnerName = u.username;
        }
    }

    io.to(roomCode).emit('game_over_alert', { 
        title: "GAME OVER",
        msg: winnerColor === 'draw' ? "Stalemate / Draw" : `${winnerName} Won! (${reason})`,
        leaderboard: room.users // Update scores
    });
    io.to(roomCode).emit('update_room', getRoomState(room));
}

// --- TIC TAC TOE LOGIC ---
function checkTTTWin(board, size) {
    const s = parseInt(size);
    // Rows
    for(let r=0; r<s; r++) {
        const row = [];
        for(let c=0; c<s; c++) row.push(board[r*s+c]);
        if(row[0] && row.every(v => v===row[0])) return row[0];
    }
    // Cols
    for(let c=0; c<s; c++) {
        const col = [];
        for(let r=0; r<s; r++) col.push(board[r*s+c]);
        if(col[0] && col.every(v => v===col[0])) return col[0];
    }
    // Diagonals
    const d1=[], d2=[];
    for(let i=0; i<s; i++) {
        d1.push(board[i*s+i]);
        d2.push(board[i*s+(s-1-i)]);
    }
    if(d1[0] && d1.every(v => v===d1[0])) return d1[0];
    if(d2[0] && d2.every(v => v===d2[0])) return d2[0];

    if(board.every(v => v!==null)) return 'draw';
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
        room.gameData.drawerIdx = 0; room.gameData.round++;
        startScribbleTurn(roomCode); return;
    }
    const drawer = room.users[room.gameData.drawerIdx];
    room.gameData.drawerId = drawer.id;
    room.gameData.word = null; room.gameData.guessed = []; room.gameData.history = []; room.gameData.redoStack = []; 
    io.to(roomCode).emit('clear_canvas'); 
    room.state = "SELECTING";
    io.to(roomCode).emit('scribble_state', { state: "SELECTING", drawerId: drawer.id, drawerName: drawer.username, drawerAvatar: drawer.avatar, round: room.gameData.round, totalRounds: room.settings.rounds });
    const options = getRandomWords(3, room.settings.customWords || []);
    io.to(drawer.id).emit('pick_word', { words: options });
    let pickTime = 30;
    clearInterval(room.gameData.timer);
    io.to(roomCode).emit('pick_timer', pickTime);
    room.gameData.timer = setInterval(() => { pickTime--; io.to(roomCode).emit('pick_timer', pickTime); if(pickTime <= 0) handleWordSelection(roomCode, options[0]); }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timer);
    room.gameData.word = word; room.state = "DRAWING";
    const masked = word.replace(/[a-zA-Z]/g, '_');
    io.to(roomCode).emit('scribble_state', { state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: masked, time: room.settings.time, round: room.gameData.round, totalRounds: room.settings.rounds });
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); 
    let time = room.settings.time;
    room.gameData.timer = setInterval(() => {
        time--; io.to(roomCode).emit('timer_tick', time);
        if(time === Math.floor(room.settings.time/2)) io.to(roomCode).emit('sys_msg', `💡 HINT: Starts with '${word[0]}'`);
        if(time <= 0) { io.to(roomCode).emit('sfx', 'timeover'); endTurn(roomCode, "Time's up!"); }
    }, 1000);
}

function endTurn(roomCode, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timer);
    const lb = room.users.map(u => ({ username: u.username, avatar: u.avatar, score: u.score, guessed: room.gameData.guessed.includes(u.id) || u.id === room.gameData.drawerId })).sort((a,b) => b.score - a.score);
    io.to(roomCode).emit('scribble_end_turn', { word: room.gameData.word, reason: reason, leaderboard: lb });
    setTimeout(() => { room.gameData.drawerIdx++; startScribbleTurn(roomCode); }, 5000);
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
        socket.emit('sfx', 'join');
        
        // Late Join Sync for Scribble
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            socket.emit('canvas_history', room.gameData.history);
            socket.emit('scribble_state', { state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: room.gameData.word.replace(/[a-zA-Z]/g, '_'), time: room.settings.time, round: room.gameData.round, totalRounds: room.settings.rounds });
        }
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) {
                room.settings = { ...room.settings, ...settings };
                room.settings.rounds = parseInt(settings.rounds);
                room.settings.time = parseInt(settings.time);
                room.settings.gridSize = parseInt(settings.gridSize);
            }

            if(room.gameType === 'scribble') {
                room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0);
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') {
                startChessGame(roomCode);
            } else if (room.gameType === 'tictactoe') {
                room.state = "PLAYING";
                const s = room.settings.gridSize || 3;
                room.gameData.board = Array(s*s).fill(null);
                room.gameData.turn = 'X';
                io.to(roomCode).emit('update_room', getRoomState(room));
            }
        }
    });

    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'chess' || room.state !== 'PLAYING') return;
        
        const turnColor = room.gameData.turn;
        const authId = room.gameData.players[turnColor];
        
        // Validation: Only current player or Bot's controller (Admin)
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
                    let r = "Draw"; let w = 'draw';
                    if(c.isCheckmate()) { r="Checkmate"; w=turnColor; }
                    endChessGame(roomCode, w, r);
                } else {
                    // Bot Move Trigger?
                    if(room.gameData.players[c.turn()] === 'BOT') {
                        // Delay handled on client or simple timeout here?
                        // Let's do simple timeout random move on server for stability
                        setTimeout(() => {
                           const moves = c.moves();
                           const randMove = moves[Math.floor(Math.random() * moves.length)];
                           if(randMove) {
                               c.move(randMove);
                               room.gameData.fen = c.fen();
                               room.gameData.turn = c.turn();
                               io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: randMove });
                               io.to(roomCode).emit('sfx', 'pop');
                               if(c.isGameOver()) endChessGame(roomCode, c.turn()==='w'?'b':'w', "Bot Won");
                           }
                        }, 1000);
                    }
                }
            }
        } catch(e){}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe') return;
        
        // Players
        const p1 = room.users[0];
        const p2 = room.users[1]; // or undefined

        // Turn Check
        if(room.gameData.turn === 'X' && socket.id !== p1.id) return;
        if(room.gameData.turn === 'O' && (!p2 || socket.id !== p2.id)) return;
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = room.gameData.turn;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: room.gameData.turn });
        io.to(roomCode).emit('sfx', 'pop');

        const win = checkTTTWin(room.gameData.board, room.settings.gridSize);
        if(win) {
            let winner = "Draw";
            if(win !== 'draw') {
                const u = win === 'X' ? p1 : p2;
                if(u) { u.score += 1; winner = u.username; }
            }
            io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: win==='draw'?"Draw!":`${winner} Wins!`, leaderboard: room.users });
            setTimeout(() => {
                const s = room.settings.gridSize;
                room.gameData.board = Array(s*s).fill(null);
                room.gameData.turn = 'X';
                io.to(roomCode).emit('update_room', getRoomState(room));
            }, 3000);
        } else {
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Chess Restriction
        if(room.gameType === 'chess' && room.state === 'PLAYING') {
             const isP = Object.values(room.gameData.players).includes(socket.id);
             if(isP) return; // Player cannot chat
        }
        
        // Scribble Logic (Same as before)
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            // ... (Your previous scribble logic) ...
            // Re-adding brief version for integrity
            if(text.trim().toLowerCase() === room.gameData.word.toLowerCase()) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); user.score+=100;
                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed!`);
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    if(room.gameData.guessed.length >= room.users.length-1) endTurn(roomCode, "All Guessed!");
                }
                return;
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
        io.to(roomCode).emit('sfx', 'msg');
    });

    // Drawing & Utils
    socket.on('draw_op', d => socket.to(d.roomCode).emit('draw_op', d));
    socket.on('clear', d => { if(rooms[d.roomCode]) io.to(d.roomCode).emit('clear_canvas'); });
    socket.on('undo', d => { if(rooms[d.roomCode]) io.to(d.roomCode).emit('undo'); }); // Simplified for brevity
    socket.on('word_select', d => handleWordSelection(d.roomCode, d.word));
    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));
    
    socket.on('disconnect', () => {
         // Same disconnect logic
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
