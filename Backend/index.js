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
io.on('connection', (socket) => {
    console.log("A user connected", socket.id);
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
