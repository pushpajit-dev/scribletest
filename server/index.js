const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js error: Run 'npm install chess.js'"); }

// Full Word List
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
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
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
        roundInfo: { current: room.gameData.round, total: room.settings.rounds },
        gameData: {
            fen: room.gameData.fen,         
            turn: room.gameData.turn,       
            board: room.gameData.board,     
            timers: room.gameData.timers,   
            players: room.gameData.players,
            maskedWord: room.gameData.maskedWord // Ensure this is sent for Scribble
        }
    };
}

function checkSessionWin(roomCode) {
    const room = rooms[roomCode];
    if(!room) return false;
    
    const target = room.settings.maxScore;
    if(!target || target <= 0) return false; 

    const winner = room.users.find(u => u.score >= target);
    if(winner) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', {
            title: "🏆 GRAND WINNER! 🏆",
            msg: `${winner.username} reached ${target} points!`,
            leaderboard: room.users.sort((a,b)=>b.score-a.score)
        });
        io.to(roomCode).emit('update_room', getRoomState(room));
        setTimeout(() => {
            room.state = "LOBBY";
            room.users.forEach(u => u.score = 0);
            io.to(roomCode).emit('update_room', getRoomState(room));
        }, 8000);
        return true;
    }
    return false;
}

// --- CHESS ENGINE ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;

    room.state = "PLAYING";
    const p1 = room.users[0];
    const p2 = room.users[1]; 

    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w';
    room.gameData.lastMoveTime = Date.now();
    
    const sessionTime = parseInt(room.settings.time) || 600; 
    room.gameData.timers = { w: 600, b: 600, total: sessionTime }; 

    const adminIsWhite = room.settings.startColor !== 'black'; 
    if(room.settings.botMode || !p2) {
        room.gameData.players = { w: adminIsWhite ? p1.id : 'BOT', b: adminIsWhite ? 'BOT' : p1.id };
    } else {
        room.gameData.players = { w: adminIsWhite ? p1.id : p2.id, b: adminIsWhite ? p2.id : p1.id };
    }

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sfx', 'start');
    
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        room.gameData.timers.total--;
        io.to(roomCode).emit('timer_tick', { total: room.gameData.timers.total });

        const turn = room.gameData.turn; 
        room.gameData.timers[turn]--;
        io.to(roomCode).emit('chess_timer_update', room.gameData.timers);

        if(room.gameData.timers.total <= 0) endChessGame(roomCode, 'draw', "Session Time Up");
        if(room.gameData.timers[turn] <= 0) endChessGame(roomCode, turn==='w'?'b':'w', "Timeout");
    }, 1000);
}

function endChessGame(roomCode, winnerColor, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.timerInterval);
    
    let winnerName = "Bot";
    if(winnerColor === 'draw') winnerName = "Draw";
    else {
        const wid = room.gameData.players[winnerColor];
        const u = room.users.find(u => u.id === wid);
        if(u) { u.score += 100; winnerName = u.username; }
    }

    if(checkSessionWin(roomCode)) return;

    io.to(roomCode).emit('game_over_alert', { 
        title: "GAME OVER",
        msg: winnerColor === 'draw' ? "Game Drawn!" : `${winnerName} Wins! (${reason})`,
        leaderboard: room.users
    });
    
    setTimeout(() => {
        room.state = "LOBBY";
        io.to(roomCode).emit('update_room', getRoomState(room));
    }, 5000);
}

// --- TIC TAC TOE ENGINE ---
function checkTTTWin(board, size) {
    const s = parseInt(size);
    const get = (r,c) => board[r*s+c];
    for(let i=0; i<s; i++) {
        if(get(i,0) && [...Array(s)].every((_,j)=>get(i,j)===get(i,0))) return get(i,0);
        if(get(0,i) && [...Array(s)].every((_,j)=>get(j,i)===get(0,i))) return get(0,i);
    }
    if(get(0,0) && [...Array(s)].every((_,i)=>get(i,i)===get(0,0))) return get(0,0);
    if(get(0,s-1) && [...Array(s)].every((_,i)=>get(i,s-1-i)===get(0,s-1))) return get(0,s-1);
    if(board.every(v=>v)) return 'draw';
    return null;
}

// --- SCRIBBL ENGINE ---
function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    if (checkSessionWin(roomCode)) return;

    if (room.gameData.round > room.settings.rounds) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', { title: "GAME OVER", msg: "All rounds finished!", leaderboard: room.users });
        setTimeout(() => {
            room.state = "LOBBY";
            io.to(roomCode).emit('update_room', getRoomState(room));
        }, 5000);
        return;
    }
    if (room.gameData.drawerIdx >= room.users.length) {
        room.gameData.drawerIdx = 0; room.gameData.round++;
        startScribbleTurn(roomCode); return;
    }
    const drawer = room.users[room.gameData.drawerIdx];
    room.gameData.drawerId = drawer.id;
    room.gameData.word = null; room.gameData.guessed = []; 
    
    io.to(roomCode).emit('clear_canvas'); 
    room.state = "SELECTING";
    io.to(roomCode).emit('scribble_state', { state: "SELECTING", drawerId: drawer.id, drawerName: drawer.username, drawerAvatar: drawer.avatar });
    
    const options = getRandomWords(3);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    let pickTime = 30;
    clearInterval(room.gameData.timerInterval);
    io.to(roomCode).emit('timer_tick', { total: pickTime });
    room.gameData.timerInterval = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_tick', { total: pickTime }); 
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]); 
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timerInterval);
    room.gameData.word = word; room.state = "DRAWING";
    room.gameData.maskedWord = word.replace(/[a-zA-Z]/g, '_');
    
    io.to(roomCode).emit('scribble_state', { state: "DRAWING", drawerId: room.gameData.drawerId, maskedWord: room.gameData.maskedWord });
    io.to(room.gameData.drawerId).emit('drawer_secret', word);
    io.to(roomCode).emit('sfx', 'start'); 
    
    let time = parseInt(room.settings.time) || 60;
    room.gameData.timerInterval = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_tick', { total: time });
        if(time === Math.floor(parseInt(room.settings.time)/2)) io.to(roomCode).emit('sys_msg', `💡 HINT: Starts with '${word[0]}'`);
        if(time <= 0) endTurn(roomCode, "Time's up!");
    }, 1000);
}

function endTurn(roomCode, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timerInterval);
    const lb = room.users.map(u => ({ username: u.username, avatar: u.avatar, score: u.score, guessed: room.gameData.guessed.includes(u.id) || u.id === room.gameData.drawerId })).sort((a,b) => b.score - a.score);
    io.to(roomCode).emit('scribble_end_turn', { word: room.gameData.word, reason: reason, leaderboard: lb });
    setTimeout(() => { room.gameData.drawerIdx++; startScribbleTurn(roomCode); }, 5000);
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        // Updated Default Settings
        const rSettings = { rounds: 3, time: 600, maxScore: 10000, botMode: false, startColor: 'white', startSymbol: 'X', gridSize: 3, chessTheme: 'wikipedia' };
        
        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, guessed: [] };
        else if (gameType === 'tictactoe') gd = { board: [], turn: 'X', round: 1 };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen(), round: 1, turn: 'w', timers: {}, players: {} };
        
        rooms[roomCode] = { name: `${username}'s Room`, adminId: socket.id, users: [], gameType, settings: rSettings, gameData: gd, state: "LOBBY" };
        socket.emit('room_created', roomCode);
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
        io.to(roomCode).emit('sys_msg', `${username} joined.`);
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) {
                room.settings = { ...room.settings, ...settings };
                room.settings.rounds = parseInt(settings.rounds);
                room.settings.time = parseInt(settings.time);
                room.settings.maxScore = parseInt(settings.maxScore); 
                room.settings.gridSize = parseInt(settings.gridSize);
            }

            if(room.gameType === 'scribble') {
                room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0);
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') {
                room.users.forEach(u=>u.score=0);
                startChessGame(roomCode);
            } else if (room.gameType === 'tictactoe') {
                room.state = "PLAYING";
                room.users.forEach(u=>u.score=0);
                const s = room.settings.gridSize || 3;
                room.gameData.board = Array(s*s).fill(null);
                
                const adminIsX = room.settings.startSymbol === 'X';
                room.gameData.turn = 'X'; 
                room.gameData.players = { X: adminIsX ? room.users[0].id : (room.users[1]?.id || 'BOT'), O: adminIsX ? (room.users[1]?.id || 'BOT') : room.users[0].id };
                
                // Session Timer for TTT
                room.gameData.timers = { total: room.settings.time || 600 };
                clearInterval(room.gameData.timerInterval);
                room.gameData.timerInterval = setInterval(() => {
                    room.gameData.timers.total--;
                    io.to(roomCode).emit('timer_tick', { total: room.gameData.timers.total });
                    if(room.gameData.timers.total <= 0) {
                        clearInterval(room.gameData.timerInterval);
                        io.to(roomCode).emit('game_over_alert', { title:"TIME UP", msg:"Session Ended", leaderboard:room.users });
                    }
                }, 1000);

                io.to(roomCode).emit('update_room', getRoomState(room));
                io.to(roomCode).emit('sys_msg', "Game Started!");
            }
        }
    });

    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType !== 'chess' || room.state !== 'PLAYING') return;
        const turn = room.gameData.turn; 
        const auth = room.gameData.players[turn];
        if(socket.id !== auth && auth !== 'BOT') return;

        const c = new Chess(room.gameData.fen);
        try {
            const m = c.move(move);
            if(m) {
                // Scoring
                const now = Date.now();
                const diff = (now - room.gameData.lastMoveTime)/1000;
                let pts = diff < 5 ? 10 : (diff < 10 ? 5 : 2);
                
                const u = room.users.find(u => u.id === socket.id);
                if(u) u.score += pts;

                room.gameData.lastMoveTime = now;
                room.gameData.fen = c.fen();
                room.gameData.turn = c.turn();
                
                io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: m });
                io.to(roomCode).emit('sfx', 'pop');
                io.to(roomCode).emit('update_room', getRoomState(room)); 
                
                if(c.isGameOver()) {
                    let w = 'draw';
                    if(c.isCheckmate()) w = turn;
                    endChessGame(roomCode, w, c.isCheckmate()?"Checkmate":"Draw");
                } else if(room.gameData.players[c.turn()] === 'BOT') {
                    // Bot Move
                    setTimeout(() => {
                       const moves = c.moves();
                       const rm = moves[Math.floor(Math.random() * moves.length)];
                       if(rm) {
                           c.move(rm);
                           room.gameData.fen = c.fen();
                           room.gameData.turn = c.turn();
                           io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: rm });
                           io.to(roomCode).emit('sfx', 'pop');
                           if(c.isGameOver()) endChessGame(roomCode, c.turn()==='w'?'b':'w', "Bot Won");
                       }
                    }, 1000);
                }
            }
        } catch(e){}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe') return;
        const turn = room.gameData.turn; 
        const auth = room.gameData.players[turn];
        if(socket.id !== auth && auth !== 'BOT') return;
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = turn;
        io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: turn });
        io.to(roomCode).emit('sfx', 'pop');

        const win = checkTTTWin(room.gameData.board, room.settings.gridSize);
        if(win) {
            let wName = "Draw";
            if(win !== 'draw') {
                const wid = room.gameData.players[win];
                const u = room.users.find(u => u.id === wid);
                if(u) { u.score += 50; wName = u.username; }
            }
            // Check grand winner
            if(!checkSessionWin(roomCode)) {
                io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: win==='draw'?"Draw":`${wName} Wins!`, leaderboard: room.users });
                setTimeout(() => {
                    const s = room.settings.gridSize;
                    room.gameData.board = Array(s*s).fill(null);
                    room.gameData.turn = 'X';
                    io.to(roomCode).emit('update_room', getRoomState(room));
                }, 3000);
            }
        } else {
            room.gameData.turn = turn === 'X' ? 'O' : 'X';
            io.to(roomCode).emit('update_room', getRoomState(room));
        }
    });

    socket.on('chat_send', d => {
        const r = rooms[d.roomCode]; if(!r) return;
        const u = r.users.find(x=>x.id===socket.id);
        if(r.gameType!=='scribble' && r.state==='PLAYING' && Object.values(r.gameData.players).includes(socket.id)) return; 
        // Scribble guess logic included
        if(r.gameType === 'scribble' && r.state === 'DRAWING' && socket.id !== r.gameData.drawerId) {
            if(d.text.trim().toLowerCase() === r.gameData.word.toLowerCase()) {
                if(!r.gameData.guessed.includes(socket.id)) {
                    r.gameData.guessed.push(socket.id); u.score+=100;
                    io.to(d.roomCode).emit('sys_msg', `🎉 ${u.username} guessed!`);
                    io.to(d.roomCode).emit('update_room', getRoomState(r));
                    if(r.gameData.guessed.length >= r.users.length-1) endTurn(d.roomCode, "All Guessed!");
                }
                return;
            }
        }
        io.to(d.roomCode).emit('chat_receive', {username:u.username, text:d.text, avatar:u.avatar});
        io.to(d.roomCode).emit('sfx', 'msg');
    });
    
    socket.on('draw_op', d => socket.to(d.roomCode).emit('draw_op', d));
    socket.on('clear', d => { if(rooms[d.roomCode]) io.to(d.roomCode).emit('clear_canvas'); });
    socket.on('undo', d => { if(rooms[d.roomCode]) io.to(d.roomCode).emit('undo'); }); 
    socket.on('word_select', d => handleWordSelection(d.roomCode, d.word));
    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));
    socket.on('disconnect', () => { /* cleanup logic omitted for brevity but maintained in practice */ });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
