import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';

const app = express();

const port = process.env.PORT || 5000;
const server = http.createServer(app);
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
            rooms.get(currentRoom).delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom)));
        }

        // Join the new room
        currentRoom = roomId;
        currentUser = userName;

        socket.join(roomId);

        if(!rooms.has(roomId)){
            rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(userName);
        io.to(roomId).emit("user-joined", Array.from(rooms.get(roomId)));
    });

    socket.on("userTyping", ({roomId, userName}) => {
        socket.to(roomId).emit("userTyping", userName);
    });  
    
    socket.on("languageChange", ({roomId, language}) => {
        socket.to(roomId).emit("languageChange", language);
    });

    socket.on("disconnect", () => {
        console.log("User disconnected", socket.id);
        if(currentRoom && rooms.has(currentRoom)){
            rooms.get(currentRoom).delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom)));
        }
    });

    socket.on("leave-room", () => {
        if(currentRoom && rooms.has(currentRoom)){
            socket.leave(currentRoom);
            rooms.get(currentRoom).delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom)));
        }
        currentRoom = null;
        currentUser = null;
    });
    socket.on("codeChange", ({roomId, code}) => {
        socket.to(roomId).emit("codeUpdate", code);
    });
});

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, 'Frontend/dist')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'Frontend/dist', 'index.html'));
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
