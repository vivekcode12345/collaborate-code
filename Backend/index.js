import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

// Wandbox — free code execution API, no key/signup needed.
// Docs: https://github.com/melpon/wandbox/blob/master/kennel/API.md
const WANDBOX_COMPILERS = {
    javascript: 'nodejs-20.17.0',
    python: 'cpython-3.12.7',
    cpp: 'gcc-13.2.0',
    java: 'openjdk-jdk-21+35',
};

const MAX_CODE = 100000;

async function runOnWandbox(language, code, stdin = "") {
    const compiler = WANDBOX_COMPILERS[language];
    if (!compiler) throw new Error(`Language '${language}' not supported`);
    const { data } = await axios.post('https://wandbox.org/api/compile.json', {
        compiler,
        code,
        stdin: String(stdin).slice(0, 5000),
        save: false,
    }, { timeout: 60000 });
    if (!data.program_output && data.compiler_error) {
        return String(data.compiler_error).slice(0, 5000);
    }
    const out = data.program_output || data.program_message
        || data.compiler_output || data.compiler_message
        || '(no output)';
    return String(out).slice(0, 5000);
}

const app = express();

const port = process.env.PORT || 5000;
const server = http.createServer(app);



const io = new Server(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGIN || '*',
    },
});

const rooms = new Map();

function leave(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms.has(roomId)) {
        socket.currentRoom = null;
        socket.currentUser = null;
        return;
    }
    const room = rooms.get(roomId);
    socket.leave(roomId);
    room.users.delete(socket.id);
    if (room.users.size === 0) {
        rooms.delete(roomId);
    } else {
        io.to(roomId).emit("user-Left", [...room.users.values()]);
    }
    socket.currentRoom = null;
    socket.currentUser = null;
}

io.on('connection', (socket) => {
    console.log("A user connected", socket.id);
    socket.currentRoom = null;
    socket.currentUser = null;
    socket.lastCompileTime = 0;

    socket.on("join", ({ roomId, userName }) => {
        if (typeof roomId !== 'string' || roomId.trim() === '') return;
        if (typeof userName !== 'string' || userName.trim() === '') return;

        const cleanRoomId = roomId.slice(0, 100);
        const cleanUserName = userName.trim().slice(0, 30);

        leave(socket);

        socket.currentRoom = cleanRoomId;
        socket.currentUser = cleanUserName;

        socket.join(cleanRoomId);

        if (!rooms.has(cleanRoomId)) {
            rooms.set(cleanRoomId, {
                users: new Map(),
                code: "// Start your code here",
                language: "javascript",
                running: false,
            });
        }

        const room = rooms.get(cleanRoomId);
        room.users.set(socket.id, cleanUserName);
        socket.emit("codeUpdate", room.code);
        socket.emit("languageChange", room.language);

        io.to(cleanRoomId).emit("user-joined", [...room.users.values()]);
    });

    socket.on("userTyping", () => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        socket.to(roomId).emit("userTyping", socket.currentUser);
    });
    
    socket.on("languageChange", ({ language }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        if (!WANDBOX_COMPILERS[language]) return;
        const room = rooms.get(roomId);
        room.language = language;
        socket.to(roomId).emit("languageChange", language);
    });

    socket.on("compileCode", async ({ code, input }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        if (room.running) return;
        if (typeof code !== 'string' || code.length > MAX_CODE) return;

        const now = Date.now();
        const lastRun = socket.lastCompileTime || 0;
        if (now - lastRun < 3000) {
            socket.emit("codeResponse", { run: { output: "Please wait a few seconds before running again." } });
            return;
        }
        socket.lastCompileTime = now;

        room.running = true;
        io.to(roomId).emit("codeRunning");

        try {
            const output = await runOnWandbox(room.language, code, input);
            io.to(roomId).emit("codeResponse", { run: { output } });
        } catch (err) {
            const msg = err?.response?.data?.message || err.message;
            console.error("compileCode failed:", msg);
            io.to(roomId).emit("codeResponse", { run: { output: `Execution failed: ${msg}` } });
        } finally {
            room.running = false;
        }
    });
        

    socket.on("disconnect", () => {
        console.log("User disconnected", socket.id);
        leave(socket);
    });

    socket.on("leave-room", () => {
        leave(socket);
    });

    socket.on("codeChange", ({ code }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        if (typeof code !== 'string' || code.length > MAX_CODE) return;
        const room = rooms.get(roomId);
        room.code = code;
        socket.to(roomId).emit("codeUpdate", code);
    });
    

});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '../Frontend/dist')));

app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/dist', 'index.html'));
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
