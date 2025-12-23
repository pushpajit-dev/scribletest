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

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {}; 

// Word Database
const WORDS = {
    easy: ["sun", "cat", "dog", "cup", "hat", "car", "bus", "tree", "book", "key", "star", "moon"],
    medium: ["planet", "guitar", "jungle", "doctor", "police", "turtle", "robot", "circus", "bottle", "window"],
    hard: ["electricity", "philosophy", "orchestra", "cathedral", "hemisphere", "kaleidoscope", "lighthouse"]
};

// --- HELPER FUNCTIONS ---

function getRoomPublicData(room) {
    // Determine spectators for Chess/TTT (everyone after the first 2 players)
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
        // Send board data for TTT/Chess
        boardData: (room.gameType === 'tictactoe') ? room.gameData.board : 
                   (room.gameType === 'chess') ? room.gameData.fen : null
    };
}

function getRandomWords(complexity = 'easy', count = 3) {
    const list = WORDS[complexity] || WORDS['easy'];
    return list.sort(() => 0.5 - Math.random()).slice(0, count);
}

function assignNextAdmin(roomCode) {
    const room = rooms[roomCode];
    if (room && room.users.length > 0) {
        room.adminId = room.users[0].id;
        io.to(roomCode).emit('update_room', getRoomPublicData(room));
    }
}

// --- CHESS BOT LOGIC ---
function makeBotMove(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameType !== 'chess' || !Chess) return;

    const game = new Chess(room.gameData.fen);
    const moves = game.moves();
    
    if (moves.length > 0) {
        // Simple random move (Stockfish integration requires external engine, this is JS logic)
        const move = moves[Math.floor(Math.random() * moves.length)];
        game.move(move);
        room.gameData.fen = game.fen();
        
        // Delay slightly for realism
        setTimeout(() => {
            io.to(roomCode).emit('chess_state', room.gameData.fen);
            io.to(roomCode).emit('system_message', { text: "🤖 Bot made a move.", type: 'sys' });
        }, 1000);
    }
}

// --- SCRIBBLE GAME LOOP ---

function startScribbleTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Check Game Over (Rounds or Score Limit)
    const maxRounds = parseInt(room.settings.rounds);
    const targetScore = parseInt(room.settings.targetScore) || 9999;
    const topPlayer = room.users.sort((a,b) => b.score - a.score)[0];

    if (room.gameData.currentRound > maxRounds || (topPlayer && topPlayer.score >= targetScore)) {
        endScribbleGame(roomCode);
        return;
    }

    const drawer = room.users[room.gameData.drawerIndex];
    room.gameData.currentDrawerId = drawer.id;
    room.state = "SELECTING_WORD";
    
    // Reset Round Data
    room.gameData.drawHistory = [];
    room.gameData.guessedUsers = [];
    room.gameData.currentWord = null;
    
    // Notify
    io.to(roomCode).emit('update_room', getRoomPublicData(room));
    io.to(roomCode).emit('clear_canvas');
    io.to(roomCode).emit('scribble_state_change', { 
        state: 'SELECTING', 
        drawer: drawer.username,
        drawerId: drawer.id
    });

    const words = getRandomWords(room.settings.complexity);
    io.to(drawer.id).emit('scribble_your_turn_pick', { words, time: 20 });

    // Selection Timer
    let selectionTime = 20;
    clearInterval(room.gameData.timer);
    
    room.gameData.timer = setInterval(() => {
        selectionTime--;
        io.to(roomCode).emit('timer_update', selectionTime);
        if (selectionTime <= 0) {
            clearInterval(room.gameData.timer);
            handleWordSelection(roomCode, words[0]); // Auto-pick
        }
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.gameData.timer);

    room.gameData.currentWord = word;
    room.gameData.maskedWord = word.replace(/[a-zA-Z]/g, '_'); 
    room.state = "PLAYING";

    const drawTime = parseInt(room.settings.time) || 60;
    
    // Notify everyone (Drawer sees word, others see mask)
    room.users.forEach(u => {
        const isDrawer = u.id === room.gameData.currentDrawerId;
        io.to(u.id).emit('scribble_state_change', {
            state: 'DRAWING',
            drawerId: room.gameData.currentDrawerId,
            maskedWord: isDrawer ? word : room.gameData.maskedWord, // Drawer sees word immediately
            wordLength: word.length,
            time: drawTime
        });
    });

    // Start Timer
    let timeLeft = drawTime;
    room.gameData.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timer_update', timeLeft);

        // Hints
        if ((timeLeft === Math.floor(drawTime * 0.75) || timeLeft === Math.floor(drawTime * 0.4))) {
             revealHint(roomCode);
        }

        if (timeLeft <= 0) {
            // Negative scoring if no one guessed?
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
    let mask = room.gameData.maskedWord.split('');
    const indices = [];
    for(let i=0; i<mask.length; i++) if(mask[i] === '_') indices.push(i);
    
    if (indices.length > 0) {
        const idx = indices[Math.floor(Math.random() * indices.length)];
        mask[idx] = word[idx];
        room.gameData.maskedWord = mask.join('');
        io.to(roomCode).emit('update_mask', room.gameData.maskedWord);
    }
}

function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.gameData.timer);

    // Leaderboard logic
    io.to(roomCode).emit('scribble_turn_end', {
        word: room.gameData.currentWord,
        reason: reason,
        scores: room.users.map(u => ({ username: u.username, score: u.score, avatar: u.avatar }))
    });

    room.state = "INTERMISSION";
    let intermission = 8; // 8 seconds leaderboard
    
    const intTimer = setInterval(() => {
        intermission--;
        if (intermission <= 0) {
            clearInterval(intTimer);
            room.gameData.drawerIndex++;
            if (room.gameData.drawerIndex >= room.users.length) {
                room.gameData.drawerIndex = 0;
                room.gameData.currentRound++;
            }
            startScribbleTurn(roomCode);
        }
    }, 1000);
}

function endScribbleGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const leaderboard = room.users.sort((a,b) => b.score - a.score);
    io.to(roomCode).emit('game_over', { leaderboard });
    room.state = "LOBBY";
    io.to(roomCode).emit('update_room', getRoomPublicData(room));
}


io.on('connection', (socket) => {
    
    // --- ROOM CREATION ---
    socket.on('create_room', ({ username, avatar, gameType, settings }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        
        let initialGameData = {};
        if (gameType === 'scribble') {
            initialGameData = { currentRound: 1, drawerIndex: 0, currentDrawerId: null, drawHistory: [], guessedUsers: [] };
        } else if (gameType === 'chess') {
            if(Chess) initialGameData = { fen: new Chess().fen() };
        } else if (gameType === 'tictactoe') {
            initialGameData = { board: Array(9).fill(null), turn: 'X' };
        }

        rooms[roomCode] = {
            name: `${username}'s Room`,
            adminId: socket.id,
            users: [],
            gameType: gameType,
            settings: settings,
            gameData: initialGameData,
            state: "LOBBY"
        };
        socket.emit('room_created', roomCode);
    });

    // --- JOIN ROOM ---
    socket.on('join_room', ({ roomCode, username, avatar }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'Room not found'); return; }
        if (room.users.length >= 10) { socket.emit('error', 'Room Full'); return; }

        const user = { id: socket.id, username, avatar, score: 0 };
        room.users.push(user);
        socket.join(roomCode);

        io.to(roomCode).emit('update_room', getRoomPublicData(room));
        io.to(roomCode).emit('system_message', { text: `${username} joined!`, type: 'sys' });

        // Sync State
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            socket.emit('canvas_history', room.gameData.drawHistory);
            socket.emit('scribble_state_change', { 
                state: 'DRAWING', 
                drawerId: room.gameData.currentDrawerId,
                maskedWord: room.gameData.maskedWord,
                time: 60 // fallback
            });
        } else if (room.gameType === 'chess') {
            socket.emit('chess_state', room.gameData.fen);
        } else if (room.gameType === 'tictactoe') {
            socket.emit('ttt_update', { board: room.gameData.board });
        }
    });

    // --- GENERAL EVENTS ---
    socket.on('start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room && room.adminId === socket.id) {
            room.state = "PLAYING";
            
            if(room.gameType === 'scribble') {
                room.gameData.currentRound = 1;
                room.gameData.drawerIndex = 0;
                room.users.forEach(u => u.score = 0);
                startScribbleTurn(roomCode);
            } else {
                // Chess / TTT Start
                io.to(roomCode).emit('update_room', getRoomPublicData(room));
                io.to(roomCode).emit('system_message', { text: "Game Started!", type: 'sys' });
                
                // Auto-Bot move if 1 player in Chess
                if(room.gameType === 'chess' && room.settings.useBot && room.users.length === 1) {
                    // Player is White, Bot is Black (Bot waits for player move)
                }
            }
        }
    });

    socket.on('typing_start', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room) socket.to(roomCode).emit('user_typing', { userId: socket.id, isTyping: true });
    });

    socket.on('typing_stop', ({ roomCode }) => {
        const room = rooms[roomCode];
        if(room) socket.to(roomCode).emit('user_typing', { userId: socket.id, isTyping: false });
    });

    socket.on('send_reaction', ({ roomCode, emoji }) => {
        io.to(roomCode).emit('show_reaction', { userId: socket.id, emoji });
    });

    // --- SCRIBBLE LOGIC ---
    socket.on('word_selected', ({ roomCode, word }) => {
        handleWordSelection(roomCode, word);
    });

    socket.on('draw_data', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        
        if (data.type === 'start') {
            room.gameData.currentStroke = { color: data.color, points: [{x: data.x, y: data.y}], width: data.width };
        } else if (data.type === 'move' && room.gameData.currentStroke) {
            room.gameData.currentStroke.points.push({x: data.x, y: data.y});
        } else if (data.type === 'end' && room.gameData.currentStroke) {
            room.gameData.drawHistory.push(room.gameData.currentStroke);
            room.gameData.currentStroke = null;
        }
        socket.to(data.roomCode).emit('draw_data', data);
    });

    socket.on('undo_draw', ({roomCode}) => {
        const room = rooms[roomCode];
        if(room && room.gameData.drawHistory.length > 0) {
            room.gameData.drawHistory.pop();
            io.to(roomCode).emit('canvas_history', room.gameData.drawHistory);
        }
    });

    socket.on('clear_canvas', ({roomCode}) => {
        const room = rooms[roomCode];
        if(room) { room.gameData.drawHistory = []; io.to(roomCode).emit('clear_canvas'); }
    });

    // --- CHAT & SCORING ---
    socket.on('chat_msg', ({ roomCode, msg }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user) return;

        // Scribble Logic
        if (room.gameType === 'scribble' && room.state === 'PLAYING') {
            // If user is Drawer, they can't chat about the word
            if (socket.id === room.gameData.currentDrawerId) return;

            if (room.gameData.currentWord && msg.trim().toLowerCase() === room.gameData.currentWord.toLowerCase()) {
                if (!room.gameData.guessedUsers.includes(socket.id)) {
                    // Scoring: 100 for first, then decrease
                    const points = Math.max(50, 100 - (room.gameData.guessedUsers.length * 20));
                    user.score += points;
                    
                    // Drawer bonus
                    const drawer = room.users.find(u => u.id === room.gameData.currentDrawerId);
                    if (drawer) drawer.score += 25; // Bonus per guess

                    room.gameData.guessedUsers.push(socket.id);
                    io.to(roomCode).emit('system_message', { text: `🎉 ${user.username} guessed it! (+${points})`, type: 'correct' });
                    io.to(roomCode).emit('update_room', getRoomPublicData(room));

                    // End early if all guessed
                    const guessersNeeded = room.users.length - 1;
                    if (room.gameData.guessedUsers.length >= guessersNeeded && guessersNeeded > 0) {
                        endScribbleTurn(roomCode, "Everyone Guessed!");
                    }
                    return; // Hide word
                }
            }
        }
        
        // Broadcast Chat
        io.to(roomCode).emit('chat_msg', { username: user.username, avatar: user.avatar, text: msg });
    });

    // --- CHESS/TTT MOVES ---
    socket.on('chess_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if(room && room.gameType === 'chess') {
             const chess = new Chess(room.gameData.fen);
             if(chess.move(move)) {
                 room.gameData.fen = chess.fen();
                 io.to(roomCode).emit('chess_state', room.gameData.fen);
                 
                 // Trigger Bot if enabled
                 if(room.settings.useBot && room.users.length === 1) {
                     setTimeout(() => makeBotMove(roomCode), 500);
                 }
             }
        }
    });

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

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        for(const code in rooms) {
            const room = rooms[code];
            const idx = room.users.findIndex(u => u.id === socket.id);
            if(idx !== -1) {
                const u = room.users[idx];
                room.users.splice(idx, 1);
                io.to(code).emit('system_message', { text: `${u.username} left.`, type: 'sys' });
                
                if(room.users.length === 0) delete rooms[code];
                else {
                    if(room.adminId === socket.id) assignNextAdmin(code);
                    io.to(code).emit('update_room', getRoomPublicData(room));
                }
            }
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
