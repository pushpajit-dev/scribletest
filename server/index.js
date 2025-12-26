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
        drawerId: room.gameData?.drawerId || null, 
        roundInfo: { 
            current: room.gameData?.round || 1, 
            total: room.settings?.rounds || 3 
        },
        gameData: room.gameData
    };
}

// --- CHESS LOGIC ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;

    room.state = "PLAYING";
    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w'; // White starts
    room.gameData.history = [];
    
    // Timer Setup (Total Game Time per player)
    const t = room.settings.time || 600; 
    room.gameData.timers = { w: t, b: t };

    // Player Assignment
    const p1 = room.users[0]; // Admin
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
    if(!room) return;

    room.state = "PLAYING";
    room.gameData.board = Array(9).fill(null);
    room.gameData.turn = room.settings.startSymbol || 'X'; // Admin's symbol usually starts
    room.gameData.moveTime = room.settings.time || 30; // Move time limit
    room.gameData.currentMoveTimer = room.gameData.moveTime;

    // Assign Players strictly
    // P1 (Admin) gets startSymbol. P2 gets other.
    const p1 = room.users[0];
    const p2 = room.users[1];
    const adminSym = room.settings.startSymbol || 'X';
    const oppSym = adminSym === 'X' ? 'O' : 'X';
    
    room.gameData.players = { [adminSym]: p1.id };
    if(p2) room.gameData.players[oppSym] = p2.id;
    else room.gameData.players[oppSym] = 'BOT'; // Simple placeholder if solo

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sys_msg', "Tic Tac Toe Started!");

    // Start Move Timer
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        room.gameData.currentMoveTimer--;
        io.to(roomCode).emit('timer_sync', { total: room.gameData.currentMoveTimer, msg: `${room.gameData.turn}'s Turn` });
        
        if(room.gameData.currentMoveTimer <= 0) {
            // Switch Turn on timeout? Or Game Over? Let's Switch for casual play.
            room.gameData.currentMoveTimer = room.gameData.moveTime;
            room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
            io.to(roomCode).emit('sys_msg', "Time skip!");
            io.to(roomCode).emit('update_room', getRoomState(room));
        }
    }, 1000);
}

function checkTTTWin(board) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
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

    // Check Limits
    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', { 
            title:"GAME OVER", 
            msg:"Final Scores!", 
            leaderboard:room.users.sort((a,b)=>b.score-a.score) 
        });
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
        return;
    }

    // Check Drawer Cycle
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
    
    // Notify
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
    
    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    // Pick Timer
    let pickTime = 30;
    clearInterval(room.gameData.timerInterval);
    io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." }); 
    
    room.gameData.timerInterval = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_sync', { total: pickTime, msg: "Picking..." });
        if(pickTime <= 0) {
            handleWordSelection(roomCode, options[0]); 
        }
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timerInterval);
    
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
    io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

    room.gameData.timerInterval = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_tick', time); 
        io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess!" });

        if(time === Math.floor(room.settings.time/2)) {
            io.to(roomCode).emit('sys_msg', `💡 HINT: Starts with '${word[0]}'`);
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
    }, 5000);
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
            maxScore: 10000 
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
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
        socket.emit('sfx', 'join');
        
        // Late Join Sync Scribble
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            socket.emit('canvas_history', room.gameData.history);
            socket.emit('scribble_state', { 
                state: "DRAWING", 
                drawerId: room.gameData.drawerId, 
                maskedWord: room.gameData.word.replace(/[a-zA-Z]/g, '_'), 
                time: room.settings.time, 
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
                room.settings.rounds = parseInt(settings.rounds) || 3;
                room.settings.time = parseInt(settings.time) || 60;
                room.settings.maxScore = parseInt(settings.maxScore) || 10000;
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
        
        // RESTRICTION: Only the assigned player can move
        if(socket.id !== authId && authId !== 'BOT') return;

        const c = new Chess(room.gameData.fen);
        try {
            const m = c.move(move);
            if(m) {
                room.gameData.fen = c.fen();
                room.gameData.turn = c.turn(); // Swaps 'w' -> 'b'
                io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: m });
                io.to(roomCode).emit('sfx', 'pop');
                
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
                               io.to(roomCode).emit('sfx', 'pop');
                               if(c.isGameOver()) endChessGame(roomCode, c.turn()==='w'?'b':'w', "Bot Won");
                           }
                        }, 800); 
                    }
                }
            }
        } catch(e){}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe') return;
        
        // Strict Turn Enforcement
        const currentTurnSym = room.gameData.turn;
        const authorizedId = room.gameData.players[currentTurnSym];
        
        if(socket.id !== authorizedId && authorizedId !== 'BOT') return;
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = currentTurnSym;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: currentTurnSym });
        io.to(roomCode).emit('sfx', 'pop');

        const win = checkTTTWin(room.gameData.board);
        if(win) {
            let winner = "Draw";
            clearInterval(room.gameData.timerInterval);
            if(win !== 'draw') {
                const wid = room.gameData.players[win];
                const u = room.users.find(u=>u.id === wid);
                if(u) { u.score += 100; winner = u.username; }
            }
            io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: win==='draw'?"Draw!":`${winner} Wins!`, leaderboard: room.users });
            
            // Auto Reset TTT
            setTimeout(() => {
                room.gameData.board = Array(9).fill(null);
                room.gameData.turn = room.settings.startSymbol || 'X';
                io.to(roomCode).emit('update_room', getRoomState(room));
                startTTTGame(roomCode); // Restart timer and state
            }, 3000);
        } else {
            room.gameData.turn = currentTurnSym === 'X' ? 'O' : 'X';
            room.gameData.currentMoveTimer = room.gameData.moveTime; // Reset move timer
            io.to(roomCode).emit('timer_sync', { total: room.gameData.currentMoveTimer, msg: `${room.gameData.turn}'s Turn` });
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Scribble Guess Logic
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id !== room.gameData.drawerId) {
            if(text.trim().toLowerCase() === room.gameData.word.toLowerCase()) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); 
                    user.score+=100;
                    // Bonus for drawer
                    const drawer = room.users.find(u=>u.id===room.gameData.drawerId);
                    if(drawer) drawer.score+=20;

                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed!`);
                    io.to(roomCode).emit('update_room', getRoomState(room));
                    if(room.gameData.guessed.length >= room.users.length-1) endScribbleTurn(roomCode, "All Guessed!");
                }
                return;
            }
        }
        io.to(roomCode).emit('chat_receive', { username: user.username, text, avatar: user.avatar });
        io.to(roomCode).emit('sfx', 'msg');
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
        const r = rooms[d.roomCode]; 
        if(r) { r.gameData.history=[]; r.gameData.redoStack=[]; io.to(d.roomCode).emit('clear_canvas'); } 
    });
    
    socket.on('undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room && room.gameData.history.length > 0) {
            room.gameData.redoStack.push(room.gameData.history.pop());
            io.to(roomCode).emit('canvas_history', room.gameData.history);
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
