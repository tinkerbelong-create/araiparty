/* パーティモード(まとめモード) オンライン版サーバー(モジュール) — server-authoritative
 * 1つの部屋で、ホスト=テレビ画面、スマホ=参加者。チームと通算得点を保持したまま
 * 複数のパーティゲームを続けて遊べるハブ。収録: ネプリーグ / シュゾマス。 */
'use strict';
const NP = require('./np_core.js');
const S  = require('./shuzomas_core.js');

module.exports = function attach(io, opts = {}) {
  const rooms = new Map();
  const GAMES = [
    { id: 'nepleague', name: 'ネプリーグ', icon: '🧩', ready: true },
    { id: 'shuzomas',  name: 'シュゾマス', icon: '🍺', ready: true },
  ];
  /* 順位→チーム得点(1位+3 / 2位+2 / 3位+1 / それ以降0) */
  const rankPoints = (rank) => (rank === 1 ? 3 : rank === 2 ? 2 : rank === 3 ? 1 : 0);

  function genCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c; do { c = 'P' + Array.from({ length: 4 }, () => cs[Math.floor(Math.random() * cs.length)]).join(''); } while (rooms.has(c));
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
  function awardTeamOrPlayer(room, playerId, pts) {
    if (pts <= 0) return;
    const pl = room.players[playerId]; if (!pl) return;
    if (room.mode === 'team' && pl.teamId && room.teams[pl.teamId]) room.teams[pl.teamId].score += pts;
    else pl.score += pts;
  }

  /* ══ シュゾマス: 公開/非公開ビュー(度数は本人分と評価0のみ) ══ */
  function szPublic(room) {
    const E = room.sz.engine;
    return {
      type: 'shuzomas', sub: room.sz.sub,
      round: E.round, stars: E.stars, starName: S.STAR_NAMES[E.stars],
      ingredients: E.ingredients.map(g => ({ id: g.id, attr: g.attr })), // 度数は送らない
      dosSet: E.ingredients.map(g => g.dos).sort((a, b) => a - b),
      seats: room.sz.seatIds.map((pid, i) => {
        const p = E.players[i]; const pl = room.players[pid];
        return {
          idx: i, id: pid, name: pl ? pl.name : '?', teamId: pl ? pl.teamId : null, connected: pl ? pl.connected : false,
          chosen: !!p.myIngredientId, submitted: !!room.sz.submitted[i],
          money: p.money, eval: p.eval, lastRank: p.lastRank, lastLabel: room.sz.lastLabel ? room.sz.lastLabel[i] : null,
          revealed: p.revealed,
          openMyId: p.revealed ? p.myIngredientId : null,
          openMyDos: p.revealed ? E.ing(p.myIngredientId).dos : null,
          openSakeDos: p.revealed ? p.lastSakeDos : null,
        };
      }),
      takenMyIds: room.sz.seatIds.map((pid, i) => E.players[i].myIngredientId).filter(Boolean),
      endInfo: room.sz.sub === 'ended' ? room.sz.endInfo : null,
    };
  }
  function szPriv(room, playerId) {
    const E = room.sz && room.sz.engine; if (!E) return null;
    const i = room.sz.seatIds.indexOf(playerId); if (i < 0) return null;
    const p = E.players[i];
    return { myIdx: i, myId: p.myIngredientId, myDos: p.myIngredientId ? E.ing(p.myIngredientId).dos : null,
      buyCount: p.buyCount, money: p.money, canRest: E.canRest(p), submitted: !!room.sz.submitted[i] };
  }

  function publicState(room) {
    const base = {
      code: room.code, phase: room.phase, mode: room.mode, hostName: room.hostName,
      players: room.players, teams: room.teams, games: GAMES, currentGame: room.currentGame,
    };
    const s = JSON.parse(JSON.stringify(base));
    if (room.currentGame === 'shuzomas' && room.sz && room.sz.engine) s.game = szPublic(room);
    else if (room.game) { const g = JSON.parse(JSON.stringify(room.game)); if (g.question && !g.revealed) delete g.question.answer; s.game = g; }
    else s.game = null;
    return s;
  }
  function broadcast(room) {
    const pub = publicState(room);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('pt:state', { pub, priv: { isHost: true, youId: null } });
    Object.values(room.players).forEach(p => {
      if (p.connected && p.socketId) {
        const priv = { isHost: false, youId: p.id };
        if (room.currentGame === 'shuzomas') priv.sz = szPriv(room, p.id);
        io.to(p.socketId).emit('pt:state', { pub, priv });
      }
    });
  }

  function newNep() {
    return { type: 'nepleague', activeUnitId: null, activeUnitName: '', difficulty: 2, genre: NP.GENRES[0],
      question: null, length: 0, slots: [], revealed: false, results: null, correctAll: false,
      message: '手番のチーム/人を選んでください' };
  }

  /* ══ シュゾマス進行 ══ */
  function startShuzomas(room) {
    const players = orderedPlayers(room).filter(p => p.connected);
    room.sz = { engine: new S.Engine(undefined, Math.max(2, players.length)), seatIds: players.map(p => p.id),
      sub: 'myselect', submitted: {}, lastLabel: null, endInfo: null };
    room.currentGame = 'shuzomas'; room.phase = 'ingame'; room.game = null;
    broadcast(room);
  }
  function allChosen(room) {
    const E = room.sz.engine;
    return room.sz.seatIds.every((pid, j) => { const pl = room.players[pid]; return (!pl || !pl.connected) || E.players[j].myIngredientId; });
  }
  function autoFillMy(room) {
    const E = room.sz.engine;
    room.sz.seatIds.forEach((pid, j) => {
      if (!E.players[j].myIngredientId) {
        const taken = room.sz.seatIds.map((x, k) => E.players[k].myIngredientId).filter(Boolean);
        for (let id = 1; id <= 24; id++) if (!taken.includes(id)) { E.setMyIngredient(j, id); break; }
      }
    });
  }
  function allSubmitted(room) {
    return !room.sz.seatIds.some((pid, j) => { const pl = room.players[pid]; return pl && pl.connected && !room.sz.submitted[j]; });
  }
  function resolveShuzomas(room) {
    const E = room.sz.engine;
    // 未提出(切断者)を自動補完: 休憩できれば休憩、無理なら最安の醸造
    room.sz.seatIds.forEach((pid, i) => {
      if (!room.sz.submitted[i]) {
        const p = E.players[i];
        if (E.canRest(p)) room.sz.submitted[i] = { type: 'rest' };
        else { const c = E.combos.filter(x => S.pickCost(p.buyCount, x) <= p.money); room.sz.submitted[i] = c.length ? { type: 'brew', picks: c[0] } : { type: 'rest' }; }
      }
    });
    const subs = room.sz.seatIds.map((pid, i) => room.sz.submitted[i]);
    const r = E.resolveRound(subs);
    room.sz.lastLabel = r.results.map(res => res.type === 'brew' ? res.label : null);
    const pubResults = r.results.map((res, i) => ({ idx: i, type: res.type, rank: res.rank ?? null, failed: !!res.failed,
      winner: !!res.winner, pay: res.pay ?? null, label: res.type === 'brew' ? res.label : null,
      moneyDelta: res.moneyDelta ?? 0, evalDelta: res.evalDelta ?? 0,
      openDos: (E.players[i].revealed && res.type === 'brew') ? res.dos : null }));
    // 本人限定の reveal
    room.sz.seatIds.forEach((pid, i) => {
      const pl = room.players[pid];
      if (pl && pl.connected && pl.socketId) {
        const mine = r.results[i];
        io.to(pl.socketId).emit('pt:sz:reveal', { roundNo: r.roundNo, results: pubResults, ended: r.ended,
          mine: mine.type === 'brew' ? { type: 'brew', picks: mine.picks, dos: mine.dos, label: mine.label, rank: mine.rank ?? null, failed: !!mine.failed, winner: !!mine.winner } : { type: mine.type } });
      }
    });
    if (room.hostSocketId) io.to(room.hostSocketId).emit('pt:sz:reveal', { roundNo: r.roundNo, results: pubResults, ended: r.ended, mine: { type: 'host' } });

    if (r.ended) {
      room.sz.sub = 'ended';
      const franks = E.finalRanking();
      franks.forEach(({ idx, rank }) => awardTeamOrPlayer(room, room.sz.seatIds[idx], rankPoints(rank)));
      room.sz.endInfo = {
        winners: E.winnerIdxs, reason: E.endReason, patterns: E.patterns, stars: E.stars,
        ingredients: E.ingredients.map(g => ({ id: g.id, attr: g.attr, dos: g.dos })),
        final: franks.map(fr => { const pid = room.sz.seatIds[fr.idx]; const pl = room.players[pid];
          return { idx: fr.idx, name: pl ? pl.name : '?', rank: fr.rank, gained: rankPoints(fr.rank),
            money: E.players[fr.idx].money, eval: E.players[fr.idx].eval,
            myId: E.players[fr.idx].myIngredientId, myDos: E.ing(E.players[fr.idx].myIngredientId).dos };
        }).sort((a, b) => a.rank - b.rank),
      };
    } else {
      room.sz.submitted = {};
    }
    broadcast(room);
  }

  io.on('connection', (socket) => {
    /* 入室 */
    socket.on('pt:createRoom', ({ name } = {}, cb) => {
      const room = { code: genCode(), phase: 'hub', hostSocketId: socket.id,
        hostName: String(name || 'ホスト').trim().slice(0, 12) || 'ホスト', mode: 'team',
        players: {}, teams: {}, seq: 1, currentGame: null, game: null, sz: null, createdAt: Date.now() };
      rooms.set(room.code, room); socket.join(room.code);
      cb && cb({ ok: true, code: room.code }); broadcast(room);
    });
    socket.on('pt:rejoinHost', ({ code } = {}, cb) => {
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      room.hostSocketId = socket.id; socket.join(room.code);
      cb && cb({ ok: true, code: room.code }); broadcast(room);
    });
    socket.on('pt:joinRoom', ({ code, name } = {}, cb) => {
      code = String(code || '').trim().toUpperCase(); name = String(name || '').trim().slice(0, 12);
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '合言葉が違います' });
      if (!name) return cb && cb({ ok: false, error: '名前を入れてください' });
      if (Object.values(room.players).some(p => p.name === name && p.connected)) name = name + room.seq;
      room.players[socket.id] = { id: socket.id, socketId: socket.id, name, teamId: null, score: 0, connected: true, order: room.seq++ };
      socket.join(room.code);
      cb && cb({ ok: true, code, playerId: socket.id }); broadcast(room);
    });

    /* ハブ: チーム/モード */
    socket.on('pt:setMode', ({ mode } = {}) => { const room = host(socket); if (!room || room.phase !== 'hub') return; room.mode = (mode === 'individual') ? 'individual' : 'team'; broadcast(room); });
    socket.on('pt:addTeam', ({ name } = {}) => { const room = host(socket); if (!room) return; const id = 't' + (room.seq++); const n = Object.keys(room.teams).length; room.teams[id] = { id, name: (String(name || '').trim() || ('チーム' + (n + 1))).slice(0, 16), score: 0, order: n }; broadcast(room); });
    socket.on('pt:renameTeam', ({ teamId, name } = {}) => { const room = host(socket); if (!room) return; if (room.teams[teamId]) room.teams[teamId].name = String(name || '').trim().slice(0, 16) || room.teams[teamId].name; broadcast(room); });
    socket.on('pt:removeTeam', ({ teamId } = {}) => { const room = host(socket); if (!room) return; delete room.teams[teamId]; Object.values(room.players).forEach(p => { if (p.teamId === teamId) p.teamId = null; }); broadcast(room); });
    socket.on('pt:assignPlayer', ({ playerId, teamId } = {}) => { const room = host(socket); if (!room) return; const p = room.players[playerId]; if (p) { p.teamId = (teamId && room.teams[teamId]) ? teamId : null; broadcast(room); } });
    socket.on('pt:pickTeam', ({ teamId } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const p = c.room.players[c.playerId]; if (p && c.room.teams[teamId]) { p.teamId = teamId; broadcast(c.room); } });

    /* ハブ: ゲーム開始/終了(得点は持ち越し) */
    socket.on('pt:openGame', ({ gameId } = {}) => {
      const room = host(socket); if (!room) return;
      const g = GAMES.find(x => x.id === gameId && x.ready); if (!g) return;
      if (gameId === 'nepleague') { room.sz = null; room.currentGame = 'nepleague'; room.phase = 'ingame'; room.game = newNep(); broadcast(room); }
      else if (gameId === 'shuzomas') { startShuzomas(room); }
    });
    socket.on('pt:closeGame', () => { const room = host(socket); if (!room) return; room.phase = 'hub'; room.currentGame = null; room.game = null; room.sz = null; broadcast(room); });

    /* ネプリーグ操作 */
    socket.on('pt:np:selectUnit', ({ unitId } = {}) => { const room = host(socket); if (!room || !room.game) return; const g = room.game; g.activeUnitId = unitId; g.activeUnitName = unitName(room, unitId); g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false; g.message = g.activeUnitName + ' の番です。難易度と傾向を選んで問題を出してください'; broadcast(room); });
    socket.on('pt:np:deal', ({ difficulty, genre } = {}) => {
      const room = host(socket); if (!room || !room.game) return; const g = room.game;
      if (!g.activeUnitId) { g.message = '先に手番のチーム/人を選んでください'; return broadcast(room); }
      const members = unitMembers(room, g.activeUnitId);
      if (members.length === 0) { g.message = 'このチームに参加者がいません'; return broadcast(room); }
      g.difficulty = Math.min(5, Math.max(1, Number(difficulty) || 2)); g.genre = NP.GENRES.includes(genre) ? genre : NP.GENRES[0];
      const length = Math.min(5, Math.max(3, members.length));
      const q = NP.pickQuestion(g.difficulty, g.genre, length);
      g.question = { text: q.text, answer: q.answer, genre: q.genre, difficulty: q.difficulty };
      g.length = NP.chars(q.answer).length; g.slots = [];
      for (let i = 0; i < g.length; i++) { const owner = members[i % members.length]; g.slots.push({ index: i, playerId: owner.id, playerName: owner.name, char: '', locked: false }); }
      g.revealed = false; g.results = null; g.correctAll = false; g.message = '各自1文字ずつ入力してロックしてください'; broadcast(room);
    });
    socket.on('pt:np:input', ({ index, char } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const g = c.room.game; if (!g || g.revealed) return; const slot = g.slots[index]; if (!slot || slot.playerId !== c.playerId || slot.locked) return; slot.char = NP.chars(String(char || ''))[0] || ''; broadcast(c.room); });
    socket.on('pt:np:lock', ({ index, locked } = {}) => { const c = ctx(socket); if (!c || c.isHost) return; const g = c.room.game; if (!g || g.revealed) return; const slot = g.slots[index]; if (!slot || slot.playerId !== c.playerId) return; if (locked && !slot.char) return; slot.locked = !!locked; broadcast(c.room); });
    socket.on('pt:np:open', () => { const room = host(socket); if (!room || !room.game || !room.game.question) return; const g = room.game; const j = NP.judge(g.slots, g.question.answer); g.results = j.results; g.correctAll = j.correctAll; g.revealed = true; if (g.correctAll) { const pts = g.question.difficulty; awardTeamOrPlayer(room, null, 0); if (room.mode === 'team' && room.teams[g.activeUnitId]) room.teams[g.activeUnitId].score += pts; else if (room.players[g.activeUnitId]) room.players[g.activeUnitId].score += pts; g.message = '正解！ +' + pts + '点'; } else g.message = 'ざんねん！正解は「' + g.question.answer + '」'; broadcast(room); });
    socket.on('pt:np:next', () => { const room = host(socket); if (!room || !room.game) return; const g = room.game; g.question = null; g.slots = []; g.revealed = false; g.results = null; g.correctAll = false; g.message = g.activeUnitName ? (g.activeUnitName + ' の番です。次の問題を選んでください') : '手番のチーム/人を選んでください'; broadcast(room); });

    /* シュゾマス操作 */
    socket.on('pt:sz:chooseMy', ({ ingId } = {}) => {
      const c = ctx(socket); if (!c || c.isHost) return; const room = c.room;
      if (room.currentGame !== 'shuzomas' || !room.sz || room.sz.sub !== 'myselect') return;
      const E = room.sz.engine; const i = room.sz.seatIds.indexOf(c.playerId); if (i < 0) return;
      ingId = Number(ingId); if (!(ingId >= 1 && ingId <= 24)) return;
      if (E.players[i].myIngredientId) return;
      if (room.sz.seatIds.some((pid, j) => E.players[j].myIngredientId === ingId)) return;
      E.setMyIngredient(i, ingId);
      if (allChosen(room)) { autoFillMy(room); room.sz.sub = 'play'; }
      broadcast(room);
    });
    socket.on('pt:sz:submit', (sub = {}) => {
      const c = ctx(socket); if (!c || c.isHost) return; const room = c.room;
      if (room.currentGame !== 'shuzomas' || !room.sz || room.sz.sub !== 'play') return;
      const E = room.sz.engine; const i = room.sz.seatIds.indexOf(c.playerId); if (i < 0) return;
      if (room.sz.submitted[i]) return; const p = E.players[i];
      if (sub.type === 'rest') { if (!E.canRest(p)) return; room.sz.submitted[i] = { type: 'rest' }; }
      else if (sub.type === 'brew') { if (!S.isValidPicks(sub.picks)) return; if (S.pickCost(p.buyCount, sub.picks) > p.money) return; room.sz.submitted[i] = { type: 'brew', picks: sub.picks.map(Number) }; }
      else return;
      if (allSubmitted(room)) resolveShuzomas(room); else broadcast(room);
    });

    /* 切断 */
    socket.on('disconnect', () => {
      const c = ctx(socket); if (!c) return; const room = c.room;
      if (c.isHost) { room.hostSocketId = null; return; }
      const p = room.players[socket.id]; if (!p) return;
      if (room.phase === 'hub') delete room.players[socket.id]; else p.connected = false;
      if (!room.hostSocketId && Object.values(room.players).every(x => !x.connected)) { rooms.delete(room.code); return; }
      // シュゾマス中に全員提出済みになったら進める
      if (room.currentGame === 'shuzomas' && room.sz) {
        if (room.sz.sub === 'myselect' && allChosen(room)) { autoFillMy(room); room.sz.sub = 'play'; }
        else if (room.sz.sub === 'play' && allSubmitted(room)) { return resolveShuzomas(room); }
      }
      broadcast(room);
    });
  });

  setInterval(() => { const now = Date.now(); for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) rooms.delete(code); }, 3600 * 1000);
  return { rooms };
};
