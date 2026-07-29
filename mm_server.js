/* マーダーミステリー オンライン版サーバー(モジュール) — server-authoritative
 * server.js から require('./mm_server.js')(io, opts) で差し込む。
 * 秘匿情報(他人のHO・真相・未取得の手がかり)はサーバーに保持し、本人にしか送らない。 */
'use strict';
const MM = require('./mm_core.js');

module.exports = function attach(io, opts = {}) {
  const rooms = new Map(); // code -> room
  const ROOM_TTL = 12 * 60 * 60 * 1000;

  function genCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'M' + Array.from({ length: 4 }, () => cs[Math.floor(Math.random() * cs.length)]).join(''); }
    while (rooms.has(c));
    return c;
  }

  function makeRoom(scenarioId, hostName, socketId) {
    const room = {
      code: genCode(),
      scenarioId,
      stage: 'lobby',          // lobby | select | play | ended
      game: null,
      seats: [],               // {name, socketId, connected, charId}
      hostIdx: 0,
      deadline: null,
      timer: null,
      createdAt: Date.now(),
    };
    room.seats.push({ name: hostName, socketId, connected: true, charId: null });
    rooms.set(room.code, room);
    return room;
  }

  function ctx(socket) {
    for (const room of rooms.values()) {
      const idx = room.seats.findIndex(s => s.socketId === socket.id);
      if (idx >= 0) return { room, idx, seat: room.seats[idx], isHost: idx === room.hostIdx };
    }
    return null;
  }

  /* ── 配信 ── */
  function lobbyView(room) {
    return {
      code: room.code,
      stage: room.stage,
      scenarioId: room.scenarioId,
      hostIdx: room.hostIdx,
      seats: room.seats.map((s, i) => ({ idx: i, name: s.name, connected: s.connected, charId: s.charId })),
      deadline: room.deadline,
    };
  }
  function broadcast(room) {
    const lobby = lobbyView(room);
    const pub = room.game ? room.game.publicView() : { scenario: MM.listScenarios().find(s => s.id === room.scenarioId) || null };
    room.seats.forEach((s, i) => {
      if (!s.connected || !s.socketId) return;
      const priv = (room.game && s.charId) ? room.game.privateView(s.charId) : { charId: s.charId || null };
      priv.myIdx = i;
      priv.isHost = i === room.hostIdx;
      io.to(s.socketId).emit('mm:state', { lobby, pub, priv });
    });
  }

  /* ── フェーズタイマー ── */
  function clearTimer(room) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    room.deadline = null;
  }
  function startPhaseTimer(room) {
    clearTimer(room);
    const ph = room.game && room.game.phase;
    if (!ph || !ph.minutes) return;
    room.deadline = Date.now() + ph.minutes * 60 * 1000;
    room.timer = setTimeout(() => {
      room.timer = null;
      // 時間切れでは自動的に進めない(進行はホスト操作)。表示だけ 00:00 に。
      broadcast(room);
    }, ph.minutes * 60 * 1000 + 200);
  }

  function nextPhase(room) {
    const g = room.game;
    if (!g) return;
    // 能力フェーズを抜けるときに解決する
    if (g.phaseType === 'ability') {
      const results = g.resolvePhase();
      Object.entries(results).forEach(([charId, arr]) => {
        const seat = room.seats.find(s => s.charId === charId);
        if (seat && seat.connected && seat.socketId) io.to(seat.socketId).emit('mm:reveal', { results: arr });
      });
    }
    if (g.phaseType === 'final') {
      g.score();
    }
    const moved = g.advance();
    if (!moved) { room.stage = 'ended'; clearTimer(room); broadcast(room); return; }
    if (g.phaseType === 'ending') { if (!g.result) g.score(); room.stage = 'ended'; clearTimer(room); broadcast(room); return; }
    startPhaseTimer(room);
    broadcast(room);
  }

  /* ── ソケット ── */
  io.on('connection', socket => {

    socket.on('mm:scenarios', (_, cb) => {
      if (typeof cb === 'function') cb({ ok: true, list: MM.listScenarios() });
    });

    socket.on('mm:create', ({ name, scenarioId }, cb) => {
      name = String(name || '').trim().slice(0, 12);
      if (!name) return cb && cb({ ok: false, msg: '名前を入れてください' });
      let list;
      try { list = MM.listScenarios(); } catch (e) { return cb && cb({ ok: false, msg: 'シナリオを読めませんでした' }); }
      const sc = list.find(s => s.id === scenarioId) || list[0];
      if (!sc) return cb && cb({ ok: false, msg: 'シナリオがありません' });
      const room = makeRoom(sc.id, name, socket.id);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('mm:join', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 12);
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, msg: '部屋が見つかりません' });
      if (!name) return cb && cb({ ok: false, msg: '名前を入れてください' });

      // 同名の切断席があれば復帰
      const back = room.seats.find(s => s.name === name && !s.connected);
      if (back) { back.socketId = socket.id; back.connected = true; cb && cb({ ok: true, code, rejoined: true }); broadcast(room); return; }

      if (room.stage !== 'lobby') return cb && cb({ ok: false, msg: 'すでに始まっています' });
      const sc = MM.loadScenario(room.scenarioId);
      if (room.seats.length >= sc.players.max) return cb && cb({ ok: false, msg: '満席です' });
      if (room.seats.some(s => s.name === name)) return cb && cb({ ok: false, msg: 'その名前は使われています' });
      room.seats.push({ name, socketId: socket.id, connected: true, charId: null });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    /* ホスト: キャラ選択フェーズへ */
    socket.on('mm:toSelect', (_, cb) => {
      const c = ctx(socket); if (!c || !c.isHost) return cb && cb({ ok: false, msg: 'ホストのみ' });
      const { room } = c;
      const sc = MM.loadScenario(room.scenarioId);
      if (room.seats.length < sc.players.min) return cb && cb({ ok: false, msg: `${sc.players.min}人必要です` });
      room.stage = 'select';
      room.game = new MM.Game(room.scenarioId);
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* キャラを選ぶ(早い者勝ち) */
    socket.on('mm:pick', ({ charId }, cb) => {
      const c = ctx(socket); if (!c) return cb && cb({ ok: false });
      const { room, seat } = c;
      if (room.stage !== 'select') return cb && cb({ ok: false, msg: '今は選べません' });
      if (room.seats.some(s => s.charId === charId)) return cb && cb({ ok: false, msg: 'もう選ばれています' });
      seat.charId = charId;
      room.game.assign[charId] = room.seats.indexOf(seat);
      cb && cb({ ok: true });
      broadcast(room);
    });
    socket.on('mm:unpick', (_, cb) => {
      const c = ctx(socket); if (!c) return cb && cb({ ok: false });
      const { room, seat } = c;
      if (room.stage !== 'select') return cb && cb({ ok: false });
      if (seat.charId) delete room.game.assign[seat.charId];
      seat.charId = null;
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* ホスト: 開始 */
    socket.on('mm:start', (_, cb) => {
      const c = ctx(socket); if (!c || !c.isHost) return cb && cb({ ok: false, msg: 'ホストのみ' });
      const { room } = c;
      if (room.stage !== 'select') return cb && cb({ ok: false });
      if (room.seats.some(s => !s.charId)) return cb && cb({ ok: false, msg: '全員がキャラを選んでください' });
      room.stage = 'play';
      room.game.advance(); // -1 -> 0 (read)
      startPhaseTimer(room);
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* ホスト: 次のフェーズへ / 延長 */
    socket.on('mm:next', (_, cb) => {
      const c = ctx(socket); if (!c || !c.isHost) return cb && cb({ ok: false, msg: 'ホストのみ' });
      if (c.room.stage !== 'play') return cb && cb({ ok: false });
      nextPhase(c.room);
      cb && cb({ ok: true });
    });
    socket.on('mm:extend', ({ minutes }, cb) => {
      const c = ctx(socket); if (!c || !c.isHost) return cb && cb({ ok: false, msg: 'ホストのみ' });
      const { room } = c;
      const add = Math.max(1, Math.min(30, parseInt(minutes, 10) || 5)) * 60 * 1000;
      const base = Math.max(Date.now(), room.deadline || Date.now());
      clearTimer(room);
      room.deadline = base + add;
      room.timer = setTimeout(() => { room.timer = null; broadcast(room); }, room.deadline - Date.now() + 200);
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* 行動(移動して調べる＋能力)の同時提出 */
    socket.on('mm:act', ({ placeId, extra, abilityId, target }, cb) => {
      const c = ctx(socket); if (!c || !c.seat.charId) return cb && cb({ ok: false });
      const { room, seat } = c;
      if (room.stage !== 'play') return cb && cb({ ok: false });
      const r = room.game.submitMove(seat.charId, {
        placeId: placeId || null, extra: extra || null,
        abilityId: abilityId || null, target: target || {},
      });
      if (!r.ok) return cb && cb(r);
      cb && cb({ ok: true });
      broadcast(room);
      if (room.game.allMoved()) setTimeout(() => { if (rooms.has(room.code) && room.stage === 'play') nextPhase(room); }, 600);
    });

    /* 最終回答 */
    socket.on('mm:answers', (payload, cb) => {
      const c = ctx(socket); if (!c || !c.seat.charId) return cb && cb({ ok: false });
      const { room, seat } = c;
      const r = room.game.submitAnswers(seat.charId, payload || {});
      if (!r.ok) return cb && cb(r);
      cb && cb({ ok: true });
      broadcast(room);
      if (room.game.allAnswered()) setTimeout(() => { if (rooms.has(room.code) && room.stage === 'play') nextPhase(room); }, 600);
    });

    socket.on('disconnect', () => {
      const c = ctx(socket);
      if (!c) return;
      c.seat.connected = false;
      c.seat.socketId = null;
      // ロビー中の切断は席ごと削除
      if (c.room.stage === 'lobby') {
        c.room.seats.splice(c.idx, 1);
        if (c.room.seats.length === 0) { clearTimer(c.room); rooms.delete(c.room.code); return; }
        if (c.room.hostIdx >= c.room.seats.length) c.room.hostIdx = 0;
      }
      broadcast(c.room);
    });
  });

  /* 掃除 */
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.createdAt > ROOM_TTL) { clearTimer(room); rooms.delete(code); }
    }
  }, 30 * 60 * 1000);

  return { rooms };
};
