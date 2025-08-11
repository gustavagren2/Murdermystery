import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/healthz', (req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

/** ----------------- Game State (in-memory) ----------------- **/
const rooms = new Map();
/*
room = {
  code, hostId, phase, players: Map<socketId, {id,name,alive,role?,voteFor?}>,
  assignments: Map<socketId, role>,
  nightActions: { kill?:socketId, save?:socketId, inspect?:socketId },
  timers: { endsAt?: number },
}
*/
const PHASES = { LOBBY:'LOBBY', NIGHT:'NIGHT', DAY:'DAY', VOTE:'VOTE', RESOLVE:'RESOLVE', END:'END' };

function code4() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}
const getRoom = (c)=>rooms.get(c);
const alivePlayers = (r)=>[...r.players.values()].filter(p=>p.alive);

function broadcastState(room){
  const publicPlayers = [...room.players.values()].map(p=>({
    id:p.id, name:p.name, alive:p.alive, voteFor:p.voteFor ?? null
  }));
  io.to(room.code).emit('room_state', {
    code: room.code,
    phase: room.phase,
    players: publicPlayers
  });
}

function assignRoles(room){
  const ids = [...room.players.keys()].sort(()=>Math.random()-0.5);
  if (ids.length < 4) return;
  room.assignments = new Map();
  room.assignments.set(ids[0],'MURDERER');
  room.assignments.set(ids[1],'DETECTIVE');
  room.assignments.set(ids[2],'DOCTOR');
  for (let i=3;i<ids.length;i++) room.assignments.set(ids[i],'CIVILIAN');
  for (const id of ids) io.to(id).emit('role_assignment', { role: room.assignments.get(id) });
}

function setPhase(room, phase, seconds){
  room.phase = phase;
  if (seconds){
    room.timers = { endsAt: Date.now() + seconds*1000 };
    setTimeout(()=>advance(room.code), seconds*1000);
  }
  broadcastState(room);
}

function resolveVotes(room){
  const tally = {};
  for (const p of room.players.values()){
    if (p.alive && p.voteFor) tally[p.voteFor] = (tally[p.voteFor]||0)+1;
  }
  let max = 0, target = null, tie = false;
  for (const [pid,count] of Object.entries(tally)){
    if (count > max){ max=count; target=pid; tie=false; }
    else if (count === max){ tie=true; }
  }
  if (!target || tie){ io.to(room.code).emit('system_message','no_eject'); return; }
  const victim = room.players.get(target);
  if (victim?.alive){ victim.alive=false; io.to(room.code).emit('system_message',`eject:${victim.name}`); }
}

function applyNight(room){
  const { kill, save } = room.nightActions ?? {};
  if (kill && room.players.get(kill)?.alive){
    if (save === kill) io.to(room.code).emit('system_message','save');
    else {
      room.players.get(kill).alive = false;
      io.to(room.code).emit('system_message','kill');
    }
  }
}

function checkWin(room){
  const alive = alivePlayers(room);
  const murdererIds = [...room.assignments.entries()].filter(([,r])=>r==='MURDERER').map(([id])=>id);
  const aliveM = alive.filter(p=>murdererIds.includes(p.id)).length;
  const aliveC = alive.length - aliveM;
  if (aliveM === 0){ io.to(room.code).emit('system_message','citizens_win'); return true; }
  if (aliveM >= aliveC){ io.to(room.code).emit('system_message','murderer_win'); return true; }
  return false;
}

function advance(code){
  const room = getRoom(code);
  if (!room) return;
  if (room.phase === PHASES.LOBBY) return;

  if (room.phase === PHASES.NIGHT){ setPhase(room, PHASES.DAY, 75); }
  else if (room.phase === PHASES.DAY){ setPhase(room, PHASES.VOTE, 35); }
  else if (room.phase === PHASES.VOTE){ setPhase(room, PHASES.RESOLVE, 3); resolveVotes(room); }
  else if (room.phase === PHASES.RESOLVE){
    if (checkWin(room)) setPhase(room, PHASES.END);
    else {
      room.nightActions = {};
      for (const p of room.players.values()) p.voteFor = undefined;
      setPhase(room, PHASES.NIGHT, 35);
    }
  }
}

/** ----------------- Sockets ----------------- **/
io.on('connection', (socket) => {
  socket.on('create_room', ({ name })=>{
    const code = code4();
    const room = {
      code, hostId: socket.id, phase: PHASES.LOBBY,
      players: new Map(), assignments: new Map(),
      nightActions: {}, timers: {}
    };
    rooms.set(code, room);
    socket.join(code);
    room.players.set(socket.id, { id: socket.id, name: name?.trim()||'HOST', alive:true });
    socket.emit('room_joined', { code, you: socket.id, host: true });
    broadcastState(room);
  });

  socket.on('join_room', ({ code, name })=>{
    const room = getRoom((code||'').toUpperCase());
    if (!room) return socket.emit('error_message','room_not_found');
    socket.join(room.code);
    room.players.set(socket.id, { id: socket.id, name: name?.trim()||'PLAYER', alive:true });
    socket.emit('room_joined', { code: room.code, you: socket.id, host: room.hostId===socket.id });
    broadcastState(room);
  });

  socket.on('start_game', ({ code })=>{
    const room = getRoom(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.players.size < 4) return socket.emit('error_message','need_4_players');
    assignRoles(room);
    setPhase(room, PHASES.NIGHT, 35);
  });

  socket.on('night_action', ({ code, target })=>{
    const room = getRoom(code);
    if (!room || room.phase !== PHASES.NIGHT) return;
    const role = room.assignments.get(socket.id);
    if (!role || !room.players.get(target)?.alive) return;
    if (role === 'MURDERER') room.nightActions.kill = target;
    if (role === 'DOCTOR')   room.nightActions.save = target;
    if (role === 'DETECTIVE'){
      room.nightActions.inspect = target;
      const roleOfTarget = room.assignments.get(target);
      io.to(socket.id).emit('inspect_result', {
        target,
        alignment: roleOfTarget === 'MURDERER' ? 'evil' : 'good'
      });
    }
  });

  socket.on('day_chat', ({ code, message })=>{
    const room = getRoom(code);
    if (!room || room.phase !== PHASES.DAY) return;
    const p = room.players.get(socket.id);
    if (!p?.alive) return;
    io.to(room.code).emit('chat_message', { from: p.name, message: String(message||'').slice(0,300) });
  });

  socket.on('accuse', ({ code, target })=>{
    const room = getRoom(code);
    if (!room || room.phase !== PHASES.DAY) return;
    const a = room.players.get(socket.id);
    const b = room.players.get(target);
    if (!a?.alive || !b?.alive) return;
    io.to(room.code).emit('system_message', `accuse:${a.name}->${b.name}`);
  });

  socket.on('vote', ({ code, target })=>{
    const room = getRoom(code);
    if (!room || room.phase !== PHASES.VOTE) return;
    const voter = room.players.get(socket.id);
    if (!voter?.alive) return;
    voter.voteFor = target || undefined;
    broadcastState(room);
  });

  socket.on('advance', ({ code })=>{
    const room = getRoom(code);
    if (!room || socket.id !== room.hostId) return;
    if (room.phase === PHASES.NIGHT) applyNight(room);
    advance(code);
  });

  socket.on('disconnect', ()=>{
    for (const room of rooms.values()){
      if (room.players.has(socket.id)){
        const wasHost = room.hostId === socket.id;
        room.players.delete(socket.id);
        if (wasHost){
          const next = room.players.keys().next().value;
          room.hostId = next || null;
          if (!next){ rooms.delete(room.code); continue; }
        }
        broadcastState(room);
      }
    }
  });
});
