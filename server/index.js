const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- SAFE IMPORTS ---
let Chess;
try {
    const chessLib = require('chess.js');
    Chess = chessLib.Chess || chessLib;
} catch (e) { console.log("Chess.js not found."); }

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
        drawerId: room.gameData.drawerId,
        drawerName: room.gameData.drawerId ? (room.users.find(u=>u.id===room.gameData.drawerId)?.username || "Unknown") : "",
        maskedWord: room.gameData.word ? room.gameData.word.replace(/[a-zA-Z]/g, '_') : "", // Default mask
        roundInfo: { current: room.gameData.round, total: room.settings.rounds },
        gameData: room.gameData
    };
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
    
    room.state = "SELECTING";
    io.to(roomCode).emit('update_room', getRoomState(room)); 
    
    io.to(roomCode).emit('clear_canvas'); 
    io.to(roomCode).emit('scribble_state', { 
        state: "SELECTING", 
        drawerId: drawer.id, 
        drawerName: drawer.username, 
        round: room.gameData.round, 
        totalRounds: room.settings.rounds 
    });
    
    const options = getRandomWords(3, room.settings.customWords);
    io.to(drawer.id).emit('pick_word', { words: options });
    
    let pickTime = 30; // Reverse timer for selection
    clearInterval(room.gameData.timer);
    
    room.gameData.timer = setInterval(() => { 
        pickTime--; 
        io.to(roomCode).emit('timer_sync', { total: pickTime, msg: `${drawer.username} Picking...` });
        if(pickTime <= 0) handleWordSelection(roomCode, options[0]); 
    }, 1000);
}

function handleWordSelection(roomCode, word) {
    const room = rooms[roomCode]; if(!room) return;
    clearInterval(room.gameData.timer);
    room.gameData.word = word; room.state = "DRAWING";
    
    // Create initial mask
    let masked = word.replace(/[a-zA-Z]/g, '_');
    
    io.to(roomCode).emit('scribble_state', { 
        state: "DRAWING", 
        drawerId: room.gameData.drawerId, 
        maskedWord: masked, 
        round: room.gameData.round, 
        totalRounds: room.settings.rounds 
    });
    
    io.to(room.gameData.drawerId).emit('drawer_secret', word); // Real word to drawer
    io.to(roomCode).emit('sfx', 'start'); 
    
    let time = parseInt(room.settings.time) || 60;
    const initialTime = time;
    
    room.gameData.timer = setInterval(() => {
        time--; 
        io.to(roomCode).emit('timer_sync', { total: time, msg: "Guess the word!" });

        // HINT LOGIC (Reveal letters slowly)
        if(time === Math.floor(initialTime * 0.75) || time === Math.floor(initialTime * 0.25)) {
             const revealIdx = Math.floor(Math.random() * word.length);
             const letter = word[revealIdx];
             // Reconstruct mask with hint
             let newMask = "";
             for(let i=0; i<word.length; i++) {
                 // Keep revealed chars or create new hint
                 if (i === revealIdx) newMask += letter;
                 else if (masked[i] !== '_') newMask += masked[i];
                 else newMask += "_";
             }
             masked = newMask;
             // Send updated mask to everyone (Drawer ignores this via UI logic)
             io.to(roomCode).emit('scribble_state', { 
                state: "DRAWING", 
                drawerId: room.gameData.drawerId, 
                maskedWord: masked, 
                round: room.gameData.round, 
                totalRounds: room.settings.rounds 
            });
             io.to(roomCode).emit('chat_receive', {username:'SYSTEM', text:`💡 Hint: ${letter}`});
        }

        if(time <= 0) { io.to(roomCode).emit('sfx', 'timeover'); endScribbleTurn(roomCode, "Time's up!"); }
    }, 1000);
}

function endScribbleTurn(roomCode, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timer);
    const lb = room.users.map(u => ({ username: u.username, score: u.score })).sort((a,b) => b.score - a.score);
    
    io.to(roomCode).emit('game_over_alert', { title: "Round Over", msg: `Word was: ${room.gameData.word}`, leaderboard: lb });
    setTimeout(() => { room.gameData.drawerIdx++; startScribbleTurn(roomCode); }, 5000);
}

// --- CHESS LOGIC ---
function startChessGame(roomCode) {
    const room = rooms[roomCode];
    if(!room || !Chess) return;
    room.state = "PLAYING";
    room.gameData.fen = new Chess().fen();
    room.gameData.turn = 'w'; 
    const t = parseInt(room.settings.time) || 600; 
    room.gameData.timers = { w: t, b: t };
    
    const p1 = room.users[0]; const p2 = room.users[1]; 
    let adminColor = room.settings.startColor === 'black' ? 'b' : 'w';
    let oppColor = adminColor === 'w' ? 'b' : 'w';
    if(room.settings.botMode || !p2) { room.gameData.players = { [adminColor]: p1.id, [oppColor]: 'BOT' }; room.settings.botMode = true; } 
    else { room.gameData.players = { [adminColor]: p1.id, [oppColor]: p2.id }; }

    io.to(roomCode).emit('update_room', getRoomState(room));
    clearInterval(room.gameData.timerInterval);
    room.gameData.timerInterval = setInterval(() => {
        const turn = room.gameData.turn; room.gameData.timers[turn]--;
        io.to(roomCode).emit('timer_sync', { total: room.gameData.timers[turn], msg: turn==='w'?"White":"Black" });
        if(room.gameData.timers[turn] <= 0) { endChessGame(roomCode, turn==='w'?'b':'w', "Time Out"); }
    }, 1000);
}

function endChessGame(roomCode, winnerColor, reason) {
    const room = rooms[roomCode]; clearInterval(room.gameData.timerInterval);
    room.state = "GAME_OVER";
    let wName = "Draw";
    if(winnerColor !== 'draw') {
        const wid = room.gameData.players[winnerColor];
        const u = room.users.find(u=>u.id===wid);
        if(u) { u.score+=100; wName=u.username; } else { wName="Bot"; }
    }
    io.to(roomCode).emit('game_over_alert', { title: "GAME OVER", msg: `${wName} Won!`, leaderboard: room.users });
    io.to(roomCode).emit('update_room', getRoomState(room));
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('create_room', ({ username, avatar, gameType }) => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        const rSettings = { rounds: 3, time: 60, customWords: [], botMode: false, startColor: 'white', startSymbol: 'X' };
        
        let gd = {};
        if(gameType === 'scribble') gd = { round: 1, drawerIdx: 0, drawerId: null, word: null, history: [], guessed: [] };
        else if (gameType === 'tictactoe') gd = { board: Array(9).fill(null), turn: 'X' };
        else if (gameType === 'chess' && Chess) gd = { fen: new Chess().fen(), turn: 'w', timers: {w:600, b:600}, players: {} };
        
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
        // Late join sync for Scribble Mask
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            const mask = room.gameData.word ? room.gameData.word.replace(/[a-zA-Z]/g, '_') : "";
             socket.emit('scribble_state', { 
                state: "DRAWING", 
                drawerId: room.gameData.drawerId, 
                maskedWord: mask, 
                round: room.gameData.round, 
                totalRounds: room.settings.rounds 
            });
        }
    });

    socket.on('start_game', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if(room && room.adminId === socket.id) {
            if(settings) room.settings = { ...room.settings, ...settings };
            if(room.gameType === 'scribble') {
                room.gameData.round = 1; room.gameData.drawerIdx = 0; room.users.forEach(u=>u.score=0);
                startScribbleTurn(roomCode);
            } else if (room.gameType === 'chess') {
                startChessGame(roomCode);
            } else if (room.gameType === 'tictactoe') {
                room.state="PLAYING";
                room.gameData.board=Array(9).fill(null);
                room.gameData.turn='X';
                io.to(roomCode).emit('update_room', getRoomState(room));
            }
        }
    });

    socket.on('chat_send', ({ roomCode, text }) => {
        const room = rooms[roomCode]; if(!room) return;
        const user = room.users.find(u => u.id === socket.id);
        
        // Strict: Drawer cannot Chat
        if(room.gameType === 'scribble' && room.state === 'DRAWING' && socket.id === room.gameData.drawerId) {
            return; // Block
        }

        // Scribble Guess Logic
        if(room.gameType === 'scribble' && room.state === 'DRAWING') {
            if(text.trim().toLowerCase() === room.gameData.word.toLowerCase()) {
                if(!room.gameData.guessed.includes(socket.id)) {
                    room.gameData.guessed.push(socket.id); 
                    user.score += 100;
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

    // Chess Move
    socket.on('chess_move', ({roomCode, move}) => {
         const room = rooms[roomCode];
         if(!room || room.gameType!=='chess') return;
         const c = new Chess(room.gameData.fen);
         if(c.move(move)) {
             room.gameData.fen=c.fen(); room.gameData.turn=c.turn();
             io.to(roomCode).emit('chess_move_update', {fen:c.fen(), move});
             if(c.isGameOver()) endChessGame(roomCode, c.turn()==='w'?'b':'w', "Checkmate");
             // Bot Logic
             if(!c.isGameOver() && room.gameData.players[c.turn()] === 'BOT') {
                 setTimeout(()=>{
                     const ms=c.moves(); const m=ms[Math.floor(Math.random()*ms.length)];
                     if(m) { c.move(m); room.gameData.fen=c.fen(); room.gameData.turn=c.turn(); io.to(roomCode).emit('chess_move_update', {fen:c.fen(), move:m}); }
                 }, 500);
             }
         }
    });

    // TTT Move
    socket.on('ttt_move', ({roomCode, index}) => {
        const room = rooms[roomCode];
        if(!room || room.gameType!=='tictactoe' || room.gameData.board[index]!==null) return;
        room.gameData.board[index] = room.gameData.turn;
        io.to(roomCode).emit('ttt_update', {index, sym:room.gameData.turn});
        // Simple win check
        const b = room.gameData.board;
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        if(wins.some(w => b[w[0]] && b[w[0]]===b[w[1]] && b[w[0]]===b[w[2]])) {
             io.to(roomCode).emit('game_over_alert', {title:"WINNER", msg:`${room.gameData.turn} Wins!`, leaderboard:room.users});
             setTimeout(()=>{room.state="LOBBY"; io.to(roomCode).emit('update_room', getRoomState(room));},3000);
        } else {
             room.gameData.turn = room.gameData.turn==='X'?'O':'X';
        }
    });

    socket.on('disconnect', () => {
         for(const c in rooms) {
             const r = rooms[c];
             const i = r.users.findIndex(u=>u.id===socket.id);
             if(i!==-1){
                 r.users.splice(i,1);
                 if(r.users.length===0) delete rooms[c];
                 else { if(r.adminId===socket.id) r.adminId=r.users[0].id; io.to(c).emit('update_room', getRoomState(r)); }
                 break;
             }
         }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
