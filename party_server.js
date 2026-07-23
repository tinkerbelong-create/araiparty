/* パーティモード(まとめモード) オンライン版サーバー — server-authoritative
 * セッション制: setup → eyecatch → ingame → …→ result。得点は10刻み。
 * 収録: ネプリーグ(内蔵) / クアドルカラー・シュゾマス・カウントフルーツ(既存単体版を遊び、順位を入力して加点)。 */
'use strict';
const NP = require('./np_core.js');

module.exports = function attach(io, opts = {}) {
  const rooms = new Map();
  const GAMES = [
    { id: 'nepleague',   name: 'ネプリーグ',       icon: '🧩',   ready: true, external: false },
    { id: 'quadcolor',   name: 'クアドルカラー',   icon: '🟥🟦', ready: true, external: true, url: '/quadcolor/' },
    { id: 'shuzomas',    name: 'シュゾマス',       icon: '🍺',   ready: true, external: true, url: '/shuzomas/' },
    { id: 'countfruits', name: 'カウントフルーツ', icon: '🍓',   ready: true, external: true, url: '/countfruits/' },
  ];
  const READY = GAMES.filter(g => g.ready).map(g => g.id);
  const gameOf = (id) => GAMES.find(g => g.id === id) || GAMES[0];
  const captainable = (id) => id !== 'nepleague'; // ネプリーグは大将戦できない
  const rankPoints = (rank) => (rank === 1 ? 3 : rank === 2 ? 2 : rank === 3 ? 1 : 0) * 10; // 30/20/10/0

  function genCode() { const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = 'P' + Array.from({ length: 4 }, () => cs[Math.floor(Math.random() * cs.length)]).join(''); } while (rooms.has(c)); return c; }
  function ctx(socket) { for (const room of rooms.values()) { if (room.hostSocketId === socket.id) return { room, isHost: true, playerId: null }; if (room.players[socket.id]) return { room, isHost: false, playerId: socket.id }; } return null; }
  function host(socket) { const c = ctx(socket); return (c && c.isHost) ? c.room : null; }
  const orderedPlayers = (room) => Object.values(room.players).sort((a, b) => a.order - b.order);
  const teamMembers = (room, teamId) => orderedPlayers(room).filter(p => p.teamId === teamId && p.connected);
  function unitMembers(room, unitId) {
    if (room.mode !== 'team') { const p = room.players[unitId]; return (p && p.connected) ? [p] : []; }
    const ms = teamMembers(room, unitId);
    if (room.curFormat === 'captain' && captainable(room.curGame)) { const rep = ms.find(p => p.id === room.matchRep[unitId]) || ms[0]; return rep ? [rep] : []; }
    return ms;
  }
  function unitName(room, unitId) { if (room.mode === 'team') return room.teams[unitId] ? room.teams[unitId].name : ''; return room.players[unitId] ? room.players[unitId].name : ''; }
  const unitList = (room) => room.mode === 'team' ? Object.values(room.teams).sort((a,b)=>a.order-b.order).map(t=>t.id) : orderedPlayers(room).map(p=>p.id);
  function addPoints(room, unitId, pts) { if (pts <= 0) return; if (room.mode === 'team' && room.teams[unitId]) room.teams[unitId].score += pts; else if (room.players[unitId]) room.players[unitId].score += pts; }

  function defaultSlots(n) { return Array.from({ length: n }, () => ({ game: 'random', format: 'all' })); }
  function makeRoom(socket, name) {
    return { code: genCode(), phase: 'setup', hostSocketId: socket.id, hostName: String(name || 'ホスト').trim().slice(0, 12) || 'ホスト',
      mode: 'team', players: {}, teams: {}, seq: 1, config: { matchCount: 3, slots: defaultSlots(3) },
      session: { index: 0, plan: [] }, curGame: null, curFormat: 'all', matchRep: {}, game: null, createdAt: Date.now() };
  }

  function publicState(room) {
    const gm = room.curGame ? gameOf(room.curGame) : null;
    const s = JSON.parse(JSON.stringify({
      code: room.code, phase: room.phase, mode: room.mode, hostName: room.hostName,
      players: room.players, teams: room.teams, games: GAMES, config: room.config, session: room.session,
      curGame: room.curGame, curFormat: room.curFormat, matchRep: room.matchRep,
      curGameName: gm ? gm.name : null, curGameIcon: gm ? gm.icon : null, curGameExternal: gm ? !!gm.external : false, curGameUrl: gm ? (gm.url || null) : null,
      game: room.game,
    }));
    if (s.game && s.game.question && !s.game.revealed) delete s.game.question.answer;
    return s;
  }
  function broadcast(room) {
    const base = publicState(room);
    const maskNep = room.curGame === 'nepleague' && base.game && base.game.type === 'nepleague' && !base.game.revealed;
    const viewFor = (youId) => {
      if (!maskNep) return base;
      const pub = JSON.parse(JSON.stringify(base));
      pub.game.slots = pub.game.slots.map(sl => ({ ...sl, filled: !!sl.char, char: (sl.playerId === youId) ? sl.char : '' }));
      return pub;
    };
    if (room.hostSocketId) io.to(room.hostSocketId).emit('pt:state', { pub: viewFor(null), priv: { isHost: true, youId: null } });
    Object.values(room.players).forEach(p => { if (p.connected && p.socketId) io.to(p.socketId).emit('pt:state', { pub: viewFor(p.id), priv: { isHost: false, youId: p.id } }); });
  }

  function newNep() { return { type: 'nepleague', activeUnitId: null, activeUnitName: '', difficulty: 2, genre: NP.GENRES[0], question: null, length: 0, slots: [], revealed: false, results: null, correctAll: false, message: '手番のチームを選んでください' }; }

  function resolveSlot(room, i) {
    const slot = room.config.slots[i] || { game: 'random', format: 'all' };
    const game = (slot.game === 'random' || !READY.includes(slot.game)) ? READY[Math.floor(Math.random() * READY.length)] : slot.game;
    let format = slot.format === 'captain' ? 'captain' : 'all';
    if (!captainable(game)) format = 'all';
    room.session.plan[i] = { game, format }; room.curGame = game; room.curFormat = format;
  }
  function toEyecatch(room, i) { room.session.index = i; resolveSlot(room, i); room.matchRep = {}; room.phase = 'eyecatch'; room.game = null; broadcast(room); }
  function startMatch(room) {
    if (gameOf(room.curGame).external) room.game = { type: 'external', gameId: room.curGame, ranked: false, ranking: null };
    else room.game = newNep();
    room.phase = 'ingame'; broadcast(room);
  }
  function nextOrResult(room) { const next = room.session.index + 1; if (next < room.config.matchCount) toEyecatch(room, next); else { room.phase = 'result'; room.game = null; broadcast(room); } }

  io.on('connection', (socket) => {
    socket.on('pt:createRoom', ({ name } = {}, cb) => { const room = makeRoom(socket, name); rooms.set(room.code, room); socket.join(room.code); cb && cb({ ok: true, code: room.code }); broadcast(room); });
    socket.on('pt:rejoinHost', ({ code } = {}, cb) => { const room = rooms.get(String(code || '').toUpperCase()); if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' }); room.hostSocketId = socket.id; socket.join(room.code); cb && cb({ ok: true, code: room.code }); broadcast(room); });
    socket.on('pt:joinRoom', ({ code, name } = {}, cb) => {
      code = String(code || '').trim().toUpperCase(); name = String(name || '').trim().slice(0, 12);
      const room = rooms.get(code); if (!room) return cb && cb({ ok: false, error: '合言葉が違います' }); if (!name) return cb && cb({ ok: false, error: '名前を入れてください' });
      if (room.phase !== 'setup') return cb && cb({ ok: false, error: 'この部屋はすでに始まっています' });
      if (Object.values(room.players).some(p => p.name === name && p.connected)) name = name + room.seq;
      room.players[socket.id] = { id: socket.id, socketId: socket.id, name, teamId: null, score: 0, connected: true, order: room.seq++ };
      socket.join(room.code); cb && cb({ ok: true, code, playerId: socket.id }); broadcast(room);
    });
    socket.on('pt:setMode', ({ mode } = {}) => { const room = host(socket); if (!room || room.phase !== 'setup') return; room.mode = (mode === 'individual') ? 'individual' : 'team'; broadcast(room); });
    socket.on('pt:addTeam', ({ name } = {}) => { const room = host(socket); if (!room || room.phase !== 'setup') return; const id = 't' + (room.seq++); const n = Object.keys(room.teams).length; room.teams[id] = { id, name: (String(name || '').trim() || ('チーム' + (n + 1))).slice(0, 16), score: 0, order: n }; broadcast(room); });
    socket.on('pt:renameTeam', ({ teamId, name } = {}) => { const room = host(socket); if (!room) return; if (room.teams[teamId]) room.teams[teamId].name = String(name || '').trim().slice(0, 16) || room.teams[teamId].name; broadcast(room); });
    socket.on('pt:removeTeam', ({ teamId } = {}) => { const room = host(socket); if (!room || room.phase !== 'setup') return; delete room.teams[teamId]; Object.values(room.players).forEach(p => { if (p.teamId === teamId) p.teamId = null; }); broadcast(room); });
    socket.on('pt:assignPlayer', ({ playerId, teamId } = {}) => { const room = host(socket); if (!room) return; const p = room.players[playerId]; if (p) { p.teamId = (teamId && room.teams[teamId]) ? teamId : null; broadcast(room); } });
    socket.on('pt:pickTeam', ({ teamId } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const p = c.room.players[c.playerId]; if (p && c.room.teams[teamId]) { p.teamId = teamId; broadcast(c.room); } });
    socket.on('pt:removePlayer', ({ playerId } = {}) => { const room = host(socket); if (!room) return; const p = room.players[playerId]; if (p) { try { io.sockets.sockets.get(p.socketId)?.leave(room.code); } catch (e) {} delete room.players[playerId]; broadcast(room); } });
    socket.on('pt:clearRoster', () => { const room = host(socket); if (!room || room.phase !== 'setup') return; room.players = {}; room.teams = {}; broadcast(room); });
    socket.on('pt:setMatchRep', ({ teamId, playerId } = {}) => { const room = host(socket); if (!room) return; const p = room.players[playerId]; if (p && p.teamId === teamId) { room.matchRep[teamId] = playerId; broadcast(room); } });
    socket.on('pt:volunteerRep', () => { const c = ctx(socket); if (!c || c.isHost) return; const p = c.room.players[c.playerId]; if (p && p.teamId) { c.room.matchRep[p.teamId] = p.id; broadcast(c.room); } });

    socket.on('pt:setConfig', ({ matchCount, slots } = {}) => {
      const room = host(socket); if (!room || room.phase !== 'setup') return;
      if (matchCount === 3 || matchCount === 5) { room.config.matchCount = matchCount; const cur = room.config.slots; room.config.slots = Array.from({ length: matchCount }, (_, i) => cur[i] || { game: 'random', format: 'all' }); }
      if (Array.isArray(slots)) slots.forEach((sl, i) => { if (!room.config.slots[i]) return;
        if (sl.game === 'random' || READY.includes(sl.game)) room.config.slots[i].game = sl.game;
        if (sl.format === 'all' || sl.format === 'captain') room.config.slots[i].format = sl.format;
        if (!captainable(room.config.slots[i].game)) room.config.slots[i].format = 'all'; });
      broadcast(room);
    });

    socket.on('pt:start', (_, cb) => {
      const room = host(socket); if (!room || room.phase !== 'setup') return;
      const humans = Object.values(room.players).filter(p => p.connected); if (humans.length < 1) return cb && cb({ ok: false, error: '参加者がいません' });
      if (room.mode === 'team') { const tw = Object.keys(room.teams).filter(tid => teamMembers(room, tid).length > 0); if (tw.length < 2) return cb && cb({ ok: false, error: 'チームを2つ以上、各チームに参加者が必要です' }); }
      room.session = { index: 0, plan: [] }; cb && cb({ ok: true }); toEyecatch(room, 0);
    });
    socket.on('pt:beginMatch', () => { const room = host(socket); if (!room || room.phase !== 'eyecatch') return; startMatch(room); });
    socket.on('pt:endMatch', () => { const room = host(socket); if (!room || room.phase !== 'ingame') return; nextOrResult(room); });
    socket.on('pt:reset', () => { const room = host(socket); if (!room) return; Object.values(room.players).forEach(p => p.score = 0); Object.values(room.teams).forEach(t => t.score = 0); room.session = { index: 0, plan: [] }; room.curGame = null; room.game = null; room.phase = 'setup'; broadcast(room); });

    /* 外部ゲーム: ホストが順位を入力 → 30/20/10で加点 → 次へ */
    socket.on('pt:submitResult', ({ order } = {}) => {
      const room = host(socket); if (!room || room.phase !== 'ingame' || !room.game || room.game.type !== 'external') return;
      if (!Array.isArray(order)) return;
      const valid = unitList(room);
      const seen = new Set(); const clean = order.filter(id => valid.includes(id) && !seen.has(id) && seen.add(id));
      clean.forEach((unitId, i) => addPoints(room, unitId, rankPoints(i + 1)));
      room.game.ranked = true; room.game.ranking = clean.map((id, i) => ({ id, name: unitName(room, id), rank: i + 1, gained: rankPoints(i + 1) }));
      broadcast(room);
    });

    /* ネプリーグ */
    socket.on('pt:np:selectUnit', ({ unitId } = {}) => { const room = host(socket); if (!room || !room.game || room.game.type !== 'nepleague') return; const g = room.game; g.activeUnitId = unitId; g.activeUnitName = unitName(room, unitId); g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false; g.message = g.activeUnitName + ' の番です。難易度と傾向を選んで問題を出してください'; broadcast(room); });
    socket.on('pt:np:deal', ({ difficulty, genre } = {}) => {
      const room = host(socket); if (!room || !room.game || room.game.type !== 'nepleague') return; const g = room.game;
      if (!g.activeUnitId) { g.message = '先に手番のチームを選んでください'; return broadcast(room); }
      const members = unitMembers(room, g.activeUnitId);
      if (members.length < 3) { g.question = null; g.slots = []; g.message = 'ネプリーグは1人1文字ずつのチーム戦です。3人以上のチームで挑戦してください'; return broadcast(room); }
      g.difficulty = Math.min(5, Math.max(1, Number(difficulty) || 2)); g.genre = NP.GENRES.includes(genre) ? genre : NP.GENRES[0];
      const length = Math.min(members.length, 5);
      const q = NP.pickQuestion(g.difficulty, g.genre, length);
      g.question = { text: q.text, answer: q.answer, genre: q.genre, difficulty: q.difficulty }; g.length = NP.chars(q.answer).length;
      g.slots = []; for (let i = 0; i < g.length; i++) { const owner = members[i % members.length]; g.slots.push({ index: i, playerId: owner.id, playerName: owner.name, char: '', locked: false }); }
      g.revealed = false; g.results = null; g.correctAll = false; g.message = '各自1文字ずつ入力してロック。オープンまで解答は誰にも見えません'; broadcast(room);
    });
    socket.on('pt:np:input', ({ index, char } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const g = c.room.game; if (!g || g.type !== 'nepleague' || g.revealed) return; const slot = g.slots[index]; if (!slot || slot.playerId !== c.playerId || slot.locked) return; slot.char = NP.chars(String(char || ''))[0] || ''; broadcast(c.room); });
    socket.on('pt:np:lock', ({ index, locked } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const g = c.room.game; if (!g || g.type !== 'nepleague' || g.revealed) return; const slot = g.slots[index]; if (!slot || slot.playerId !== c.playerId) return; if (locked && !slot.char) return; slot.locked = !!locked; broadcast(c.room); });
    socket.on('pt:np:open', () => { const room = host(socket); if (!room || !room.game || room.game.type !== 'nepleague' || !room.game.question) return; const g = room.game; const j = NP.judge(g.slots, g.question.answer); g.results = j.results; g.correctAll = j.correctAll; g.revealed = true; if (g.correctAll) { const pts = g.question.difficulty * 10; addPoints(room, g.activeUnitId, pts); g.message = '正解！ +' + pts + 'ポイント'; } else g.message = 'ざんねん！正解は「' + g.question.answer + '」'; broadcast(room); });
    socket.on('pt:np:next', () => { const room = host(socket); if (!room || !room.game || room.game.type !== 'nepleague') return; const g = room.game; g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false; g.message = g.activeUnitName ? (g.activeUnitName + ' の番です。次の問題を選んでください') : '手番のチームを選んでください'; broadcast(room); });

    socket.on('disconnect', () => { const c = ctx(socket); if (!c) return; const room = c.room; if (c.isHost) { room.hostSocketId = null; return; } const p = room.players[socket.id]; if (!p) return; delete room.players[socket.id]; if (!room.hostSocketId && Object.keys(room.players).length === 0) { rooms.delete(room.code); return; } broadcast(room); });
  });

  setInterval(() => { const now = Date.now(); for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) rooms.delete(code); }, 3600 * 1000);
  return { rooms };
};
