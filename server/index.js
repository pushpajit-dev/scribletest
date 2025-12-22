const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const wordList = require('./words'); // Ensure words.js exists

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// --- HELPERS ---
function getRandomWords(count) {
    let list = (wordList && wordList.length > 0) ? wordList : ["Apple", "Banana", "Cat", "Dog", "Sun", "Tree"];
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
    
    // 1. CREATE ROOM
    socket.on('create_room', ({ username, avatar, roomName, gameType, settings }) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        
        let data = {};
        if (gameType === 'scribble') {
            data = {
                timeLimit: parseInt(settings?.time) || 60,
                totalRounds: parseInt(settings?.rounds) || 3,
                round: 1, 
                drawerIdx: 0, 
                word: null, 
                drawerId: null, 
                guesses: [], 
                timer: null, 
                selectTimer: null, // Timer for picking a word
                drawHistory: [] 
            };
        } else if (gameType === 'tictactoe') {
            data = { board: Array(9).fill(null), turn: 0 };
        } else if (gameType === 'chess') {
            data = { fen: 'start', turn: 'w', wTime: 600, bTime: 600, timerInterval: null };
        }

        rooms[code] = {
            name: roomName,
            admin: socket.id,
            users: [],
            type: gameType,
            data: data,
            state: "LOBBY",
            votes: { restart: [] }
        };
        socket.emit('room_created', code);
    });

    // 2. JOIN ROOM
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'ROOM_NOT_FOUND'); return; }

        // Prevent duplicates
        const existing = room.users.find(u => u.id === socket.id);
        if (!existing) {
            room.users.push({ id: socket.id, username, avatar, score: 0 });
        }
        
        socket.join(roomCode);

        // Send update
        io.to(roomCode).emit('update_room', {
            roomName: room.name,
            users: room.users,
            admin: room.admin,
            type: room.type,
            state: room.state,
            data: room.data
        });

        // If joining mid-game in scribble, send history
        if(room.type === 'scribble' && room.state === "PLAYING") {
             socket.emit('draw_history', room.data.drawHistory);
        }
    });

    // --- ADMIN CONTROLS ---
    socket.on('admin_start_game', (code) => {
        const room = rooms[code];
        if (room && room.admin === socket.id) {
            if(room.type === 'scribble') {
                room.state = "PLAYING";
                room.users.forEach(u => u.score = 0);
                io.to(code).emit('game_started'); // Hides button
                startScribble(code);
            }
        }
    });

    socket.on('admin_stop_game', (code) => {
        const room = rooms[code];
        if (room && room.admin === socket.id) {
            room.state = "LOBBY";
            if(room.data.timer) clearInterval(room.data.timer);
            if(room.data.selectTimer) clearInterval(room.data.selectTimer);
            room.data.round = 1;
            
            io.to(code).emit('game_stopped'); // Show start button again
            io.to(code).emit('update_room', { ...room, state: "LOBBY" });
        }
    });

    // --- SCRIBBLE LOGIC ---
    function startScribble(code) {
        const room = rooms[code];
        
        // Check Game Over
        if (room.data.round > room.data.totalRounds) {
            const lb = [...room.users].sort((a,b) => b.score - a.score);
            io.to(code).emit('game_over', lb);
            room.state = "LOBBY";
            return;
        }

        const drawer = room.users[room.data.drawerIdx];
        room.data.drawerId = drawer.id;
        room.data.word = null;
        room.data.guesses = [];
        room.data.drawHistory = []; // Clear canvas

        io.to(code).emit('round_wait', { 
            drawer: drawer.username, 
            round: room.data.round, 
            total: room.data.totalRounds 
        });
        
        const words = getRandomWords(3);
        io.to(drawer.id).emit('choose_word', words);

        // 30 Second Selection Timer
        let selectTime = 30;
        if(room.data.selectTimer) clearInterval(room.data.selectTimer);
        
        room.data.selectTimer = setInterval(() => {
            selectTime--;
            io.to(drawer.id).emit('select_timer', selectTime); // Only drawer sees this
            if(selectTime <= 0) {
                clearInterval(room.data.selectTimer);
                // Auto pick first word
                if(!room.data.word) {
                    handleWordSelection(code, words[0]);
                }
            }
        }, 1000);
    }

    socket.on('word_selected', ({ roomCode, word }) => {
        handleWordSelection(roomCode, word);
    });

    function handleWordSelection(code, word) {
        const room = rooms[code];
        if(!room) return;
        
        clearInterval(room.data.selectTimer); // Stop selection timer
        room.data.word = word;
        const mask = word.replace(/[a-zA-Z]/g, '_ ');

        io.to(code).emit('round_start', { 
            drawerId: room.data.drawerId, mask, time: room.data.timeLimit 
        });

        // Game Timer
        let t = room.data.timeLimit;
        if(room.data.timer) clearInterval(room.data.timer);
        room.data.timer = setInterval(() => {
            t--;
            io.to(code).emit('timer', t);
            if(t <= 0) {
                clearInterval(room.data.timer);
                io.to(code).emit('sys_msg', `⏰ Time's up! Word: ${word}`);
                nextDrawer(code);
            }
        }, 1000);
    }

    function nextDrawer(code) {
        const room = rooms[code];
        room.data.drawerIdx++;
        if(room.data.drawerIdx >= room.users.length) {
            room.data.drawerIdx = 0;
            room.data.round++;
        }
        startScribble(code);
    }

    // --- DRAWING ---
    socket.on('draw', (d) => {
        const room = rooms[d.roomCode];
        if(room && room.type === 'scribble' && room.state === "PLAYING") {
            if(d.t === 'clear') room.data.drawHistory = [];
            else room.data.drawHistory.push(d);
            
            socket.to(d.roomCode).emit('draw', d);
        }
    });

    // Handle Client Requesting History (Fixes Resize Issue)
    socket.on('request_history', (code) => {
        const room = rooms[code];
        if(room && room.data.drawHistory) {
            socket.emit('draw_history', room.data.drawHistory);
        }
    });

    // --- CHAT ---
    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const user = room.users.find(u => u.id === socket.id);
        
        // Check Guess
        if (room.type === 'scribble' && room.state === "PLAYING" && room.data.word) {
            if (message.toLowerCase() === room.data.word.toLowerCase()) {
                 // Correct Guess Logic
                 if (socket.id !== room.data.drawerId && !room.data.guesses.includes(socket.id)) {
                    room.data.guesses.push(socket.id);
                    user.score += 100;
                    io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed it!`);
                    io.to(roomCode).emit('update_users', room.users);
                    
                    if (room.data.guesses.length >= room.users.length - 1) {
                        clearInterval(room.data.timer);
                        nextDrawer(roomCode);
                    }
                 }
                 return; // Hide word
            }
        }
        io.to(roomCode).emit('receive_message', { username: user.username, message });
    });

    // --- TIC TAC TOE ---
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        const turnIdx = room.data.turn % 2;
        if(room.users[turnIdx].id !== socket.id) return; // Wrong turn
        if(room.data.board[index]) return; // Taken

        room.data.board[index] = (turnIdx === 0) ? 'X' : 'O';
        const win = checkTicTacToeWin(room.data.board);
        
        if(win) {
            io.to(roomCode).emit('ttt_update', { board: room.data.board, turn: room.data.turn });
            const msg = win === 'draw' ? "Draw!" : `${room.users[turnIdx].username} Won!`;
            io.to(roomCode).emit('sys_msg', msg);
            setTimeout(() => {
                room.data.board = Array(9).fill(null);
                room.data.turn = 0;
                io.to(roomCode).emit('ttt_update', { board: room.data.board, turn: 0 });
            }, 3000);
        } else {
            room.data.turn++;
            io.to(roomCode).emit('ttt_update', { board: room.data.board, turn: room.data.turn });
        }
    });

    socket.on('disconnect', () => { /* Cleanup logic */ });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
