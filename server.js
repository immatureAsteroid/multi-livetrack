const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mobile.html', (req, res) => res.sendFile(path.join(__dirname, 'mobile.html')));

const sessions = new Map();

io.on('connection', (socket) => {

  // ── HOST creates session ─────────────────────────────────────────────
  socket.on('host:create', ({ sessionId }) => {
    sessions.set(sessionId, {
      hostSocketId: socket.id,
      trackers: new Map(),
      activeCamId: null,
      activeMicId: null
    });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role = 'host';
    socket.emit('host:ready', { sessionId });
  });

  // ── TRACKER joins ────────────────────────────────────────────────────
  socket.on('tracker:join', ({ sessionId, name }) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.emit('tracker:error', { message: 'Session not found' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role = 'tracker';
    socket.trackerName = name;
    const td = { id: socket.id, name, status: 'connected', lat: null, lng: null, camOn: false, camFacing: 'environment', micOn: false, raisedHand: false };
    session.trackers.set(socket.id, td);
    socket.emit('tracker:joined', { sessionId });
    io.to(session.hostSocketId).emit('host:tracker_joined', td);
  });

  // ── TRACKER location ─────────────────────────────────────────────────
  socket.on('tracker:location', (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;
    const tracker = session.trackers.get(socket.id);
    if (tracker) Object.assign(tracker, data);
    io.to(session.hostSocketId).emit('host:location_update', { id: socket.id, ...data });
  });

  // ── TRACKER media state ──────────────────────────────────────────────
  socket.on('tracker:media_state', ({ camOn, camFacing, micOn }) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;
    const tracker = session.trackers.get(socket.id);
    if (tracker) Object.assign(tracker, { camOn, camFacing, micOn });
    io.to(session.hostSocketId).emit('host:media_state', { id: socket.id, camOn, camFacing, micOn });
  });

  // ── TRACKER raise hand ───────────────────────────────────────────────
  socket.on('tracker:raise_hand', ({ raised }) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;
    const tracker = session.trackers.get(socket.id);
    if (tracker) tracker.raisedHand = raised;
    io.to(session.hostSocketId).emit('host:raise_hand', { id: socket.id, name: tracker?.name, raised });
  });

  // ── HOST → tracker media command (one-at-a-time enforced) ────────────
  socket.on('host:media_cmd', ({ targetId, cmd }) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (cmd === 'cam_on') {
      // Stop previous cam if different tracker
      if (session.activeCamId && session.activeCamId !== targetId) {
        io.to(session.activeCamId).emit('tracker:media_cmd', { cmd: 'cam_off' });
        const prev = session.trackers.get(session.activeCamId);
        if (prev) prev.camOn = false;
        io.to(session.hostSocketId).emit('host:media_state', { id: session.activeCamId, camOn: false, camFacing: prev?.camFacing ?? 'environment', micOn: prev?.micOn ?? false });
      }
      session.activeCamId = targetId;
    } else if (cmd === 'cam_off' && session.activeCamId === targetId) {
      session.activeCamId = null;
    }

    if (cmd === 'mic_on') {
      if (session.activeMicId && session.activeMicId !== targetId) {
        io.to(session.activeMicId).emit('tracker:media_cmd', { cmd: 'mic_off' });
        const prev = session.trackers.get(session.activeMicId);
        if (prev) prev.micOn = false;
        io.to(session.hostSocketId).emit('host:media_state', { id: session.activeMicId, camOn: prev?.camOn ?? false, camFacing: prev?.camFacing ?? 'environment', micOn: false });
      }
      session.activeMicId = targetId;
    } else if (cmd === 'mic_off' && session.activeMicId === targetId) {
      session.activeMicId = null;
    }

    io.to(targetId).emit('tracker:media_cmd', { cmd });
  });

  // ── WebRTC signaling ─────────────────────────────────────────────────
  socket.on('webrtc:offer',  ({ targetId, offer })     => io.to(targetId).emit('webrtc:offer',  { fromId: socket.id, offer }));
  socket.on('webrtc:answer', ({ targetId, answer })    => io.to(targetId).emit('webrtc:answer', { fromId: socket.id, answer }));
  socket.on('webrtc:ice',    ({ targetId, candidate }) => io.to(targetId).emit('webrtc:ice',    { fromId: socket.id, candidate }));

  // ── DISCONNECT ───────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.role === 'host') {
      io.to(socket.sessionId).emit('session:ended', { message: 'Organiser disconnected.' });
      sessions.delete(socket.sessionId);
    } else if (socket.role === 'tracker') {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (session.activeCamId === socket.id) session.activeCamId = null;
        if (session.activeMicId === socket.id) session.activeMicId = null;
        session.trackers.delete(socket.id);
        io.to(session.hostSocketId).emit('host:tracker_left', { id: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`LiveTrack server on port ${PORT}`));
