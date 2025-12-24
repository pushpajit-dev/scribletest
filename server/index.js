const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Safe Chess Import
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) {
    console.error("⚠️ Chess.js error. Run: npm install chess.js");
}

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

const WORDS = {
    easy: ["sun", "cat", "dog", "cup", "hat", "car", "bus", "tree", "book", "key", "star", "moon", "fish", "apple", "box"],
    medium: ["planet", "guitar", "jungle", "doctor", "police", "turtle", "robot", "circus", "bottle", "window", "ghost", "snake"],
    hard: ["electricity", "philosophy", "orchestra", "cathedral", "hemisphere", "kaleidoscope", "lighthouse", "volcano"]
};

// --- HELPER FUNCTIONS ---

function getRoomData(room) {
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

function getRandomWords(complexity, count = 3) {
    const list = WORDS[complexity] || WORDS['easy'];
    return list.sort(() => 0.5 - Math.random()).slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id;
        io.to(roomCode).emit('update_room', getRoomData(room));
        io.to(roomCode).emit('system_message', { text: `👑 ${room.users[0].username} is now Admin.`, type: 'sys' });
    }
}

function checkTTTWin(board) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for(let w of wins) {
        if(board[w[0]] && board[w[0]] === board[w[1]] && board[w[0]] === board[w[2]]) return board[w[0]];
    }
    if (board.every(c => c !== null)) return 'DRAW';
    return null;
}

// --- GAME LOOPS ---

function startScribbleRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.gameData.currentRound > parseInt(room.settings.rounds)) {
        endScribbleGame(roomCode);
        return;
    }

    const drawer = room.users[room.gameData.drawerIndex];
    // Safety check if user left
    if(!drawer) {
        room.gameData.drawerIndex = 0;
        room.gameData.currentRound++;
        startScribbleRound(roomCode);
        return;
    }

    room.gameData.currentDrawerId = drawer.id;
    room.state = "SELECTING_WORD";
    
    // Reset Turn Data
    room.gameData.drawHistory = [];
    room.gameData.guessedUsers = [];
    room.gameData.currentWord = null;
    
    io.to(roomCode).emit('update_room', getRoomData(room));
    io.to(roomCode).emit('clear_canvas');
    io.to(roomCode).emit('scribble_state', { 
        state: 'SELECTING', 
        drawerId: drawer.id, 
        drawerName: drawer.username 
    });

    const words = getRandomWords(room.settings.complexity);
    io.to(drawer.id).emit('pick_word', { words, time: 30 });

    let selectTime = 30;
    clearInterval(room.gameData.timer);
    room.gameData.timer = setInterval(() => {
        selectTime--;
        io.to(roomCode).emit('timer_tick', selectTime);
        if (selectTime <= 0) {
            handleWordSelect(roomCode, words[0]); // Auto-pick
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
    
    // Notify Room
    io.to(roomCode).emit('scribble_state', {
        state: 'DRAWING',
        drawerId: room.gameData.currentDrawerId,
        maskedWord: room.gameData.maskedWord,
        time: drawTime
    });

    // Notify Drawer specifically
    io.to(room.gameData.currentDrawerId).emit('drawer_secret', { word });

    let timeLeft = drawTime;
    room.gameData.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timer_tick', timeLeft);

        if ((timeLeft === Math.floor(drawTime * 0.75) || timeLeft === Math.floor(drawTime * 0.4))) {
             revealHint(roomCode);
        }

        if (timeLeft <= 0) {
            if (room.settings.scoringMode === 'negative' && room.gameData.guessedUsers.length === 0) {
                 const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                 if(drawer) drawer.score = Math.max(0, drawer.score - 50);
            }
            endScribbleTurn(roomCode, "Time's Up!");
        }
    }, 1000);
}

function revealHint(roomCode) {
    const room = rooms[roomCode];
    const word = room.gameData.currentWord;
    const mask = room.gameData.maskedWord.split('');
    const hiddenIdx = [];
    mask.forEach((char, i) => { if(char === '_') hiddenIdx.push(i); });
    
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
            settings: settings || { rounds: 3, time: 60, complexity: 'easy' },
            gameData: gd,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        
        const user = { id: socket.id, username, avatar, score: 0 };
        room.users.push(user);
        socket.join(roomCode);
        
        io.to(roomCode).emit('update_room', getRoomData(room));
        io.to(roomCode).emit('system_message', { text: `${username} joined!`, type: 'sys' });
        
        // Late Joiner Sync - Send current drawing immediately
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
            if (room.gameType === 'scribble') startScribbleRound(roomCode);
            else {
                room.state = "PLAYING";
                io.to(roomCode).emit('update_room', getRoomData(room));
                io.to(roomCode).emit('system_message', { text: "Game Started!", type: 'sys' });
            }
        }
    });

    // --- DRAWING ENGINE (Fixed) ---
    socket.on('draw_op', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;

        if (data.op === 'start') {
            room.gameData.currentStroke = { color: data.color, width: data.width, points: [{x: data.x, y: data.y}] };
        } else if (data.op === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({x: data.x, y: data.y});
        } else if (data.op === 'end' && room.gameData.currentStroke) {
            room.gameData.drawHistory.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }
        socket.to(data.roomCode).emit('draw_op', data);
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

    // --- CHAT (Fixed Event Names) ---
    socket.on('chat_message', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user) return;

        // Scribble Guess
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            if (socket.id === room.gameData.currentDrawerId) return; 
            
            if (message.trim().toLowerCase() === room.gameData.currentWord.toLowerCase()) {
                if (!room.gameData.guessedUsers.includes(socket.id)) {
                    const points = Math.max(50, 100 - (room.gameData.guessedUsers.length * 20));
                    user.score += points;
                    
                    const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                    if(drawer) drawer.score += 25; 

                    room.gameData.guessedUsers.push(socket.id);
                    io.to(roomCode).emit('system_message', { text: `🎉 ${user.username} guessed it! (+${points})`, type: 'correct' });
                    io.to(roomCode).emit('update_room', getRoomData(room));
                    
                    if (room.gameData.guessedUsers.length >= room.users.length - 1) {
                        endScribbleTurn(roomCode, "Everyone Guessed!");
                    }
                    return;
                }
            }
        }
        // Send actual text message
        io.to(roomCode).emit('chat_message', { username: user.username, avatar: user.avatar, text: message });
    });

    socket.on('typing_start', ({ roomCode }) => socket.to(roomCode).emit('user_typing', { id: socket.id, typing: true }));
    socket.on('typing_stop', ({ roomCode }) => socket.to(roomCode).emit('user_typing', { id: socket.id, typing: false }));
    socket.on('send_reaction', ({ roomCode, emoji }) => io.to(roomCode).emit('show_reaction', { emoji }));

    // Chess Move
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(room && Chess) {
            const game = new Chess(room.gameData.fen);
            if (game.move(move)) {
                room.gameData.fen = game.fen();
                io.to(roomCode).emit('chess_state', room.gameData.fen);
            }
        }
    });

    // TTT Move
    socket.on('ttt_move', ({ roomCode, index }) => {
        const room = rooms[roomCode];
        if(room && room.gameType === 'tictactoe') {
            if(room.gameData.board[index] === null) {
                room.gameData.board[index] = room.gameData.turn;
                io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
                
                const win = checkTTTWin(room.gameData.board);
                if(win) {
                    io.to(roomCode).emit('system_message', { text: win==='DRAW'?"It's a Draw!":`${win} Wins!`, type: 'sys' });
                    setTimeout(() => {
                        room.gameData.board = Array(9).fill(null);
                        io.to(roomCode).emit('ttt_update', { board: room.gameData.board });
                    }, 3000);
                } else {
                    room.gameData.turn = room.gameData.turn === 'X' ? 'O' : 'X';
                }
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
