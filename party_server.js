/* パーティモード(まとめモード) オンライン版サーバー(モジュール) — server-authoritative
 * 1つの部屋で、ホスト=テレビ画面、スマホ=参加者。チームと通算得点を保持したまま
 * 複数のパーティゲームを続けて遊べるハブ。今はゲーム1=ネプリーグを内包。
 * 既存プラットフォーム同様 server.js から require('./party_server.js')(io, opts) で差し込む。 */
'use strict';
const NP = require('./np_core.js');

module.exports = function attach(io, opts = {}) {
  const rooms = new Map(); // code -> room
  const GAMES = [{ id: 'nepleague', name: 'ネプリーグ', icon: '🧩', ready: true }];

  function genCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'P' + Array.from({ length: 4 }, () => cs[Math.floor(Math.random() * cs.length)]).join(''); }
    while (rooms.has(c));
    return c;
  }
  function ctx(socket) {
    for (const room of rooms.values()) {
      if (room.hostSocketId === socket.id) return { room, isHost: true, playerId: null };
      if (room.players[socket.id]) return { room, isHost: false, playerId: socket.id };
    }
    return null;
  }
  function host(socket) { const c = ctx(socket); return (c && c.isHost) ? c.room : null; }
  const orderedPlayers = (room) => Object.values(room.players).sort((a, b) => a.order - b.order);
  const teamMembers = (room, teamId) => orderedPlayers(room).filter(p => p.teamId === teamId && p.connected);
  function unitMembers(room, unitId) {
    if (room.mode === 'team') return teamMembers(room, unitId);
    const p = room.players[unitId]; return (p && p.connected) ? [p] : [];
  }
  function unitName(room, unitId) {
    if (room.mode === 'team') return room.teams[unitId] ? room.teams[unitId].name : '';
    return room.players[unitId] ? room.players[unitId].name : '';
  }

  function publicState(room) {
    const s = JSON.parse(JSON.stringify({
      code: room.code, phase: room.phase, mode: room.mode, hostName: room.hostName,
      players: room.players, teams: room.teams, games: GAMES,
      currentGame: room.currentGame, game: room.game,
    }));
    if (s.game && s.game.question && !s.game.revealed) delete s.game.question.answer;
    return s;
  }
  function broadcast(room) {
    const pub = publicState(room);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('pt:state', { pub, priv: { isHost: true, youId: null } });
    Object.values(room.players).forEach(p => {
      if (p.connected && p.socketId) io.to(p.socketId).emit('pt:state', { pub, priv: { isHost: false, youId: p.id } });
    });
  }

  /* ── ネプリーグ用のゲーム状態 ── */
  function newNep(room) {
    return {
      type: 'nepleague', activeUnitId: null, activeUnitName: '',
      difficulty: 2, genre: NP.GENRES[0], question: null, length: 0,
      slots: [], revealed: false, results: null, correctAll: false,
      message: '手番のチーム/人を選んでください',
    };
  }

  io.on('connection', (socket) => {
    /* ── 入室 ── */
    socket.on('pt:createRoom', ({ name } = {}, cb) => {
      const room = {
        code: genCode(), phase: 'hub',
        hostSocketId: socket.id, hostName: String(name || 'ホスト').trim().slice(0, 12) || 'ホスト',
        mode: 'team', players: {}, teams: {}, seq: 1,
        currentGame: null, game: null, createdAt: Date.now(),
      };
      rooms.set(room.code, room);
      socket.join(room.code);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });
    socket.on('pt:rejoinHost', ({ code } = {}, cb) => {
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      room.hostSocketId = socket.id; socket.join(room.code);
      cb && cb({ ok: true, code: room.code }); broadcast(room);
    });
    socket.on('pt:joinRoom', ({ code, name } = {}, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 12);
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '合言葉が違います' });
      if (!name) return cb && cb({ ok: false, error: '名前を入れてください' });
      if (Object.values(room.players).some(p => p.name === name && p.connected)) name = name + room.seq;
      room.players[socket.id] = { id: socket.id, socketId: socket.id, name, teamId: null, score: 0, connected: true, order: room.seq++ };
      socket.join(room.code);
      cb && cb({ ok: true, code, playerId: socket.id });
      broadcast(room);
    });

    /* ── ハブ：チーム/モード ── */
    socket.on('pt:setMode', ({ mode } = {}) => {
      const room = host(socket); if (!room || room.phase !== 'hub') return;
      room.mode = (mode === 'individual') ? 'individual' : 'team'; broadcast(room);
    });
    socket.on('pt:addTeam', ({ name } = {}) => {
      const room = host(socket); if (!room) return;
      const id = 't' + (room.seq++); const n = Object.keys(room.teams).length;
      room.teams[id] = { id, name: (String(name || '').trim() || ('チーム' + (n + 1))).slice(0, 16), score: 0, order: n };
      broadcast(room);
    });
    socket.on('pt:renameTeam', ({ teamId, name } = {}) => {
      const room = host(socket); if (!room) return;
      if (room.teams[teamId]) room.teams[teamId].name = String(name || '').trim().slice(0, 16) || room.teams[teamId].name;
      broadcast(room);
    });
    socket.on('pt:removeTeam', ({ teamId } = {}) => {
      const room = host(socket); if (!room) return;
      delete room.teams[teamId];
      Object.values(room.players).forEach(p => { if (p.teamId === teamId) p.teamId = null; });
      broadcast(room);
    });
    socket.on('pt:assignPlayer', ({ playerId, teamId } = {}) => {
      const room = host(socket); if (!room) return;
      const p = room.players[playerId];
      if (p) { p.teamId = (teamId && room.teams[teamId]) ? teamId : null; broadcast(room); }
    });
    socket.on('pt:pickTeam', ({ teamId } = {}) => {
      const c = ctx(socket); if (!c || c.isHost) return;
      const p = c.room.players[c.playerId];
      if (p && c.room.teams[teamId]) { p.teamId = teamId; broadcast(c.room); }
    });

    /* ── ハブ：ゲームの開始/終了(得点は持ち越し) ── */
    socket.on('pt:openGame', ({ gameId } = {}) => {
      const room = host(socket); if (!room) return;
      const g = GAMES.find(x => x.id === gameId && x.ready); if (!g) return;
      room.phase = 'ingame'; room.currentGame = gameId;
      room.game = newNep(room);
      broadcast(room);
    });
    socket.on('pt:closeGame', () => {
      const room = host(socket); if (!room) return;
      room.phase = 'hub'; room.currentGame = null; room.game = null;
      broadcast(room);
    });

    /* ── ネプリーグ操作(ingame) ── */
    socket.on('pt:np:selectUnit', ({ unitId } = {}) => {
      const room = host(socket); if (!room || !room.game) return;
      const g = room.game;
      g.activeUnitId = unitId; g.activeUnitName = unitName(room, unitId);
      g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false;
      g.message = g.activeUnitName + ' の番です。難易度と傾向を選んで問題を出してください';
      broadcast(room);
    });
    socket.on('pt:np:deal', ({ difficulty, genre } = {}) => {
      const room = host(socket); if (!room || !room.game) return;
      const g = room.game;
      if (!g.activeUnitId) { g.message = '先に手番のチーム/人を選んでください'; return broadcast(room); }
      const members = unitMembers(room, g.activeUnitId);
      if (members.length === 0) { g.message = 'このチームに参加者がいません'; return broadcast(room); }
      g.difficulty = Math.min(5, Math.max(1, Number(difficulty) || 2));
      g.genre = NP.GENRES.includes(genre) ? genre : NP.GENRES[0];
      const length = Math.min(5, Math.max(3, members.length));
      const q = NP.pickQuestion(g.difficulty, g.genre, length);
      g.question = { text: q.text, answer: q.answer, genre: q.genre, difficulty: q.difficulty };
      g.length = NP.chars(q.answer).length;
      g.slots = [];
      for (let i = 0; i < g.length; i++) {
        const owner = members[i % members.length];
        g.slots.push({ index: i, playerId: owner.id, playerName: owner.name, char: '', locked: false });
      }
      g.revealed = false; g.results = null; g.correctAll = false;
      g.message = '各自1文字ずつ入力してロックしてください';
      broadcast(room);
    });
    socket.on('pt:np:input', ({ index, char } = {}) => {
      const c = ctx(socket); if (!c || c.isHost) return;
      const g = c.room.game; if (!g || g.revealed) return;
      const slot = g.slots[index];
      if (!slot || slot.playerId !== c.playerId || slot.locked) return;
      slot.char = NP.chars(String(char || ''))[0] || ''; broadcast(c.room);
    });
    socket.on('pt:np:lock', ({ index, locked } = {}) => {
      const c = ctx(socket); if (!c || c.isHost) return;
      const g = c.room.game; if (!g || g.revealed) return;
      const slot = g.slots[index];
      if (!slot || slot.playerId !== c.playerId) return;
      if (locked && !slot.char) return;
      slot.locked = !!locked; broadcast(c.room);
    });
    socket.on('pt:np:open', () => {
      const room = host(socket); if (!room || !room.game || !room.game.question) return;
      const g = room.game;
      const j = NP.judge(g.slots, g.question.answer);
      g.results = j.results; g.correctAll = j.correctAll; g.revealed = true;
      if (g.correctAll) {
        const pts = g.question.difficulty;
        if (room.mode === 'team' && room.teams[g.activeUnitId]) room.teams[g.activeUnitId].score += pts;
        else if (room.players[g.activeUnitId]) room.players[g.activeUnitId].score += pts;
        g.message = '正解！ +' + pts + '点';
      } else g.message = 'ざんねん！正解は「' + g.question.answer + '」';
      broadcast(room);
    });
    socket.on('pt:np:next', () => {
      const room = host(socket); if (!room || !room.game) return;
      const g = room.game;
      g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false;
      g.message = g.activeUnitName ? (g.activeUnitName + ' の番です。次の問題を選んでください') : '手番のチーム/人を選んでください';
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const c = ctx(socket); if (!c) return;
      const room = c.room;
      if (c.isHost) { room.hostSocketId = null; return; }
      const p = room.players[socket.id]; if (!p) return;
      if (room.phase === 'hub') delete room.players[socket.id]; else p.connected = false;
      if (!room.hostSocketId && Object.values(room.players).every(x => !x.connected)) { rooms.delete(room.code); return; }
      broadcast(room);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) rooms.delete(code);
  }, 3600 * 1000);

  return { rooms };
};
