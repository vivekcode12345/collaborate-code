import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import axios from 'axios';

// Wandbox — free code execution API, no key/signup needed.
// Docs: https://github.com/melpon/wandbox/blob/master/kennel/API.md
const WANDBOX_COMPILERS = {
    javascript: 'nodejs-20.17.0',
    python: 'cpython-3.12.7',
    cpp: 'gcc-13.2.0',
    java: 'openjdk-jdk-21+35',
};

async function runOnWandbox(language, code) {
    const compiler = WANDBOX_COMPILERS[language];
    if (!compiler) throw new Error(`Language '${language}' not supported`);
    const { data } = await axios.post('https://wandbox.org/api/compile.json', {
        compiler,
        code,
        save: false,
    }, { timeout: 60000 });
    // Wandbox returns program_output on success, compiler_error on failure.
    const out = data.program_output || data.program_message
        || data.compiler_error || data.compiler_output || data.compiler_message
        || '(no output)';
    return String(out).slice(0, 5000);
}

const app = express();

const port = process.env.PORT || 5000;
const server = http.createServer(app);



// const url = `https://collaborate-code.onrender.com`;
// const interval = 30000;

// function reloadWebsite() {
//   axios
//     .get(url)
//     .then((response) => {
//       console.log("website reloded");
//     })
//     .catch((error) => {
//       console.error(`Error : ${error.message}`);
//     });
// }

// setInterval(reloadWebsite, interval);

const io= new Server(server, {
    cors: {
        origin: '*'
    },
});

const rooms= new Map();

io.on('connection', (socket) => {
    console.log("A user connected", socket.id);
    let currentRoom = null;
    let currentUser = null;

    socket.on("join",({roomId, userName})=>{
        // Leave the previous room first (only if the user was already in one)
        if(currentRoom && rooms.has(currentRoom)){
            socket.leave(currentRoom);
            rooms.get(currentRoom).users.delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom).users));
        }

        // Join the new room
        currentRoom = roomId;
        currentUser = userName;

        socket.join(roomId);

        if(!rooms.has(roomId)){
            rooms.set(roomId, {users: new Set(),code: "// Start your code here"});
        }
        rooms.get(roomId).users.add(userName);
        socket.emit("codeUpdate", rooms.get(roomId).code);
        io.to(roomId).emit("user-joined", Array.from(rooms.get(currentRoom).users));
    });

    socket.on("userTyping", ({roomId, userName}) => {
        socket.to(roomId).emit("userTyping", userName);
    });  
    
    socket.on("languageChange", ({roomId, language}) => {
        socket.to(roomId).emit("languageChange", language);
    });

    socket.on("compileCode", async({code, roomId, language, version,input})=>{
        try {
            if(!rooms.has(roomId)) return;
            const output = await runOnWandbox(language, code);
            io.to(roomId).emit("codeResponse", { run: { output } });
        } catch (err) {
            const msg = err?.response?.data?.message || err.message;
            console.error("compileCode failed:", msg);
            io.to(roomId).emit("codeResponse", { run: { output: `Execution failed: ${msg}` } });
        }
    });
        

    socket.on("disconnect", () => {
        console.log("User disconnected", socket.id);
        if(currentRoom && rooms.has(currentRoom)){
            rooms.get(currentRoom).users.delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom).users));
        }
    });

    socket.on("leave-room", () => {
        if(currentRoom && rooms.has(currentRoom)){
            socket.leave(currentRoom);
            rooms.get(currentRoom).users.delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom).users));
        }
        currentRoom = null;
        currentUser = null;
    });
    socket.on("codeChange", ({roomId, code}) => {
        if(!rooms.has(roomId))
            return;
        rooms.get(roomId).code = code; 
        socket.to(roomId).emit("codeUpdate", code);
    });
    

});

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, 'Frontend/dist')));

app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, 'Frontend/dist', 'index.html'));
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
