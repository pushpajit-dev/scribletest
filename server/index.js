const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js error: Run 'npm install chess.js'"); }

const wordList = ["apple", "banana", "cherry", "dog", "cat", "house", "tree", "car", "robot"];

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const rooms = {}; 

function getRandomWords(count) { return wordList.sort(() => 0.5 - Math.random()).slice(0, count); }

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
            maskedWord: room.gameData.maskedWord
        }
    };
}

// Check Max Score Win
function checkSessionWin(roomCode) {
    const room = rooms[roomCode];
    if(!room) return false;
    const target = parseInt(room.settings.maxScore) || 10000;
    
    const winner = room.users.find(u => u.score >= target);
    if(winner) {
        room.state = "GAME_OVER";
        io.to(roomCode).emit('game_over_alert', {
            title: "🏆 GRAND WINNER!",
            msg: `${winner.username} hit ${target} pts!`,
            leaderboard: room.users
        });
        io.to(roomCode).emit('update_room', getRoomState(room));
        // Reset after delay
        setTimeout(() => {
            room.state = "LOBBY";
            room.users.forEach(u => u.score = 0);
            io.to(roomCode).emit('update_room', getRoomState(room));
        }, 8000);
        return true;
    }
    return false;
}

// --- GAME CLOCK LOOP ---
function startGameTimer(roomCode) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.mainInterval);
    
    room.gameData.mainInterval = setInterval(() => {
        // 1. Decrement Session Time (Top Left)
        if (room.gameData.timers.total > 0) room.gameData.timers.total--;
        
        // 2. Decrement Active Player Turn Time (Chess/TTT)
        const turn = room.gameData.turn; // 'w'/'b' or 'X'/'O'
        if (room.gameData.timers[turn] && room.gameData.timers[turn] > 0) {
            room.gameData.timers[turn]--;
        }

        // Broadcast Time Updates
        io.to(roomCode).emit('timer_sync', room.gameData.timers);

        // Check Expiry
        if (room.gameData.timers.total === 0) {
            clearInterval(room.gameData.mainInterval);
            io.to(roomCode).emit('game_over_alert', { title: "SESSION OVER", msg: "Time Limit Reached", leaderboard: room.users });
            room.state = "LOBBY";
            io.to(roomCode).emit('update_room', getRoomState(room));
        }
        
        // Check Turn Expiry (Chess)
        if (room.gameType === 'chess' && room.gameData.timers[turn] === 0) {
            endRound(roomCode, turn==='w'?'b':'w', "Timeout");
        }
    }, 1000);
}

function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room) return;
    room.state = "PLAYING";
    
    const p1 = room.users[0]; // Admin
    const p2 = room.users[1]; // Opponent

    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w';
    room.gameData.lastMoveTime = Date.now();
    
    // Admin Settings
    const adminIsWhite = room.settings.startColor === 'white';
    
    // Assign Roles
    if(room.settings.botMode || !p2) {
        room.gameData.players = { w: adminIsWhite?p1.id:'BOT', b: adminIsWhite?'BOT':p1.id };
    } else {
        room.gameData.players = { w: adminIsWhite?p1.id:p2.id, b: adminIsWhite?p2.id:p1.id };
    }

    // Initialize Timers
    const sessionT = parseInt(room.settings.time) || 1200;
    room.gameData.timers = { w: 600, b: 600, total: sessionT };

    io.to(roomCode).emit('update_room', getRoomState(room));
    io.to(roomCode).emit('sfx', 'start');
    startGameTimer(roomCode);
}

function endRound(roomCode, winnerColor, reason) {
    const room = rooms[roomCode];
    clearInterval(room.gameData.mainInterval);
    
    let wName = "Bot";
    if(winnerColor === 'draw') wName = "Draw";
    else {
        // Find winner based on color mapping
        let winId;
        if(room.gameType === 'chess') winId = room.gameData.players[winnerColor]; // 'w' or 'b'
        else winId = room.gameData.players[winnerColor]; // 'X' or 'O'

        const u = room.users.find(x => x.id === winId);
        if(u) {
            u.score += 100; 
            wName = u.username;
        }
    }

    if(checkSessionWin(roomCode)) return;

    io.to(roomCode).emit('game_over_alert', { title: "ROUND OVER", msg: `${wName} Wins! (${reason})`, leaderboard: room.users });
    setTimeout(() => {
        room.state = "LOBBY"; // Or next round logic
        io.to(roomCode).emit('update_room', getRoomState(room));
    }, 4000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        // Default settings
        const rSettings = { rounds: 3, time: 1200, maxScore: 10000, botMode: false, startColor: 'white', startSymbol: 'X', chessTheme: 'wikipedia' };
        
        // Init Game Data
        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, guessed: [] };
        else if (gameType === 'tictactoe') gd = { board: [], turn: 'X', round: 1 };
        else if (gameType === 'chess') gd = { fen: new Chess().fen(), round: 1, turn: 'w', timers: {}, players: {} };
        
        rooms[roomCode] = { name: `${username}'s Room`, adminId: socket.id, users: [], gameType, settings: rSettings, gameData: gd, state: "LOBBY" };
        socket.emit('room_created', roomCode);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if(!room) return socket.emit('error', "Room not found");
        const existing = room.users.find(u => u.id === socket.id);
        if(!existing) {
            room.users.push({ id: socket.id, username, avatar: avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${username}`, score: 0 });
            socket.join(roomCode);
        }
        io.to(roomCode).emit('update_room', getRoomState(room));
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            // Apply Admin Settings
            room.settings = { ...room.settings, ...settings };
            
            if(room.gameType === 'scribble') {
                // Scribble Start Logic (Abbreviated for focus on Chess/TTT)
                room.gameData.round = 1; room.gameData.drawerIdx = 0;
                startScribbleGame(roomCode); // Assuming fn exists
            } 
            else if (room.gameType === 'chess') {
                startChessGame(roomCode);
            } 
            else if (room.gameType === 'tictactoe') {
                room.state = "PLAYING";
                room.gameData.board = Array(9).fill(null);
                
                // Assign X and O
                const adminIsX = settings.startSymbol === 'X';
                const p1 = room.users[0], p2 = room.users[1];
                room.gameData.players = {
                    X: adminIsX ? p1.id : (p2 ? p2.id : 'BOT'),
                    O: adminIsX ? (p2 ? p2.id : 'BOT') : p1.id
                };
                room.gameData.turn = 'X';
                
                // Init Timer
                const st = parseInt(settings.time) || 1200;
                room.gameData.timers = { total: st, X: st, O: st }; // Players share session time or have moves? Assuming session.
                
                io.to(roomCode).emit('update_room', getRoomState(room));
                startGameTimer(roomCode);
            }
        }
    });

    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(!room || room.state !== 'PLAYING') return;
        
        const turn = room.gameData.turn; 
        const auth = room.gameData.players[turn];
        if(socket.id !== auth && auth !== 'BOT') return;

        const c = new Chess(room.gameData.fen);
        try {
            const m = c.move(move);
            if(m) {
                // Time Bonus Logic
                const now = Date.now();
                const diff = (now - room.gameData.lastMoveTime) / 1000;
                let pts = diff < 5 ? 10 : 2; // Bonus points
                const u = room.users.find(u => u.id === socket.id);
                if(u) u.score += pts;
                
                room.gameData.lastMoveTime = now;
                room.gameData.fen = c.fen();
                room.gameData.turn = c.turn();
                
                io.to(roomCode).emit('chess_move_update', { fen: room.gameData.fen, move: m });
                io.to(roomCode).emit('update_room', getRoomState(room)); // Update Score UI
                io.to(roomCode).emit('sfx', 'pop');

                if(c.isGameOver()) {
                    let winner = 'draw';
                    if(c.isCheckmate()) winner = turn;
                    endRound(roomCode, winner, "Checkmate");
                }
            }
        } catch(e) {}
    });

    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe') return;
        const turn = room.gameData.turn;
        const auth = room.gameData.players[turn];
        if(socket.id !== auth && auth !== 'BOT') return;
        if(room.gameData.board[index] !== null) return;

        room.gameData.board[index] = turn;
        
        // Check Win
        // Simple winning logic for 3x3
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        let winner = null;
        if(wins.some(c => c.every(i => room.gameData.board[i] === turn))) winner = turn;
        else if(room.gameData.board.every(c => c)) winner = 'draw';

        if(winner) {
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: turn });
            endRound(roomCode, winner, "Round Won");
        } else {
            room.gameData.turn = turn === 'X' ? 'O' : 'X';
            io.to(roomCode).emit('ttt_update', { board: room.gameData.board, index, sym: turn });
            io.to(roomCode).emit('update_room', getRoomState(room)); // Update Turn UI
        }
    });

    socket.on('chat_send', d => {
        const r = rooms[d.roomCode]; if(!r) return;
        // Restriction
        if((r.gameType==='chess' || r.gameType==='tictactoe') && r.state==='PLAYING') {
            if(Object.values(r.gameData.players).includes(socket.id)) return; 
        }
        const u = r.users.find(x=>x.id===socket.id);
        io.to(d.roomCode).emit('chat_receive', {username:u.username, text:d.text, avatar:u.avatar});
    });

    socket.on('send_reaction', d => io.to(d.roomCode).emit('show_reaction', d));
    
    // Scribble Specific Stub for compatibility
    function startScribbleGame(roomCode) { /* ... implementation from previous ... */ }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
