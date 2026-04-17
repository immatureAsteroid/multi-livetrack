const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve HTML files from the root folder
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mobile.html', (req, res) => res.sendFile(path.join(__dirname, 'mobile.html')));

const sessions = new Map();

io.on('connection', (socket) => {
    socket.on('host:create', ({ sessionId }) => {
        sessions.set(sessionId, { hostSocketId: socket.id, trackers: new Map() });
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.role = 'host';
        socket.emit('host:ready', { sessionId });
    });

    socket.on('tracker:join', ({ sessionId, name }) => {
        const session = sessions.get(sessionId);
        if (!session) return socket.emit('tracker:error', { message: 'Session not found' });
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.role = 'tracker';
        
        const trackerData = { id: socket.id, name, status: 'connected', lat: null, lng: null };
        session.trackers.set(socket.id, trackerData);
        
        socket.emit('tracker:joined', { sessionId });
        io.to(session.hostSocketId).emit('host:tracker_joined', trackerData);
    });

    socket.on('tracker:location', (data) => {
        const session = sessions.get(socket.sessionId);
        if (session) {
            io.to(session.hostSocketId).emit('host:location_update', { id: socket.id, ...data });
        }
    });

    socket.on('disconnect', () => {
        if (socket.role === 'host') {
            io.to(socket.sessionId).emit('session:ended', { message: 'Organiser left.' });
            sessions.delete(socket.sessionId);
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => console.log(`SERVER RUNNING ON PORT ${PORT}`));