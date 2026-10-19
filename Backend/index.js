import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { Doc as YDoc } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';

// Wandbox — free code execution API, no key/signup needed.
// Docs: https://github.com/melpon/wandbox/blob/master/kennel/API.md
const WANDBOX_COMPILERS = {
    javascript: 'nodejs-20.17.0',
    python: 'cpython-3.12.7',
    cpp: 'gcc-13.2.0',
    java: 'openjdk-jdk-21+35',
};

const MAX_CODE = 100000;
const MAX_UPDATE_BYTES = 200000;

// --- Session replay recording limits ---
const MAX_EVENTS = (() => {
    const n = parseInt(process.env.REPLAY_MAX_EVENTS, 10);
    return Number.isFinite(n) && n > 0 ? n : 20000;
})();
const MAX_RECORDING_BYTES = 5_000_000;
const MAX_FINISHED = 30;
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;
// Per-IP rate limit for GET /api/replay/:roomId (20 requests / minute by default).
const REPLAY_RATE_MAX = (() => {
    const n = parseInt(process.env.REPLAY_RATE_MAX, 10);
    return Number.isFinite(n) && n > 0 ? n : 20;
})();
const REPLAY_RATE_WINDOW_MS = (() => {
    const n = parseInt(process.env.REPLAY_RATE_WINDOW_MS, 10);
    return Number.isFinite(n) && n > 0 ? n : 60000;
})();

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
app.set('trust proxy', 1);

const port = process.env.PORT || 5000;
const server = http.createServer(app);



const io = new Server(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGIN || '*',
    },
});

const rooms = new Map();
// Finished recordings kept after a room is deleted, keyed by roomId.
const finishedRecordings = new Map();

function createRecording(roomId) {
    return {
        roomId,
        startedAt: Date.now(),
        endedAt: null,
        truncated: false,
        bytes: 0,
        events: [],
    };
}

function recordEvent(rec, ev) {
    if (!rec || rec.truncated) return;
    if (rec.events.length >= MAX_EVENTS) {
        rec.truncated = true;
        return;
    }
    let size = 0;
    if (ev.k === 'doc') size = ev.d.length;
    else if (ev.k === 'run') size = (ev.out || '').length;
    else if (ev.k === 'lang') size = (ev.v || '').length;
    else if (ev.k === 'join' || ev.k === 'leave') size = (ev.u || '').length;
    if (rec.bytes + size > MAX_RECORDING_BYTES) {
        rec.truncated = true;
        return;
    }
    rec.bytes += size;
    rec.events.push(ev);
}

function pruneFinishedRecordings() {
    const now = Date.now();
    for (const [key, rec] of finishedRecordings) {
        const ts = rec.endedAt || rec.startedAt;
        if (now - ts > FINISHED_TTL_MS) finishedRecordings.delete(key);
    }
    while (finishedRecordings.size > MAX_FINISHED) {
        let oldestKey = null;
        let oldestTs = Infinity;
        for (const [key, rec] of finishedRecordings) {
            const ts = rec.endedAt || rec.startedAt;
            if (ts < oldestTs) {
                oldestTs = ts;
                oldestKey = key;
            }
        }
        if (oldestKey === null) break;
        finishedRecordings.delete(oldestKey);
    }
}

function finalizeRecording(roomId, room) {
    const rec = room.recording;
    if (!rec) return;
    rec.endedAt = Date.now();
    room.recording = null;
    // A newer session for the same roomId REPLACES the older one (Map.set overwrites).
    finishedRecordings.set(roomId, rec);
    pruneFinishedRecordings();
}

function leave(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms.has(roomId)) {
        socket.currentRoom = null;
        socket.currentUser = null;
        return;
    }
    const room = rooms.get(roomId);
    socket.leave(roomId);

    if (socket.data && socket.data.awarenessIds && socket.data.awarenessIds.size) {
        const ids = [...socket.data.awarenessIds];
        socket.data.awarenessIds.clear();
        removeAwarenessStates(room.awareness, ids, null);
    }

    const userName = socket.currentUser;
    room.users.delete(socket.id);
    if (room.recording && userName) {
        recordEvent(room.recording, {
            t: Date.now() - room.recording.startedAt,
            k: 'leave',
            u: userName,
        });
    }
    if (room.users.size === 0) {
        room.awareness.destroy();
        // Detach the ydoc update listener so it cannot leak after destroy().
        if (room.ydocUpdateHandler) {
            room.ydoc.off('update', room.ydocUpdateHandler);
            room.ydocUpdateHandler = null;
        }
        finalizeRecording(roomId, room);
        room.ydoc.destroy();
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
    socket.data = socket.data || {};
    socket.data.awarenessIds = new Set();

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
            const ydoc = new YDoc();
            ydoc.clientID = 1;
            ydoc.getText("monaco").insert(0, "// Start your code here");
            const awareness = new Awareness(ydoc);
            awareness.setLocalState(null);

            const recording = createRecording(cleanRoomId);
            // FIRST event: full seed state at t=0 so replay starts from the seed text.
            recordEvent(recording, {
                t: 0,
                k: 'doc',
                d: Buffer.from(encodeStateAsUpdate(ydoc)).toString('base64'),
            });
            recordEvent(recording, { t: 0, k: 'lang', v: 'javascript' });

            const ydocUpdateHandler = (update, origin) => {
                // Guard: the room may already have been finalized/destroyed.
                if (!rooms.has(cleanRoomId)) return;
                recordEvent(recording, {
                    t: Date.now() - recording.startedAt,
                    k: 'doc',
                    d: Buffer.from(update).toString('base64'),
                });
                if (origin && typeof origin.to === 'function') {
                    origin.to(cleanRoomId).emit("yjs-update", update);
                } else {
                    io.to(cleanRoomId).emit("yjs-update", update);
                }
            };
            ydoc.on("update", ydocUpdateHandler);

            awareness.on("update", ({ added, updated, removed }, origin) => {
                // Track announced clientIDs on the ORIGIN socket so leave() can
                // remove exactly this socket's states when it disconnects.
                if (origin && origin.data) {
                    const tracked = new Set(origin.data.awarenessIds || []);
                    for (const id of [...added, ...updated]) tracked.add(id);
                    for (const id of removed) tracked.delete(id);
                    origin.data.awarenessIds = tracked;
                }
                const encoded = encodeAwarenessUpdate(
                    awareness,
                    [...added, ...updated, ...removed]
                );
                if (origin && typeof origin.to === 'function') {
                    origin.to(cleanRoomId).emit("awareness-update", encoded);
                } else {
                    // origin === null (leave()-triggered removal): tell everyone.
                    io.to(cleanRoomId).emit("awareness-update", encoded);
                }
            });

            rooms.set(cleanRoomId, {
                users: new Map(),
                ydoc,
                awareness,
                language: "javascript",
                running: false,
                recording,
                ydocUpdateHandler,
            });
        }

        const room = rooms.get(cleanRoomId);
        room.users.set(socket.id, cleanUserName);
        if (room.recording) {
            recordEvent(room.recording, {
                t: Date.now() - room.recording.startedAt,
                k: 'join',
                u: cleanUserName,
            });
        }

        socket.emit("yjs-init", {
            doc: encodeStateAsUpdate(room.ydoc),
            awareness: encodeAwarenessUpdate(
                room.awareness,
                [...room.awareness.getStates().keys()]
            ),
        });
        socket.emit("languageChange", room.language);

        io.to(cleanRoomId).emit("user-joined", [...room.users.values()]);
    });

    socket.on("yjs-update", (data) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        if (data && typeof data.length === 'number' && data.length > MAX_UPDATE_BYTES) return;
        const buf = new Uint8Array(data);
        if (buf.length > MAX_UPDATE_BYTES) return;
        try {
            applyUpdate(room.ydoc, buf, socket);
        } catch (err) {
            console.error("yjs-update apply failed:", err.message);
        }
    });

    socket.on("awareness-update", (data) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        if (data && typeof data.length === 'number' && data.length > MAX_UPDATE_BYTES) return;
        const buf = new Uint8Array(data);
        if (buf.length > MAX_UPDATE_BYTES) return;
        try {
            applyAwarenessUpdate(room.awareness, buf, socket);
        } catch (err) {
            console.error("awareness-update apply failed:", err.message);
        }
    });

    socket.on("languageChange", ({ language }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        if (!WANDBOX_COMPILERS[language]) return;
        const room = rooms.get(roomId);
        room.language = language;
        if (room.recording) {
            recordEvent(room.recording, {
                t: Date.now() - room.recording.startedAt,
                k: 'lang',
                v: language,
            });
        }
        socket.to(roomId).emit("languageChange", language);
    });

    socket.on("compileCode", async ({ input }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        if (room.running) return;

        const code = room.ydoc.getText("monaco").toString();
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

        const userName = socket.currentUser;
        try {
            const output = await runOnWandbox(room.language, code, input);
            if (room.recording) {
                recordEvent(room.recording, {
                    t: Date.now() - room.recording.startedAt,
                    k: 'run',
                    u: userName,
                    out: String(output).slice(0, 5000),
                });
            }
            io.to(roomId).emit("codeResponse", { run: { output } });
        } catch (err) {
            const msg = err?.response?.data?.message || err.message;
            console.error("compileCode failed:", msg);
            const out = `Execution failed: ${msg}`.slice(0, 5000);
            if (room.recording) {
                recordEvent(room.recording, {
                    t: Date.now() - room.recording.startedAt,
                    k: 'run',
                    u: userName,
                    out,
                });
            }
            io.to(roomId).emit("codeResponse", { run: { output: out } });
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

});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Session replay endpoint — MUST be registered BEFORE the '/*splat' static fallback.
const replayHits = new Map(); // ip -> [timestamps within the current window]
app.get('/api/replay/:roomId', (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    let hits = replayHits.get(ip) || [];
    hits = hits.filter((ts) => now - ts < REPLAY_RATE_WINDOW_MS);
    if (hits.length >= REPLAY_RATE_MAX) {
        replayHits.set(ip, hits);
        return res.status(429).json({ error: 'Too many requests' });
    }
    hits.push(now);
    replayHits.set(ip, hits);

    const { roomId } = req.params;
    if (typeof roomId !== 'string' || roomId.length < 1 || roomId.length > 100) {
        return res.status(400).json({ error: 'Invalid room id' });
    }

    // Live room first (endedAt stays null), then finished recordings.
    let rec = null;
    if (rooms.has(roomId)) rec = rooms.get(roomId).recording;
    if (!rec) rec = finishedRecordings.get(roomId);
    if (!rec) return res.status(404).json({ error: 'No recording found' });

    res.set('Cache-Control', 'no-store');
    return res.json({
        roomId: rec.roomId,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        truncated: rec.truncated,
        events: rec.events,
    });
});

app.use(express.static(path.join(__dirname, '../Frontend/dist')));

app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/dist', 'index.html'));
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
