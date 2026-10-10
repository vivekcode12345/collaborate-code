import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

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
        currentRoom = roomId;
        currentUser = userName;
        if(currentRoom){
            socket.leave(currentRoom);
            rooms.get(currentRoom)?.delete(currentUser);
            io.to(currentRoom).emit("user-Left", Array.from(rooms.get(currentRoom)));

        }

        currentRoom = roomId;
        if(!rooms.has(roomId)){
            rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(username);
        io.to(roomId).emit("user-joined", Array.from(rooms.get(roomId)));

    });

});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
