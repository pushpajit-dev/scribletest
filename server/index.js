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
        // Game Specifics
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
    
    // Timer Setup
    const t = parseInt(room.settings.time) || 600; 
    room.gameData.timers = { w: t, b: t };

    // Player Assignment
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
    io.to(roomCode).emit('sfx', 'start');

    // Start Clock
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; 
        room.gameData.timers[turn]--;
        
        io.to(roomCode).emit('timer_sync', {
            w: room.gameData.timers.w,
            b: room.gameData.timers.b,
            turn: turn
        });

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
            u.score += 100;
            winnerName = u.username;
        }
    }

    io.to(roomCode).emit('game_over_alert', { 
        title: "CHECKMATE / END",
        msg: winnerColor === 'draw' ? "Stalemate / Draw" : `${winnerName} Won! (${reason})`,
        leaderboard: room.users
    });
    io.to(roomCode).emit('update_room', getRoomState(room));
}

// --- TIC TAC TOE LOGIC ---
function startTTTGame(roomCode) {
    const room = rooms[roomCode];
    room.state = "PLAYING";
    room.gameData.board = Array(9).fill(null);
    room.gameData.turn = room.settings.startSymbol || 'X';
    
    io.to(roomCode).emit('update_room', getRoomState(room));
    
    // START TTT TIMER (Central Timer)
    let timeLeft = parseInt(room.settings.time) || 60;
    
    clearInterval(room.gameData.timerInterval);
    io.to(roomCode).emit('timer_sync', { total: timeLeft, msg: `${room.gameData.turn}'s Turn` });
    
    room.gameData.timerInterval = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timer_sync', { total: timeLeft, msg: `${room.gameData.turn}'s Turn` });
        
        if(timeLeft <= 0) {
            clearInterval(room.gameData.timerInterval);
            // Time out logic: Switch turn or Random move? Let's just end round for simplicity
            io.to(roomCode).emit('game_over_alert', { 
                title: "TIME UP", 
                msg: "Time ran out!", 
                leaderboard: room.users 
            });
            setTimeout(() => {
                room.state = "LOBBY";
                io.to(roomCode).emit('update_room', getRoomState(room));
            }, 3000);
        }
    }, 1000);
}

function checkTTTWin(board) {
    const wins = [
        [0,1,2],[3,4,5],[6,7,8], // Rows
        [0,3,6],[1,4,7],[2,5,8], // Cols
        [0,4,8],[2,4,6]          // Diagonals
    ];
    for(let w of wins) {
        if(board[w[0]] && board[w[0]] === board[w[1]] && board[w[0]] === board[w[2]]) {
            return board[w[0]];
        }
    }
    if(board.every(v => v !== null)) return 'draw';
    return null;
}

// --- SCRIBBLE LOGIC ---
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    // Check Rounds
    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', { title:"GAME OVER", msg:"Final Scores!", leaderboard:room.users.sort((a,b)=>b.score-a.score) });
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
    room.gameData.word = null; room.gameData.guessed = []; 
    
    // *** CRITICAL FIX: Ensure State is SELECTING and emitted via update_room ***
    room.state = "SELECTING";
    io.to(roomCode).emit('update_room', getRoomState(room)); // Force Client View Update
    
    io.to(roomCode).emit('clear_canvas'); 
    io.to(roomCode).emit('scribble_state', { state: "SELECTING", drawerId: drawer.id, drawerName: drawer.username, drawerAvatar: drawer.avatar, round: room.gameData.round, totalRounds: room.settings.rounds });
    
    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    let pickTime = 30;
    clearInterval(room.gameData.timer);
    io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." }); 
    room.gameData.timer = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." });
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]); 
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timer);
    room.gameData.word = word; room.state = "DRAWING";
    const masked = word.replace(/[a-zA-Z]/g, '_');
    
    // *** Emitting update_room usually not needed here if state handled by scribble_state, but safe to keep ***
    // io.to(roomCode).emit('update_room', getRoomState(room));

    io.to(roomCode).emit('scribble_state', { state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: masked, time: room.settings.time, round: room.gameData.round, totalRounds: room.settings.rounds });
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); 
    
    let time = parseInt(room.settings.time) || 60;
    room.gameData.timer = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" }); // General Header Sync

        if(time === Math.floor(room.settings.time/2)) io.to(roomCode).emit('chat_receive', {username:'SYSTEM', text:`💡 HINT: Starts with '${word[0]}'`});
        if(time <= 0) { io.to(roomCode).emit('sfx', 'timeover'); endScribbleTurn(roomCode, "Time's up!"); }
    }, 1000);
}

function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timer);
    const lb = room.users.map(u => ({ username: u.username, avatar: u.avatar, score: u.score })).sort((a,b) => b.score - a.score);
    
    io.to(roomCode).emit('game_over_alert', { title: "Round Over", msg: `Word was: ${room.gameData.word}`, leaderboard: lb });
    
    setTimeout(() => { room.gameData.drawerIdx++; startScribbleTurn(roomCode); }, 5000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        // Default Settings
        const rSettings = { 
            rounds: 3, 
            time: 60, 
            customWords: [], 
            botMode: false, 
            chessTheme: 'wikipedia', 
            startColor: 'white', 
            startSymbol: 'X',
            maxScore: 1000 
        };
        
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
        io.to(roomCode).emit('chat_receive', { username: 'SYSTEM', text: `${username} joined.` });
        
        // Late Join Sync for Scribble
        if(room.gameType === 'scribble' && room.state !== 'LOBBY') {
            // Send current state again to late joiner
            socket.emit('scribble_state', { 
                state: room.state, 
                drawerId: room.gameData.drawerId, 
                maskedWord: room.gameData.word ? room.gameData.word.replace(/[a-zA-Z]/g, '_') : "", 
                round: room.gameData.round, 
                totalRounds: room.settings.rounds 
            });
        }
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) {
                // Apply all settings
                room.settings = { ...room.settings, ...settings };
            }

            if(room.gameType === 'scribble') {
                room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0);
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') {
                startChessGame(roomCode);
            } else if (room.gameType === 'tictactoe') {
                startTTTGame(roomCode);
            }
        }
    });

    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'chess' || room.state !== 'PLAYING') return;
        
        const turnColor = room.gameData.turn;
        const authId = room.gameData.players[turnColor];
        
        // Strict Turn Check
        if(socket.id !== authId && authId !== 'BOT') return;

        const c = new Chess(room.gameData.fen);
        try {
            const m = c.move(move);
            if(m) {
                room.gameData.fen = c.fen();
                room.gameData.turn = c.turn(); 
                io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: m });
                
                if(c.isGameOver()) {
                    let r = "Draw"; let w = 'draw';
                    if(c.isCheckmate()) { r="Checkmate"; w=turnColor; } 
                    endChessGame(roomCode, w, r);
                } else {
                    // Bot Move
                    if(room.gameData.players[c.turn()] === 'BOT') {
                        setTimeout(() => {
                           const moves = c.moves();
                           const randMove = moves[Math.floor(Math.random() * moves.length)];
                           if(randMove) {
                               c.move(randMove);
                               room.gameData.fen = c.fen();
                               room.gameData.turn = c.turn();
                               io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: randMove });
                               if(c.isGameOver()) endChessGame(roomCode, c.turn()==='w'?'b':'w', "Bot Won");
                           }
                        }, 500); 
                    }
                }
            }
        } catch(e){}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe' || room.state !== 'PLAYING') return;
        
        // Settings-based turn handling
        const currentTurnSym = room.gameData.turn;
        
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = currentTurnSym;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: currentTurnSym });

        const win = checkTTTWin(room.gameData.board);
        if(win) {
            let winnerName = "Draw";
            if(win !== 'draw') {
                // Since we don't strictly map X/O to IDs in simple mode, we check who moved last? 
                // Or simplified: Any win ends round.
                winnerName = `${win} Wins!`;
                // Score? In this simple TTT, maybe just random points or no points unless strict PvP map logic added.
                // We'll give points to everyone to keep it happy? Or just Leaderboard display.
            }
            clearInterval(room.gameData.timerInterval);
            io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: winnerName, leaderboard: room.users });
            
            setTimeout(() => {
                room.state = "LOBBY"; // Return to lobby after game
                io.to(roomCode).emit('update_room', getRoomState(room));
            }, 3000);
        } else {
            room.gameData.turn = currentTurnSym === 'X' ? 'O' : 'X';
            io.to(roomCode).emit('timer_sync', { msg: `${room.gameData.turn}'s Turn` });
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            if(text.trim().toLowerCase() === room.gameData.word.toLowerCase()) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); 
                    user.score += 100;
                    // Max Score Check
                    if(user.score >= (parseInt(room.settings.maxScore) || 1000)) {
                         io.to(roomCode).emit('game_over_alert', { title: "WINNER", msg: `${user.username} reached max score!`, leaderboard: room.users });
                         room.state = "GAME_OVER";
                         return;
                    }
                    io.to(roomCode).emit('chat_receive', { username: 'SYSTEM', text: `🎉 ${user.username} guessed it!` });
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    
                    if(room.gameData.guessed.length >= room.users.length-1) endScribbleTurn(roomCode, "All Guessed!");
                }
                return;
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
    });

    socket.on('draw_op', d => socket.to(d.roomCode).emit('draw_op', d));
    socket.on('clear', d => { if(rooms[d.roomCode]) io.to(d.roomCode).emit('clear_canvas'); });
    socket.on('word_select', d => handleWordSelection(d.roomCode, d.word));
    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));
    
    socket.on('disconnect', () => {
         for(const c in rooms) {
             const r = rooms[c];
             const i = r.users.findIndex(u=>u.id===socket.id);
             if(i!==-1){
                 r.users.splice(i,1); io.to(c).emit('chat_receive', {username:'SYSTEM', text:"User left."});
                 if(r.users.length===0) delete rooms[c];
                 else { if(r.adminId===socket.id) r.adminId=r.users[0].id; io.to(c).emit('update_room', getRoomState(r)); }
                 break;
             }
         }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
