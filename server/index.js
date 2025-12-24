const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Robust Chess Import
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) {
    console.error("⚠️ Chess.js error. Run: npm install chess.js");
}

// Word list fallback
let wordList = [
    "apple", "banana", "cat", "dog", "house", "tree", "car", "robot", "space", 
    "rocket", "guitar", "monster", "pizza", "ice cream", "book", "phone"
];
try {
    const imported = require('./words');
    if(imported && Array.isArray(imported)) wordList = imported;
} catch (e) {}

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// --- HELPERS ---

function getRoomData(room) {
    // Players 0 and 1 are active for Chess/TTT. Others are spectators.
    // For Scribble, everyone plays.
    let spectators = [];
    if (room.gameType !== 'scribble' && room.users.length > 2) {
        spectators = room.users.slice(2);
    }

    return {
        roomName: room.name,
        users: room.users,
        spectators: spectators,
        adminId: room.adminId,
        gameType: room.gameType,
        state: room.state,
        settings: room.settings,
        drawerId: room.gameData?.currentDrawerId || null,
        roundInfo: room.gameData ? { 
            round: room.gameData.currentRound, 
            total: room.settings.rounds,
            turn: room.gameData.drawerIndex + 1
        } : null,
        boardData: (room.gameType === 'tictactoe') ? room.gameData.board : 
                   (room.gameType === 'chess') ? room.gameData.fen : null
    };
}

function getRandomWords(count = 3) {
    const shuffled = wordList.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id;
        io.to(roomCode).emit('update_room', getRoomData(room));
        io.to(roomCode).emit('sys_msg', `👑 ${room.users[0].username} is now Admin.`);
    }
}

// --- GAME LOGIC ---

function startScribbleRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.gameData.currentRound > parseInt(room.settings.rounds)) {
        endScribbleGame(roomCode);
        return;
    }

    const drawer = room.users[room.gameData.drawerIndex];
    if (!drawer) {
        room.gameData.drawerIndex = 0;
        room.gameData.currentRound++;
        startScribbleRound(roomCode);
        return;
    }

    room.gameData.currentDrawerId = drawer.id;
    room.state = "SELECTING_WORD";
    room.gameData.drawHistory = [];
    room.gameData.guessedUsers = [];
    room.gameData.currentWord = null;
    
    // Broadcast state
    io.to(roomCode).emit('update_room', getRoomData(room));
    io.to(roomCode).emit('clear_canvas');
    io.to(roomCode).emit('scribble_state', { 
        state: 'SELECTING', 
        drawerId: drawer.id, 
        drawerName: drawer.username 
    });

    // Send options to drawer
    const words = getRandomWords(3);
    io.to(drawer.id).emit('pick_word', { words, time: 20 });

    let selectTime = 20;
    clearInterval(room.gameData.timer);
    room.gameData.timer = setInterval(() => {
        selectTime--;
        io.to(roomCode).emit('timer_tick', selectTime);
        if (selectTime <= 0) {
            handleWordSelect(roomCode, words[0]); 
        }
    }, 1000);
}

function handleWordSelect(roomCode, word) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.gameData.timer);

    room.gameData.currentWord = word;
    room.gameData.maskedWord = word.replace(/[a-zA-Z]/g, '_'); 
    room.state = "PLAYING";
    const drawTime = parseInt(room.settings.time);
    
    io.to(roomCode).emit('scribble_state', {
        state: 'DRAWING',
        drawerId: room.gameData.currentDrawerId,
        maskedWord: room.gameData.maskedWord,
        time: drawTime
    });

    io.to(room.gameData.currentDrawerId).emit('drawer_secret', { word });

    let timeLeft = drawTime;
    room.gameData.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timer_tick', timeLeft);
        
        // Hints
        if (timeLeft === Math.floor(drawTime * 0.5)) {
             revealHint(roomCode);
        }

        if (timeLeft <= 0) {
             endScribbleTurn(roomCode, "Time's Up!");
        }
    }, 1000);
}

function revealHint(roomCode) {
    const room = rooms[roomCode];
    const word = room.gameData.currentWord;
    const mask = room.gameData.maskedWord.split('');
    const hiddenIdx = [];
    mask.forEach((c, i) => { if(c === '_') hiddenIdx.push(i); });
    
    if (hiddenIdx.length > 0) {
        const i = hiddenIdx[Math.floor(Math.random() * hiddenIdx.length)];
        mask[i] = word[i];
        room.gameData.maskedWord = mask.join('');
        io.to(roomCode).emit('update_mask', room.gameData.maskedWord);
    }
}

function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.gameData.timer);

    io.to(roomCode).emit('scribble_end_turn', {
        reason: reason,
        word: room.gameData.currentWord,
        scores: room.users
    });

    let wait = 8;
    room.state = "INTERMISSION";
    const intTimer = setInterval(() => {
        wait--;
        if (wait <= 0) {
            clearInterval(intTimer);
            room.gameData.drawerIndex++;
            if (room.gameData.drawerIndex >= room.users.length) {
                room.gameData.drawerIndex = 0;
                room.gameData.currentRound++;
            }
            startScribbleRound(roomCode);
        }
    }, 1000);
}

function endScribbleGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('game_over', { leaderboard: room.users.sort((a,b)=>b.score-a.score) });
    room.state = "LOBBY";
    io.to(roomCode).emit('update_room', getRoomData(room));
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('create_room', ({ username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        let gd = {};
        if (gameType === 'scribble') gd = { currentRound: 1, drawerIndex: 0, drawHistory: [], guessedUsers: [] };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen() };
        else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X' };

        rooms[roomCode] = {
            name: `${username}'s Room`,
            adminId: socket.id,
            users: [],
            gameType,
            settings: settings || { rounds: 3, time: 60 },
            gameData: gd,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        
        // Ensure avatar is never undefined
        const safeAvatar = avatar || `https://api.dicebear.com/9.x/bottts/svg?seed=${username}`;
        
        const existing = room.users.find(u => u.id === socket.id);
        if (!existing) {
            room.users.push({ id: socket.id, username, avatar: safeAvatar, score: 0 });
            socket.join(roomCode);
        }

        io.to(roomCode).emit('update_room', getRoomData(room));
        io.to(roomCode).emit('sys_msg', `${username} joined!`);

        // Send drawing history to late joiner
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            socket.emit('canvas_history', room.gameData.drawHistory);
            socket.emit('scribble_state', {
                state: 'DRAWING',
                drawerId: room.gameData.currentDrawerId,
                maskedWord: room.gameData.maskedWord,
                time: room.settings.time
            });
        }
    });

    socket.on('start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            if(room.gameType === 'scribble') startScribbleRound(roomCode);
            else {
                room.state = "PLAYING";
                io.to(roomCode).emit('update_room', getRoomData(room));
                io.to(roomCode).emit('sys_msg', "Game Started!");
            }
        }
    });

    // --- DRAWING ---
    socket.on('draw_line', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        
        // Store for history
        if (data.type === 'start') {
             room.gameData.currentStroke = { color: data.color, width: data.width, points: [{x: data.x, y: data.y}] };
        } else if (data.type === 'move' && room.gameData.currentStroke) {
             room.gameData.currentStroke.points.push({x: data.x, y: data.y});
        } else if (data.type === 'end' && room.gameData.currentStroke) {
             room.gameData.drawHistory.push(room.gameData.currentStroke);
             room.gameData.currentStroke = null;
        }
        
        // Broadcast
        socket.to(data.roomCode).emit('draw_line', data);
    });

    socket.on('undo', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.gameData.drawHistory.length > 0) {
            room.gameData.drawHistory.pop();
            io.to(roomCode).emit('canvas_history', room.gameData.drawHistory);
        }
    });

    socket.on('clear', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room) {
            room.gameData.drawHistory = [];
            io.to(roomCode).emit('clear_canvas');
        }
    });

    socket.on('word_select', ({ roomCode, word }) => handleWordSelect(roomCode, word));

    // --- CHAT (Fixed event name: chat_msg) ---
    socket.on('chat_msg', ({ roomCode, text }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user) return;

        // Guess Logic
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            if (socket.id !== room.gameData.currentDrawerId) {
                if (text.trim().toLowerCase() === room.gameData.currentWord.toLowerCase()) {
                    if (!room.gameData.guessedUsers.includes(socket.id)) {
                        user.score += 100;
                        const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                        if(drawer) drawer.score += 25; 

                        room.gameData.guessedUsers.push(socket.id);
                        io.to(roomCode).emit('sys_msg', `🎉 ${user.username} guessed it!`);
                        io.to(roomCode).emit('update_room', getRoomData(room));
                        
                        if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                            endScribbleTurn(roomCode, "Everyone Guessed!");
                        }
                        return;
                    }
                }
            }
        }
        // Broadcast
        io.to(roomCode).emit('chat_msg', { username: user.username, avatar: user.avatar, text: text });
    });

    socket.on('send_reaction', ({ roomCode, emoji }) => io.to(roomCode).emit('show_reaction', { emoji }));

    // Chess
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(room && Chess) {
            const game = new Chess(room.gameData.fen);
            try {
                if (game.move(move)) {
                    room.gameData.fen = game.fen();
                    io.to(roomCode).emit('chess_state', room.gameData.fen);
                }
            } catch(e){}
        }
    });

    // TTT
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(room && room.gameType === 'tictactoe') {
            if(room.gameData.board[index] === null) {
                room.gameData.board[index] = room.gameData.turn;
                io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
                room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
            }
        }
    });

    socket.on('disconnect', () => {
        for(const c in rooms) {
            const r = rooms[c];
            const i = r.users.findIndex(u=>u.id===socket.id);
            if(i!==-1) {
                r.users.splice(i,1);
                if(r.users.length===0) delete rooms[c];
                else {
                    if(r.adminId===socket.id) assignNextAdmin(c);
                    io.to(c).emit('update_room', getRoomData(r));
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
