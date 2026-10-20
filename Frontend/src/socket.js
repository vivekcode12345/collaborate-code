import io from 'socket.io-client';

// A single shared socket for the whole app.
// The collaboration screen and the interview screen talk to the same server,
// so they must not open a second connection: socket.io multiplexes rooms over
// one socket, and a second socket would duplicate the Yjs session.
const socket = io(import.meta.env.VITE_SOCKET_URL || '/');

export default socket;
