const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── Serve HTML files ────────────────────────────────────────────────────────
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mobile.html', (req, res) => res.sendFile(path.join(__dirname, 'mobile.html')));

// ── ICE servers ─────────────────────────────────────────────────────────────
// Using Open Relay (free, no signup). Replace with private Coturn for production.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',              username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// ── Session store ────────────────────────────────────────────────────────────
// sessions: Map<sessionId, { hostSocketId, trackers: Map<socketId, trackerData>, activeCamId, activeMicId }>
const sessions = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSession(socket)  { return sessions.get(socket.sessionId); }
function getTracker(session, socketId) { return session?.trackers.get(socketId); }

// ════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {

  // ── HOST: create session ───────────────────────────────────────────────────
  socket.on('host:create', ({ sessionId }) => {
    sessions.set(sessionId, {
      hostSocketId: socket.id,
      trackers:     new Map(),
      activeCamId:  null,
      activeMicId:  null
    });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role      = 'host';

    socket.emit('host:ready',   { sessionId });
    socket.emit('ice:config',   { iceServers: ICE_SERVERS });   // send TURN config to dashboard
    console.log(`[+] Session created: ${sessionId}`);
  });

  // ── TRACKER: join session ──────────────────────────────────────────────────
  socket.on('tracker:join', ({ sessionId, name }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('tracker:error', { message: 'Session not found. The organiser may have closed it.' });
      return;
    }

    socket.join(sessionId);
    socket.sessionId  = sessionId;
    socket.role       = 'tracker';
    socket.trackerName= name;

    const td = {
      id: socket.id, name, status: 'connected',
      lat: null, lng: null, speed: null, battery: null, charging: false,
      camOn: false, camFacing: 'environment', micOn: false, raisedHand: false
    };
    session.trackers.set(socket.id, td);

    socket.emit('tracker:joined', { sessionId });
    socket.emit('ice:config',     { iceServers: ICE_SERVERS });  // send TURN config to tracker too
    io.to(session.hostSocketId).emit('host:tracker_joined', td);
    console.log(`[+] Tracker joined: ${name} → ${sessionId}`);
  });

  // ── TRACKER: location update ───────────────────────────────────────────────
  socket.on('tracker:location', (data) => {
    const session = getSession(socket);
    if (!session) return;
    const tracker = getTracker(session, socket.id);
    if (tracker) Object.assign(tracker, data);
    io.to(session.hostSocketId).emit('host:location_update', { id: socket.id, ...data });
  });

  // ── TRACKER: media state report ────────────────────────────────────────────
  socket.on('tracker:media_state', ({ camOn, camFacing, micOn }) => {
    const session = getSession(socket);
    if (!session) return;
    const tracker = getTracker(session, socket.id);
    if (tracker) Object.assign(tracker, { camOn, camFacing, micOn });
    io.to(session.hostSocketId).emit('host:media_state', {
      id: socket.id, camOn, camFacing, micOn
    });
  });

  // ── TRACKER: raise / lower hand ────────────────────────────────────────────
  socket.on('tracker:raise_hand', ({ raised }) => {
    const session = getSession(socket);
    if (!session) return;
    const tracker = getTracker(session, socket.id);
    if (tracker) tracker.raisedHand = raised;
    io.to(session.hostSocketId).emit('host:raise_hand', {
      id: socket.id, name: tracker?.name, raised
    });
  });

  // ── HOST: media command → tracker (one-at-a-time enforced) ────────────────
  socket.on('host:media_cmd', ({ targetId, cmd }) => {
    const session = getSession(socket);
    if (!session) return;

    // ── Camera one-at-a-time ────────────────────────────────────────────────
    if (cmd === 'cam_on') {
      if (session.activeCamId && session.activeCamId !== targetId) {
        // Stop the currently active camera first
        io.to(session.activeCamId).emit('tracker:media_cmd', { cmd: 'cam_off' });
        const prev = session.trackers.get(session.activeCamId);
        if (prev) prev.camOn = false;
        io.to(session.hostSocketId).emit('host:media_state', {
          id: session.activeCamId,
          camOn: false, camFacing: prev?.camFacing ?? 'environment', micOn: prev?.micOn ?? false
        });
      }
      session.activeCamId = targetId;

    } else if (cmd === 'cam_off' && session.activeCamId === targetId) {
      session.activeCamId = null;
    }

    // ── Mic one-at-a-time ───────────────────────────────────────────────────
    if (cmd === 'mic_on') {
      if (session.activeMicId && session.activeMicId !== targetId) {
        // Stop the currently active mic first
        io.to(session.activeMicId).emit('tracker:media_cmd', { cmd: 'mic_off' });
        const prev = session.trackers.get(session.activeMicId);
        if (prev) prev.micOn = false;
        io.to(session.hostSocketId).emit('host:media_state', {
          id: session.activeMicId,
          camOn: prev?.camOn ?? false, camFacing: prev?.camFacing ?? 'environment', micOn: false
        });
      }
      session.activeMicId = targetId;

    } else if (cmd === 'mic_off' && session.activeMicId === targetId) {
      session.activeMicId = null;
    }

    // Relay command to the target tracker
    io.to(targetId).emit('tracker:media_cmd', { cmd });
  });

  // ── HOST: kick a specific tracker ──────────────────────────────────────────
  // Triggered when dashboard clicks the ✕ button on a tracker card
  socket.on('host:kick_tracker', ({ targetId }) => {
    const session = getSession(socket);
    if (!session) return;

    // Notify the tracker they have been removed
    io.to(targetId).emit('tracker:kicked');

    // Clean up session state
    if (session.activeCamId === targetId) session.activeCamId = null;
    if (session.activeMicId === targetId) session.activeMicId = null;
    session.trackers.delete(targetId);

    // Tell dashboard the tracker is gone
    io.to(session.hostSocketId).emit('host:tracker_left', { id: targetId });

    // Force-disconnect the tracker's socket
    const trackerSocket = io.sockets.sockets.get(targetId);
    if (trackerSocket) trackerSocket.disconnect(true);

    console.log(`[x] Tracker kicked: ${targetId} from ${socket.sessionId}`);
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────────
  // Server is just a relay — media flows peer-to-peer (or via TURN).
  // Note: the dashboard is responsible for sending webrtc:offer AFTER
  // host:media_cmd so the tracker has time to open camera first.
  socket.on('webrtc:offer',  ({ targetId, offer })     => io.to(targetId).emit('webrtc:offer',  { fromId: socket.id, offer }));
  socket.on('webrtc:answer', ({ targetId, answer })    => io.to(targetId).emit('webrtc:answer', { fromId: socket.id, answer }));
  socket.on('webrtc:ice',    ({ targetId, candidate }) => io.to(targetId).emit('webrtc:ice',    { fromId: socket.id, candidate }));

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.role === 'host') {
      // Host left → notify all trackers so they can show "session terminated"
      // (not just "reconnecting") — this is the key distinction for issue 4
      io.to(socket.sessionId).emit('session:ended', {
        message: 'The organiser has closed the session. You can close this page.'
      });
      sessions.delete(socket.sessionId);
      console.log(`[-] Session ended (host left): ${socket.sessionId}`);

    } else if (socket.role === 'tracker') {
      const session = getSession(socket);
      if (session) {
        if (session.activeCamId === socket.id) session.activeCamId = null;
        if (session.activeMicId === socket.id) session.activeMicId = null;
        session.trackers.delete(socket.id);
        io.to(session.hostSocketId).emit('host:tracker_left', { id: socket.id });
      }
      console.log(`[-] Tracker left: ${socket.trackerName} (${socket.id})`);
    }
  });
});
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`LiveTrack V8 server running on port ${PORT}`));