'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'breachpoint' }));

const WORLD = { min: -23, max: 23, size: 48 };
// Shared collision geometry for the server and client. All coordinates are metres.
const OBSTACLES = [
  { id:'north-boundary', x:0, z:-23.8, w:48, d:1, h:4.5, kind:'wall' },
  { id:'south-boundary', x:0, z:23.8, w:48, d:1, h:4.5, kind:'wall' },
  { id:'west-boundary', x:-23.8, z:0, w:1, d:48, h:4.5, kind:'wall' },
  { id:'east-boundary', x:23.8, z:0, w:1, d:48, h:4.5, kind:'wall' },
  { id:'west-north-wall', x:-13, z:-5.3, w:1.3, d:7.2, h:3.3, kind:'wall' },
  { id:'west-center-cover', x:-6.5, z:-10, w:7.2, d:1.3, h:3.2, kind:'wall' },
  { id:'west-south-wall', x:-7.2, z:8.2, w:1.3, d:7.3, h:3.3, kind:'wall' },
  { id:'west-south-cover', x:-12.1, z:13.1, w:6.5, d:1.3, h:3.1, kind:'wall' },
  { id:'east-north-wall', x:13, z:-5.3, w:1.3, d:7.2, h:3.3, kind:'wall' },
  { id:'east-center-cover', x:6.5, z:-10, w:7.2, d:1.3, h:3.2, kind:'wall' },
  { id:'east-south-wall', x:7.2, z:8.2, w:1.3, d:7.3, h:3.3, kind:'wall' },
  { id:'east-south-cover', x:12.1, z:13.1, w:6.5, d:1.3, h:3.1, kind:'wall' },
  { id:'mid-north-cover', x:0, z:-6.6, w:4.4, d:1.3, h:2.5, kind:'cover' },
  { id:'mid-south-cover', x:0, z:6.6, w:4.4, d:1.3, h:2.5, kind:'cover' },
  { id:'mid-crate-west', x:-3.4, z:0.2, w:1.8, d:2.1, h:1.5, kind:'crate' },
  { id:'mid-crate-east', x:3.4, z:-0.2, w:1.8, d:2.1, h:1.5, kind:'crate' },
  { id:'west-crate-north', x:-17, z:-12, w:2.5, d:2.5, h:1.7, kind:'crate' },
  { id:'west-crate-south', x:-17, z:11, w:2.5, d:2.5, h:1.7, kind:'crate' },
  { id:'east-crate-north', x:17, z:-12, w:2.5, d:2.5, h:1.7, kind:'crate' },
  { id:'east-crate-south', x:17, z:11, w:2.5, d:2.5, h:1.7, kind:'crate' },
  { id:'north-center-small', x:0, z:-15.2, w:3.5, d:2, h:1.3, kind:'crate' },
  { id:'south-center-small', x:0, z:15.2, w:3.5, d:2, h:1.3, kind:'crate' }
];
app.get('/api/config', (_req, res) => res.json({ world: WORLD, obstacles: OBSTACLES, sites: { A: { x:-10, z:0 }, B: { x:10, z:0 } } }));

const WEAPONS = {
  rifle: { label:'RIFLE', damage:34, cooldown:115, mag:30, reserve:90, reloadMs:1800, spread:0.012, maxRange:105 },
  pistol: { label:'SIDEARM', damage:48, cooldown:270, mag:12, reserve:36, reloadMs:1350, spread:0.019, maxRange:65 },
  marksman: { label:'MARKSMAN', damage:82, cooldown:640, mag:5, reserve:25, reloadMs:2250, spread:0.004, maxRange:140 }
};
const rooms = new Map();
const socketRoom = new Map();
const roundLoop = setInterval(() => { for (const room of rooms.values()) tickRoom(room); }, 100);
roundLoop.unref?.();

function cleanName(name) {
  return String(name || 'Operator').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 16) || 'Operator';
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i=0; i<6; i++) code += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();
}
function distance2(ax, az, bx, bz) { return Math.hypot(ax-bx, az-bz); }
function blocked(x, z, radius = 0.42) {
  if (x < WORLD.min + radius || x > WORLD.max - radius || z < WORLD.min + radius || z > WORLD.max - radius) return true;
  return OBSTACLES.some(o => Math.abs(x-o.x) < o.w/2 + radius && Math.abs(z-o.z) < o.d/2 + radius);
}
function roleOf(room, player) {
  const alphaAttacks = room.round <= 3;
  return ((player.team === 'Alpha') === alphaAttacks) ? 'Attackers' : 'Defenders';
}
function spawnFor(room, player) {
  const role = roleOf(room, player);
  const slot = Math.max(0, [...room.players.values()].filter(p => p.team === player.team).findIndex(p => p.id === player.id));
  const offset = (slot - 1) * 3.2;
  if (role === 'Attackers') return { x:-19, z:offset, yaw:-Math.PI/2 };
  return { x:19, z:offset, yaw:Math.PI/2 };
}
function createPlayer(socket, name) {
  return {
    id:socket.id, name:cleanName(name), team:null, x:0, z:0, yaw:0, pitch:0, crouched:false,
    alive:true, health:100, kills:0, deaths:0, assists:0, score:0, weapon:'rifle',
    ammo:{ rifle:30, pistol:12, marksman:5 }, reserve:{ rifle:90, pistol:36, marksman:25 },
    lastShot:0, reloading:false, reloadToken:0, interacting:null, connected:true
  };
}
function createRoom(socket, name) {
  const code = makeCode();
  const player = createPlayer(socket, name);
  const room = {
    code, owner:socket.id, players:new Map([[socket.id, player]]), createdAt:Date.now(), phase:'lobby',
    round:0, score:{ Alpha:0, Bravo:0 }, roundStartedAt:0, roundDuration:100000, planted:null,
    phaseUntil:0, roundWinner:null, roundReason:'', matchWinner:null, log:[], sidesSwapped:false,
    lastStateAt:0
  };
  rooms.set(code, room); socketRoom.set(socket.id, code); socket.join(code);
  pushLog(room, `${player.name} created room ${code}.`);
  return room;
}
function pushLog(room, text, type='info') {
  room.log.unshift({ text:String(text).slice(0,180), type, at:Date.now() });
  room.log.length = Math.min(room.log.length, 8);
  io.to(room.code).emit('game:log', room.log[0]);
}
function roomView(room) {
  return {
    code:room.code, owner:room.owner, phase:room.phase, round:room.round, score:room.score,
    roundDuration:room.roundDuration, roundStartedAt:room.roundStartedAt, phaseUntil:room.phaseUntil,
    roundWinner:room.roundWinner, roundReason:room.roundReason, matchWinner:room.matchWinner,
    planted:room.planted ? { x:room.planted.x, z:room.planted.z, at:room.planted.at, explodesAt:room.planted.explodesAt, site:room.planted.site } : null,
    log:room.log,
    players:[...room.players.values()].map(p => ({ id:p.id, name:p.name, team:p.team, role:room.phase==='lobby' ? 'Waiting' : roleOf(room,p), alive:p.alive, health:p.health, kills:p.kills, deaths:p.deaths, score:p.score, weapon:p.weapon, ammo:p.ammo[p.weapon], reserve:p.reserve[p.weapon], reloading:p.reloading, interacting:p.interacting ? p.interacting.action : null, x:p.x, z:p.z, yaw:p.yaw, crouched:p.crouched, connected:p.connected }))
  };
}
function publishRoom(room) { io.to(room.code).emit('room:update', roomView(room)); }
function publishGameState(room) {
  const now = Date.now();
  const state = roomView(room);
  state.timeLeft = room.phase === 'live' ? Math.max(0, Math.ceil((room.roundStartedAt + room.roundDuration - now)/1000)) : 0;
  state.bombTimeLeft = room.planted ? Math.max(0, Math.ceil((room.planted.explodesAt-now)/1000)) : null;
  io.to(room.code).emit('match:state', state);
}
function aliveCount(room, team) { return [...room.players.values()].filter(p => p.team === team && p.alive).length; }
function resetPlayerForRound(room, p) {
  const spawn = spawnFor(room,p);
  Object.assign(p, spawn, { health:100, alive:true, weapon:'rifle', ammo:{rifle:30,pistol:12,marksman:5}, reserve:{rifle:90,pistol:36,marksman:25}, reloading:false, interacting:null, crouched:false, lastShot:0 });
  p.reloadToken++;
}
function startMatch(room) {
  if (room.players.size < 2 || room.phase !== 'lobby') return;
  const players = [...room.players.values()];
  players.forEach((p, i) => { p.team = i % 2 === 0 ? 'Alpha' : 'Bravo'; p.kills = 0; p.deaths = 0; p.score = 0; });
  room.score = { Alpha:0, Bravo:0 }; room.round = 1; room.matchWinner = null;
  pushLog(room, 'MATCH START — first to 5 rounds wins.', 'good');
  startRound(room);
}
function startRound(room) {
  room.phase = 'live'; room.planted = null; room.roundWinner = null; room.roundReason = ''; room.phaseUntil = 0;
  room.roundStartedAt = Date.now(); room.roundDuration = 105000;
  for (const p of room.players.values()) resetPlayerForRound(room,p);
  pushLog(room, `Round ${room.round}: ${roleOf(room,[...room.players.values()][0])} opening deployment.`, 'good');
  io.to(room.code).emit('match:started', roomView(room));
  publishGameState(room);
}
function finishRound(room, winner, reason) {
  if (room.phase !== 'live') return;
  room.phase = 'roundEnd'; room.roundWinner = winner; room.roundReason = reason; room.phaseUntil = Date.now() + 5000;
  room.score[winner]++;
  pushLog(room, `${winner} win the round — ${reason}.`, 'good');
  publishGameState(room);
  if (room.score[winner] >= 5) {
    room.phase = 'matchEnd'; room.matchWinner = winner; room.phaseUntil = 0;
    pushLog(room, `${winner} win the match.`, 'good');
    publishRoom(room); publishGameState(room);
  }
}
function tickRoom(room) {
  if (room.phase !== 'live') {
    if (room.phase === 'roundEnd' && room.phaseUntil && Date.now() >= room.phaseUntil) {
      room.round++;
      if (room.round === 4) {
        pushLog(room, 'SIDES SWITCHED — attackers and defenders swap.', 'good');
      }
      startRound(room);
    } else if (room.phase === 'matchEnd' && room.phaseUntil && Date.now() >= room.phaseUntil) {
      room.phaseUntil = 0;
    }
    return;
  }
  const now = Date.now();
  if (room.planted && now >= room.planted.explodesAt) {
    finishRound(room, room.planted.plantedByTeam, 'device detonated');
    return;
  }
  // Hold-to-interact is server timed and cancelled if the player moves away.
  for (const p of room.players.values()) {
    if (!p.alive || !p.interacting) continue;
    const action = p.interacting.action;
    let valid = false, duration = action === 'plant' ? 3000 : 5000;
    if (action === 'plant' && roleOf(room,p) === 'Attackers' && !room.planted) {
      const site = nearestSite(p.x,p.z,3.0); valid = !!site;
      if (valid) p.interacting.site = site.key;
    } else if (action === 'defuse' && roleOf(room,p) === 'Defenders' && room.planted) {
      valid = distance2(p.x,p.z,room.planted.x,room.planted.z) < 2.7;
    }
    if (!valid) { p.interacting = null; continue; }
    if (now - p.interacting.startedAt >= duration) {
      if (action === 'plant' && !room.planted) {
        const siteKey = p.interacting.site || (nearestSite(p.x,p.z,3.0) || {key:'A'}).key;
        room.planted = { x:p.x, z:p.z, site:siteKey, at:now, explodesAt:now+35000, plantedByTeam:p.team };
        p.interacting = null;
        pushLog(room, `${p.name} planted the device at Site ${siteKey}.`, 'bad');
        io.to(room.code).emit('bomb:planted', {site:siteKey,x:p.x,z:p.z,explodesAt:room.planted.explodesAt});
      } else if (action === 'defuse' && room.planted) {
        room.planted = null; p.interacting = null;
        pushLog(room, `${p.name} defused the device.`, 'good');
        finishRound(room, 'Bravo' === p.team ? 'Bravo' : 'Alpha', 'device defused');
      }
    }
  }
  if (room.phase !== 'live') return;
  if (!room.planted && now >= room.roundStartedAt + room.roundDuration) {
    finishRound(room, teamForRole(room,'Defenders'), 'time expired'); return;
  }
  const attackerTeam = teamForRole(room,'Attackers'), defenderTeam = teamForRole(room,'Defenders');
  const aliveAttackers = aliveCount(room,attackerTeam), aliveDefenders = aliveCount(room,defenderTeam);
  if (aliveAttackers === 0 && !room.planted) finishRound(room, defenderTeam, 'attackers eliminated');
  else if (aliveDefenders === 0 && !room.planted) finishRound(room, attackerTeam, 'defenders eliminated');
  else if (aliveDefenders === 0 && room.planted) {
    // Let the planted device resolve, so the attackers still need to protect it.
  }
  if (now - room.lastStateAt >= 150) { room.lastStateAt = now; publishGameState(room); }
}
function teamForRole(room, role) {
  const alphaAttacks = room.round <= 3;
  return role === 'Attackers' ? (alphaAttacks ? 'Alpha' : 'Bravo') : (alphaAttacks ? 'Bravo' : 'Alpha');
}
function nearestSite(x,z,radius) {
  const sites = [{key:'A',x:-10,z:0},{key:'B',x:10,z:0}];
  let best=null, bd=Infinity;
  for (const s of sites) { const d=distance2(x,z,s.x,s.z); if (d<radius && d<bd) {best=s;bd=d;} }
  return best;
}
function getRoom(socket) { const code = socketRoom.get(socket.id); return code ? rooms.get(code) : null; }
function getPlayer(room,socket) { return room?.players.get(socket.id); }
function removePlayer(socket) {
  const code = socketRoom.get(socket.id); if (!code) return;
  const room = rooms.get(code); socketRoom.delete(socket.id);
  if (!room) return;
  const p = room.players.get(socket.id);
  if (p) pushLog(room, `${p.name} disconnected.`, 'bad');
  room.players.delete(socket.id); socket.leave(code);
  if (!room.players.size) { rooms.delete(code); return; }
  if (room.owner === socket.id) room.owner = room.players.keys().next().value;
  if (room.phase === 'matchEnd' && room.players.size > 0) {
    room.phase = 'lobby'; room.round = 0; room.score = { Alpha:0, Bravo:0 }; room.planted = null; room.matchWinner = null; room.phaseUntil = 0;
    for (const remaining of room.players.values()) { remaining.team = null; remaining.alive = true; remaining.health = 100; remaining.interacting = null; }
    pushLog(room, 'A new briefing is available. Start another operation when ready.', 'good');
  }
  if (room.phase === 'live' && room.players.size < 2) {
    room.phase='lobby'; room.round=0; room.planted=null;
    pushLog(room, 'Match paused because only one operator remains.', 'bad');
  }
  publishRoom(room); publishGameState(room);
}
function segmentBlocked(from, direction, distance) {
  const steps = Math.ceil(distance / 0.22);
  for (let i=1;i<steps;i++) {
    const t=distance*i/steps, x=from.x+direction.x*t, z=from.z+direction.z*t, y=from.y+direction.y*t;
    for (const o of OBSTACLES) {
      if (Math.abs(x-o.x) <= o.w/2 && Math.abs(z-o.z) <= o.d/2 && y <= o.h && y >= 0) return true;
    }
  }
  return false;
}
function raySphere(origin, dir, center, radius) {
  const ox=origin.x-center.x, oy=origin.y-center.y, oz=origin.z-center.z;
  const b=ox*dir.x+oy*dir.y+oz*dir.z;
  const c=ox*ox+oy*oy+oz*oz-radius*radius;
  const disc=b*b-c;
  if (disc<0) return null;
  const t=-b-Math.sqrt(disc);
  if (t>0) return t;
  const t2=-b+Math.sqrt(disc); return t2>0 ? t2 : null;
}
function shoot(room, shooter) {
  const now=Date.now(), weapon=WEAPONS[shooter.weapon] || WEAPONS.rifle;
  if (room.phase!=='live' || !shooter.alive) return {ok:false,reason:'not-live'};
  if (shooter.reloading) return {ok:false,reason:'reloading'};
  if (now-shooter.lastShot<weapon.cooldown) return {ok:false,reason:'cooldown'};
  if (shooter.ammo[shooter.weapon]<=0) return {ok:false,reason:'empty'};
  shooter.lastShot=now; shooter.ammo[shooter.weapon]--;
  const yaw=shooter.yaw, pitch=shooter.pitch;
  const dir={ x:-Math.sin(yaw)*Math.cos(pitch), y:Math.sin(pitch), z:-Math.cos(yaw)*Math.cos(pitch) };
  // Small server-side weapon spread. The client draws the confirmed server ray.
  const spread=weapon.spread;
  dir.x += (Math.random()-.5)*spread; dir.y += (Math.random()-.5)*spread; dir.z += (Math.random()-.5)*spread;
  const len=Math.hypot(dir.x,dir.y,dir.z); dir.x/=len; dir.y/=len; dir.z/=len;
  const origin={x:shooter.x,y:shooter.crouched?1.05:1.58,z:shooter.z};
  let bestDist=weapon.maxRange, target=null, targetDistance=null;
  for (const p of room.players.values()) {
    if (p.id===shooter.id || p.team===shooter.team || !p.alive) continue;
    const center={x:p.x,y:p.crouched ? .76 : 1.02,z:p.z};
    const dist=raySphere(origin,dir,center,p.crouched ? .86 : .72);
    if (dist!==null && dist<bestDist && !segmentBlocked(origin,dir,dist)) { bestDist=dist; targetDistance=dist; target=p; }
  }
  const wallHit=(()=>{const steps=Math.ceil(weapon.maxRange/.22); for(let i=1;i<=steps;i++){const t=weapon.maxRange*i/steps,x=origin.x+dir.x*t,z=origin.z+dir.z*t,y=origin.y+dir.y*t; for(const o of OBSTACLES){if(Math.abs(x-o.x)<=o.w/2&&Math.abs(z-o.z)<=o.d/2&&y<=o.h&&y>=0)return t;}}return null;})();
  if (wallHit!==null && wallHit<bestDist) { bestDist=wallHit; target=null; }
  const end={x:origin.x+dir.x*bestDist,y:origin.y+dir.y*bestDist,z:origin.z+dir.z*bestDist};
  io.to(room.code).emit('shot:fx',{shooterId:shooter.id,weapon:shooter.weapon,from:origin,to:end,hit:!!target&&bestDist<weapon.maxRange,targetId:target&&bestDist<weapon.maxRange?target.id:null});
  let didHit=false, killed=false;
  if (target && targetDistance!==null && bestDist===targetDistance && bestDist<weapon.maxRange) {
    didHit=true; target.health=Math.max(0,target.health-weapon.damage);
    if (target.health===0) {
      target.alive=false; target.deaths++; target.interacting=null; shooter.kills++; shooter.score+=100;
      killed=true;
      pushLog(room, `${shooter.name} eliminated ${target.name}.`, 'bad');
      io.to(room.code).emit('player:eliminated',{shooterId:shooter.id,targetId:target.id,shooterName:shooter.name,targetName:target.name,weapon:shooter.weapon});
    } else {
      shooter.score+=10;
    }
  }
  io.to(shooter.id).emit('shot:result',{ok:true,hit:didHit,killed,damage:didHit?weapon.damage:0,targetId:target&&didHit?target.id:null,targetHealth:target&&didHit?target.health:null,ammo:shooter.ammo[shooter.weapon],reserve:shooter.reserve[shooter.weapon]});
  io.to(room.code).emit('players:update', roomView(room).players);
  return {ok:true};
}

io.on('connection', socket => {
  socket.emit('server:hello',{name:'Breachpoint',version:'1.0.0'});
  socket.on('room:create',(data={},ack=()=>{})=>{
    if (socketRoom.has(socket.id)) removePlayer(socket);
    const room=createRoom(socket,data.name);
    publishRoom(room); ack({ok:true,code:room.code,state:roomView(room)});
  });
  socket.on('room:join',(data={},ack=()=>{})=>{
    const code=String(data.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
    const room=rooms.get(code);
    if (!room) { ack({ok:false,error:'Room not found. Check the code and try again.'}); return; }
    if (room.phase!=='lobby') { ack({ok:false,error:'That match has already started.'}); return; }
    if (room.players.size>=10) { ack({ok:false,error:'This room is full (10 players max).'}); return; }
    if (socketRoom.has(socket.id)) removePlayer(socket);
    const p=createPlayer(socket,data.name); room.players.set(socket.id,p); socketRoom.set(socket.id,code); socket.join(code);
    pushLog(room,`${p.name} joined the room.`,'good'); publishRoom(room); ack({ok:true,code,state:roomView(room)});
  });
  socket.on('match:start',()=>{
    const room=getRoom(socket); if(!room||room.owner!==socket.id||room.phase!=='lobby')return;
    if(room.players.size<2){socket.emit('ui:error',{message:'At least two players are required.'});return;}
    startMatch(room); publishRoom(room);
  });
  socket.on('room:leave',()=>removePlayer(socket));
  socket.on('player:input',(data={})=>{
    const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p)return;
    if(room.phase==='live'&&p.alive){
      let x=Number(data.x),z=Number(data.z);if(!Number.isFinite(x)||!Number.isFinite(z))return;
      const dt=Math.min(.25,Math.max(.03,(Date.now()-(p.lastInputAt||Date.now()-80))/1000));
      const limit=(data.sprinting?7.8:data.crouched?2.8:5.2)*dt+0.7;
      const dist=distance2(p.x,p.z,x,z);
      if(dist>limit){const ratio=limit/dist;x=p.x+(x-p.x)*ratio;z=p.z+(z-p.z)*ratio;}
      // Axis-resolve collision so sliding against walls remains possible.
      let nx=x,nz=p.z;if(!blocked(nx,nz))p.x=nx;
      nx=p.x;nz=z;if(!blocked(nx,nz))p.z=nz;
      p.yaw=Number.isFinite(Number(data.yaw))?Number(data.yaw):p.yaw;
      p.pitch=Number.isFinite(Number(data.pitch))?Math.max(-1.42,Math.min(1.42,Number(data.pitch))):p.pitch;
      p.crouched=!!data.crouched;p.lastInputAt=Date.now();
    }
  });
  socket.on('player:weapon',(data={})=>{const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||!WEAPONS[data.weapon]||!p.alive)return;p.weapon=data.weapon;socket.emit('player:status',{weapon:p.weapon,ammo:p.ammo[p.weapon],reserve:p.reserve[p.weapon],health:p.health,alive:p.alive,reloading:p.reloading});});
  socket.on('player:shoot',()=>{const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p)return;const result=shoot(room,p);if(!result.ok)socket.emit('shot:result',{ok:false,reason:result.reason,ammo:p.ammo[p.weapon],reserve:p.reserve[p.weapon]});else socket.emit('player:status',{weapon:p.weapon,ammo:p.ammo[p.weapon],reserve:p.reserve[p.weapon],health:p.health,alive:p.alive,reloading:p.reloading});});
  socket.on('player:reload',()=>{
    const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||room.phase!=='live'||!p.alive||p.reloading)return;
    const w=WEAPONS[p.weapon];if(p.ammo[p.weapon]>=w.mag||p.reserve[p.weapon]<=0)return;
    p.reloading=true;const token=++p.reloadToken;socket.emit('player:status',{weapon:p.weapon,ammo:p.ammo[p.weapon],reserve:p.reserve[p.weapon],health:p.health,alive:p.alive,reloading:true});
    setTimeout(()=>{const current=rooms.get(room.code)?.players.get(p.id);if(!current||current.reloadToken!==token)return;const need=w.mag-current.ammo[p.weapon],take=Math.min(need,current.reserve[p.weapon]);current.ammo[p.weapon]+=take;current.reserve[p.weapon]-=take;current.reloading=false;io.to(current.id).emit('player:status',{weapon:current.weapon,ammo:current.ammo[current.weapon],reserve:current.reserve[current.weapon],health:current.health,alive:current.alive,reloading:false});},w.reloadMs);
  });
  socket.on('player:interact-start',()=>{
    const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||room.phase!=='live'||!p.alive||p.interacting)return;
    if(roleOf(room,p)==='Attackers'&&!room.planted){const site=nearestSite(p.x,p.z,3.0);if(site){p.interacting={action:'plant',startedAt:Date.now(),site:site.key};socket.emit('interact:status',{action:'plant',duration:3000,site:site.key});}}
    else if(roleOf(room,p)==='Defenders'&&room.planted&&distance2(p.x,p.z,room.planted.x,room.planted.z)<2.7){p.interacting={action:'defuse',startedAt:Date.now()};socket.emit('interact:status',{action:'defuse',duration:5000});}
  });
  socket.on('player:interact-stop',()=>{const room=getRoom(socket),p=getPlayer(room,socket);if(p)p.interacting=null;socket.emit('interact:status',{action:null});});
  socket.on('disconnect',()=>removePlayer(socket));
});

httpServer.listen(PORT,'0.0.0.0',()=>console.log(`Breachpoint listening on ${PORT}`));
