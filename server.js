const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const MAPS_API_KEY = process.env.MAPS_API_KEY || '';

// 25 hand-picked locations with good Street View coverage
const LOCATIONS = [
  { lat: 48.8584,  lng: 2.2945,   heading: 265, pitch: 0 },   // Paris – near Eiffel Tower
  { lat: 51.5007,  lng: -0.1246,  heading: 230, pitch: 5 },   // London – Westminster
  { lat: 40.7580,  lng: -73.9855, heading: 180, pitch: 0 },   // New York – Times Square
  { lat: 35.6762,  lng: 139.6503, heading: 90,  pitch: 0 },   // Tokyo – Shibuya
  { lat: -33.8568, lng: 151.2153, heading: 340, pitch: 0 },   // Sydney Harbour
  { lat: 55.7520,  lng: 37.6175,  heading: 270, pitch: 0 },   // Moscow – Red Square
  { lat: 41.8902,  lng: 12.4923,  heading: 330, pitch: 0 },   // Rome – Colosseum
  { lat: 52.5163,  lng: 13.3777,  heading: 270, pitch: 0 },   // Berlin – Brandenburg Gate
  { lat: 37.9715,  lng: 23.7267,  heading: 180, pitch: 20 },  // Athens – Acropolis
  { lat: 25.1972,  lng: 55.2744,  heading: 250, pitch: 5 },   // Dubai – Burj Khalifa
  { lat: 1.2800,   lng: 103.8501, heading: 180, pitch: 0 },   // Singapore
  { lat: 37.8199,  lng: -122.4783,heading: 160, pitch: 0 },   // San Francisco – Golden Gate
  { lat: 19.4326,  lng: -99.1332, heading: 90,  pitch: 0 },   // Mexico City
  { lat: -22.9068, lng: -43.1729, heading: 175, pitch: 0 },   // Rio de Janeiro
  { lat: 64.1282,  lng: -22.0210, heading: 45,  pitch: 0 },   // Reykjavik
  { lat: -33.9249, lng: 18.4241,  heading: 180, pitch: 0 },   // Cape Town
  { lat: 30.0444,  lng: 31.2357,  heading: 90,  pitch: 0 },   // Cairo
  { lat: 59.3293,  lng: 18.0686,  heading: 180, pitch: 0 },   // Stockholm
  { lat: 43.7696,  lng: 11.2558,  heading: 90,  pitch: 0 },   // Florence
  { lat: 48.2082,  lng: 16.3738,  heading: 270, pitch: 0 },   // Vienna
  { lat: 34.6937,  lng: 135.5023, heading: 90,  pitch: 0 },   // Osaka
  { lat: -13.1631, lng: -72.5450, heading: 315, pitch: 15 },  // Machu Picchu
  { lat: 29.9792,  lng: 31.1342,  heading: 225, pitch: 5 },   // Giza Pyramids
  { lat: 40.4319,  lng: 116.5704, heading: 90,  pitch: 0 },   // Great Wall China
  { lat: 27.1751,  lng: 78.0421,  heading: 180, pitch: 5 },   // Taj Mahal
];

const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcScore(km) {
  return Math.round(5000 * Math.exp(-km / 2000));
}

function shuffled(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function getLeaderboard(room) {
  return Array.from(room.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

io.on('connection', (socket) => {

  // ── HOST: create room ──────────────────────────────────────────
  socket.on('create-room', ({ rounds }) => {
    let code;
    do { code = makeCode(); } while (rooms.has(code));

    const room = {
      hostId: socket.id,
      apiKey: MAPS_API_KEY,
      totalRounds: Math.min(Math.max(parseInt(rounds) || 5, 1), 10),
      players: new Map(),
      state: 'lobby',
      round: 0,
      locations: shuffled(LOCATIONS),
      guesses: new Map(),
      timer: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    socket.emit('room-created', { code });
  });

  // ── PLAYER: join room ──────────────────────────────────────────
  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit('join-error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('join-error', 'Game already in progress'); return; }
    name = (name || '').trim().substring(0, 20);
    if (!name) { socket.emit('join-error', 'Name is required'); return; }

    room.players.set(socket.id, { name, score: 0 });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'player';

    const playerList = Array.from(room.players.values()).map(p => p.name);
    io.to(code).emit('players-update', { players: playerList });
    socket.emit('joined-room', { code, name });
  });

  // ── HOST: start game ───────────────────────────────────────────
  socket.on('start-game', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size === 0) { socket.emit('start-error', 'No players have joined yet'); return; }
    beginRound(socket.data.code, room);
  });

  // ── PLAYER: submit guess ───────────────────────────────────────
  socket.on('submit-guess', ({ lat, lng }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.state !== 'playing') return;
    if (room.guesses.has(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const loc = room.locations[room.round - 1];
    const km = haversine(lat, lng, loc.lat, loc.lng);
    const score = calcScore(km);
    const roundDelta = score;

    room.guesses.set(socket.id, { lat, lng, score, km, name: player.name });
    player.score += score;

    socket.emit('guess-accepted', { score: roundDelta, distance: Math.round(km) });
    io.to(room.hostId).emit('guess-progress', {
      playerName: player.name,
      guessCount: room.guesses.size,
      totalPlayers: room.players.size,
    });

    if (room.guesses.size >= room.players.size) {
      if (room.timer) { clearInterval(room.timer); room.timer = null; }
      finishRound(code, room);
    }
  });

  // ── HOST: advance to next round ────────────────────────────────
  socket.on('next-round', () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.round >= room.totalRounds) {
      endGame(code, room);
    } else {
      beginRound(code, room);
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data?.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.role === 'host') {
      if (room.timer) clearInterval(room.timer);
      io.to(code).emit('host-left');
      rooms.delete(code);
    } else {
      room.players.delete(socket.id);
      if (room.state === 'lobby') {
        const playerList = Array.from(room.players.values()).map(p => p.name);
        io.to(code).emit('players-update', { players: playerList });
      }
    }
  });
});

function beginRound(code, room) {
  room.state = 'playing';
  room.round++;
  room.guesses.clear();

  const loc = room.locations[room.round - 1];

  // Host gets location + API key
  io.to(room.hostId).emit('round-start', {
    round: room.round,
    total: room.totalRounds,
    lat: loc.lat,
    lng: loc.lng,
    heading: loc.heading,
    pitch: loc.pitch,
    apiKey: room.apiKey,
  });

  // Players just get the round number
  room.players.forEach((_, sid) => {
    io.to(sid).emit('round-start', { round: room.round, total: room.totalRounds });
  });

  // Server-side countdown
  let timeLeft = 60;
  io.to(code).emit('timer-tick', { timeLeft });
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timer-tick', { timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      finishRound(code, room);
    }
  }, 1000);
}

function finishRound(code, room) {
  room.state = 'results';
  const loc = room.locations[room.round - 1];

  const guesses = Array.from(room.guesses.values()).map(g => ({
    name: g.name,
    lat: g.lat,
    lng: g.lng,
    score: g.score,
    distance: Math.round(g.km),
  }));

  const leaderboard = getLeaderboard(room);

  // Send round-score delta per player
  room.players.forEach((player, sid) => {
    const g = room.guesses.get(sid);
    io.to(sid).emit('round-results', {
      actualLat: loc.lat,
      actualLng: loc.lng,
      leaderboard,
      roundScore: g ? g.score : 0,
      distance: g ? Math.round(g.km) : null,
      guessed: !!g,
      round: room.round,
      total: room.totalRounds,
      isLast: room.round >= room.totalRounds,
    });
  });

  io.to(room.hostId).emit('round-results', {
    actualLat: loc.lat,
    actualLng: loc.lng,
    guesses,
    leaderboard,
    round: room.round,
    total: room.totalRounds,
    isLast: room.round >= room.totalRounds,
  });
}

function endGame(code, room) {
  room.state = 'finished';
  const leaderboard = getLeaderboard(room);
  io.to(code).emit('game-over', { leaderboard });
  setTimeout(() => rooms.delete(code), 60000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌍 GeoGuesser Live → http://localhost:${PORT}\n`);
});
