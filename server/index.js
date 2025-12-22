const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const wordList = require('./words');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

function getRandomWords(count, difficulty) {
    let list = (wordList && wordList.length > 0) ? wordList : ["Cat", "Dog", "Sun", "Tree", "House", "Car", "Book", "Phone"];
    if (difficulty === 'hard') list = list.filter(w => w.length > 5);
    else if (difficulty === 'easy') list = list.filter(w => w.length <= 5);
    return list.sort(() => 0.5 - Math.random()).slice(0, count);
}

function checkTicTacToeWin(board) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (let l of lines) {
        if (board[l[0]] && board[l[0]] === board[l[1]] && board[l[0]] === board[l[2]]) return board[l[0]];
    }
    return board.includes(null) ? null : 'draw';
}

io.on('connection', (socket) => {
    
    // --- ROOM MANAGEMENT ---
    socket.on('check_room', (code, cb) => cb(!!rooms[code]));

    socket.on('create_room', ({ username, avatar, roomName, gameType, settings }) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Initialize Game Data based on Type
        let data = {};
        if (gameType === 'scribble') {
            data = {
                timeLimit: parseInt(settings?.time) || 60,
                totalRounds: parseInt(settings?.rounds) || 3,
                difficulty: settings?.difficulty || 'mixed',
                round: 1, drawerIdx: 0, word: null, drawerId: null, 
                guesses: [], timer: null, 
                drawHistory: [], // Stores strokes for Redraw/Undo
                redoStack: []
            };
        } else if (gameType === 'chess') {
            data = { 
                fen: 'start', 
                turn: 'w', 
                white: null, black: null, 
                wTime: 600, bTime: 600, // 10 mins default
                timerInterval: null
            };
        } else if (gameType === 'tictactoe') {
            data = { board: Array(9).fill(null), turn: 0 };
        }

        rooms[code] = {
            name: roomName,
            admin: socket.id,
            users: [],
            type: gameType,
            data: data,
            state: "LOBBY",
            votes: { restart: [] } // For voting
        };
        socket.emit('room_created', code);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'ROOM_NOT_FOUND'); return; }

        const user = { id: socket.id, username, avatar, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        // Notify everyone
        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            admin: room.admin,
            type: room.type,
            state: room.state,
            data: cleanDataForClient(room)
        });

        // Send Draw History to new user (so canvas isn't empty)
        if (room.type === 'scribble' && room.state === "PLAYING") {
             socket.emit('draw_history', room.data.drawHistory);
        }
    });

    // --- ADMIN CONTROLS ---
    socket.on('admin_stop_game', (code) => {
        const room = rooms[code];
        if (room && room.admin === socket.id) {
            room.state = "LOBBY";
            // Reset crucial data
            if(room.type === 'scribble') {
                clearInterval(room.data.timer);
                room.data.round = 1;
                room.data.drawerIdx = 0;
            } else if (room.type === 'chess') {
                clearInterval(room.data.timerInterval);
            }
            io.to(code).emit('stop_game_confirmed');
            io.to(code).emit('update_room', { ...room, data: cleanDataForClient(room) });
        }
    });

    socket.on('admin_update_settings', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.admin === socket.id && room.type === 'scribble') {
            room.data.timeLimit = parseInt(settings.time);
            room.data.totalRounds = parseInt(settings.rounds);
            room.data.difficulty = settings.difficulty;
            io.to(roomCode).emit('sys_msg', "🛠 Admin updated game settings.");
        }
    });

    // --- VOTING ---
    socket.on('vote_restart', (code) => {
        const room = rooms[code];
        if(!room) return;
        if(!room.votes.restart.includes(socket.id)) {
            room.votes.restart.push(socket.id);
            io.to(code).emit('sys_msg', `${getUn(room, socket.id)} voted to restart (${room.votes.restart.length}/${room.users.length})`);
            
            // Majority Vote
            if(room.votes.restart.length > room.users.length / 2) {
                io.to(code).emit('sys_msg', "🔄 Vote passed! Restarting game...");
                restartGame(code);
            }
        }
    });

    function restartGame(code) {
        const room = rooms[code];
        room.votes.restart = [];
        room.users.forEach(u => u.score = 0);
        
        if(room.type === 'scribble') {
            clearInterval(room.data.timer);
            room.data.round = 1; room.data.drawerIdx = 0;
            room.data.drawHistory = [];
            startScribble(code);
        } else if (room.type === 'chess') {
            clearInterval(room.data.timerInterval);
            room.data.fen = 'start';
            room.data.wTime = 600; room.data.bTime = 600;
            io.to(code).emit('chess_reset');
        } else if (room.type === 'tictactoe') {
            room.data.board = Array(9).fill(null);
            io.to(code).emit('ttt_update', { board: room.data.board, turn: 0 });
        }
    }

    // --- SCRIBBLE LOGIC ---
    socket.on('scribble_start', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.admin === socket.id) {
            room.state = "PLAYING";
            room.users.forEach(u => u.score = 0);
            startScribble(roomCode);
        }
    });

    function startScribble(code) {
        const room = rooms[code];
        if (room.data.round > room.data.totalRounds) {
            // Game Over
            const lb = [...room.users].sort((a,b) => b.score - a.score);
            io.to(code).emit('game_over', lb);
            room.state = "LOBBY";
            return;
        }

        const drawer = room.users[room.data.drawerIdx];
        room.data.drawerId = drawer.id;
        room.data.word = null;
        room.data.guesses = [];
        room.data.drawHistory = []; // Clear board for new round
        room.data.redoStack = [];

        io.to(code).emit('round_wait', { 
            drawer: drawer.username, 
            round: room.data.round, 
            total: room.data.totalRounds 
        });
        
        const words = getRandomWords(3, room.data.difficulty);
        io.to(drawer.id).emit('choose_word', words);
    }

    socket.on('word_selected', ({ roomCode, word }) => {
        const room = rooms[roomCode];
        room.data.word = word;
        const mask = word.replace(/[a-zA-Z]/g, '_ ');

        io.to(roomCode).emit('round_start', { 
            drawerId: room.data.drawerId, mask, time: room.data.timeLimit 
        });

        let t = room.data.timeLimit;
        clearInterval(room.data.timer);
        room.data.timer = setInterval(() => {
            t--;
            io.to(roomCode).emit('timer', t);
            if(t <= 0) {
                clearInterval(room.data.timer);
                io.to(roomCode).emit('sys_msg', `⏰ Time's up! Word: ${word}`);
                nextDrawer(roomCode);
            }
        }, 1000);
    });

    function nextDrawer(code) {
        const room = rooms[code];
        room.data.drawerIdx++;
        if(room.data.drawerIdx >= room.users.length) {
            room.data.drawerIdx = 0;
            room.data.round++;
        }
        startScribble(code);
    }

    // --- DRAWING: HISTORY, UNDO, REDO ---
    socket.on('draw', (d) => {
        const room = rooms[d.roomCode];
        if(room && room.data.currentDrawerId === socket.id) return; // Basic validation check
        
        // Save to history
        if(room && room.type === 'scribble') {
            if(d.t === 'clear') room.data.drawHistory = [];
            else room.data.drawHistory.push(d);
            
            socket.to(d.roomCode).emit('draw', d);
        }
    });

    socket.on('undo_draw', (code) => {
        const room = rooms[code];
        if(room && room.data.drawHistory.length > 0) {
            // Remove last stroke (series of points between start and end)
            // Simple logic: remove everything after the last 'start'
            let history = room.data.drawHistory;
            let lastStartIdx = -1;
            for(let i = history.length - 1; i >= 0; i--) {
                if(history[i].t === 'start') { lastStartIdx = i; break; }
            }
            if(lastStartIdx !== -1) {
                const removed = history.splice(lastStartIdx);
                room.data.redoStack.push(removed);
                // Send FULL history to clients to redraw safely
                io.to(code).emit('draw_history', room.data.drawHistory);
            }
        }
    });

    // --- CHESS LOGIC ---
    socket.on('chess_start', ({ roomCode, side }) => { // side: 'w', 'b', 'rand'
        const room = rooms[roomCode];
        if(!room || room.users.length < 2) return;

        let p1 = room.users[0];
        let p2 = room.users[1];

        if(side === 'rand') side = Math.random() < 0.5 ? 'w' : 'b';
        
        room.data.white = (side === 'w') ? p1.id : p2.id;
        room.data.black = (side === 'w') ? p2.id : p1.id;
        
        room.state = "PLAYING";
        startChessTimer(roomCode);

        io.to(roomCode).emit('chess_init', { 
            white: room.data.white, 
            black: room.data.black,
            wTime: room.data.wTime,
            bTime: room.data.bTime
        });
    });

    socket.on('chess_move', ({ roomCode, move, fen }) => {
        const room = rooms[roomCode];
        socket.to(roomCode).emit('chess_move', move);
        
        room.data.fen = fen;
        room.data.turn = (room.data.turn === 'w') ? 'b' : 'w';
        
        // Reset Timer Interval for new turn
        startChessTimer(roomCode);
    });

    function startChessTimer(code) {
        const room = rooms[code];
        clearInterval(room.data.timerInterval);
        
        room.data.timerInterval = setInterval(() => {
            if(room.data.turn === 'w') room.data.wTime--;
            else room.data.bTime--;

            if(room.data.wTime <= 0 || room.data.bTime <= 0) {
                clearInterval(room.data.timerInterval);
                const winner = (room.data.wTime <= 0) ? 'Black' : 'White';
                io.to(code).emit('chess_game_over', { winner });
            }

            // Sync every second
            io.to(code).emit('chess_timer', { w: room.data.wTime, b: room.data.bTime });
        }, 1000);
    }

    // --- EMOJI REACTIONS ---
    socket.on('send_reaction', ({ roomCode, emoji }) => {
        const room = rooms[roomCode];
        const user = room.users.find(u => u.id === socket.id);
        io.to(roomCode).emit('show_reaction', { userId: socket.id, emoji, username: user.username });
    });

    // --- CLEANUP ---
    function getUn(r, id) { return r.users.find(u=>u.id===id)?.username || 'User'; }
    function cleanDataForClient(r) { return r.data; } // Can sanitize if needed
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
