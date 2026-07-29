/* マーダーミステリー オンライン版サーバー(モジュール) — server-authoritative
 * server.js から require('./mm_server.js')(io, opts) で差し込む。
 * 秘匿情報(他人のHO・真相・能力の中身)はサーバーに保持し、本人にしか送らない。
 * 進行は「全員が完了を押す」ことでしか進まない(ホスト操作なし)。 */
'use strict';
const MM = require('./mm_core.js');

module.exports = function attach(io, opts = {}) {
  const rooms = new Map();
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
      code: genCode(), scenarioId,
      stage: 'lobby',            // lobby | play | ended
      game: null,
      seats: [{ name: hostName, socketId, connected: true, charId: null }],
      hostIdx: 0,
      deadline: null, timer: null,
      createdAt: Date.now(),
    };
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

  function lobbyView(room) {
    return {
      code: room.code, stage: room.stage, scenarioId: room.scenarioId, hostIdx: room.hostIdx,
      seats: room.seats.map((s, i) => ({ idx: i, name: s.name, connected: s.connected })),
      deadline: room.deadline,
    };
  }
  function broadcast(room) {
    const lobby = lobbyView(room);
    const pub = room.game ? room.game.publicView()
      : { scenario: MM.listScenarios().find(s => s.id === room.scenarioId) || null };
    room.seats.forEach((s, i) => {
      if (!s.connected || !s.socketId) return;
      const priv = (room.game && s.charId) ? room.game.privateView(s.charId) : { charId: null };
      priv.myIdx = i;
      priv.isHost = i === room.hostIdx;
      io.to(s.socketId).emit('mm:state', { lobby, pub, priv });
    });
  }

  /* 表示用タイマー(自動では進めない) */
  function clearTimer(room) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    room.deadline = null;
  }
  function startTimer(room) {
    clearTimer(room);
    const g = room.game;
    if (!g || g.step !== MM.STEPS.MAIN) return;
    const min = g.phase.minutes;
    if (!min) return;
    room.deadline = Date.now() + min * 60 * 1000;
    room.timer = setTimeout(() => { room.timer = null; broadcast(room); }, min * 60 * 1000 + 200);
  }

  /* ステップを1つ進める */
  function advanceStep(room) {
    const g = room.game;
    const before = g.step;
    // 能力フェーズ本編 → 結果 のときに解決する
    if (before === MM.STEPS.MAIN && g.phaseType === 'ability') g.resolvePhase();
    const r = g.nextStep();
    if (r === 'end') { room.stage = 'ended'; clearTimer(room); broadcast(room); return; }
    if (g.step === MM.STEPS.MAIN) startTimer(room); else clearTimer(room);
    broadcast(room);
  }

  io.on('connection', socket => {

    socket.on('mm:scenarios', (_, cb) => cb && cb({ ok: true, list: MM.listScenarios() }));

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

    /* ホスト: 開始 → キャラをランダムに配る */
    socket.on('mm:start', (_, cb) => {
      const c = ctx(socket); if (!c || !c.isHost) return cb && cb({ ok: false, msg: 'ホストのみ' });
      const { room } = c;
      if (room.stage !== 'lobby') return cb && cb({ ok: false });
      const sc = MM.loadScenario(room.scenarioId);
      if (room.seats.length !== sc.players.max) return cb && cb({ ok: false, msg: `${sc.players.max}人そろってから始めてください` });
      room.game = new MM.Game(room.scenarioId);
      const bySeat = room.game.assignRandom(room.seats.length);
      room.seats.forEach((s, i) => { s.charId = bySeat[i]; });
      room.stage = 'play';
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* 「完了」ボタン — 全員が押したらステップが進む */
    socket.on('mm:ready', (_, cb) => {
      const c = ctx(socket); if (!c || !c.seat.charId) return cb && cb({ ok: false });
      const { room } = c;
      if (room.stage !== 'play') return cb && cb({ ok: false });
      const g = room.game;
      // 本編ステップでは、やることを済ませていないと完了できない
      if (g.step === MM.STEPS.MAIN) {
        if (g.phaseType === 'ability' && !(g.moves[g.phaseIdx] || {})[c.seat.charId])
          return cb && cb({ ok: false, msg: '先に能力を決めてください' });
        if (g.phaseType === 'final' && !g.answers[c.seat.charId])
          return cb && cb({ ok: false, msg: '先に回答を提出してください' });
      }
      const all = g.markReady(c.seat.charId);
      cb && cb({ ok: true });
      if (all) advanceStep(room); else broadcast(room);
    });

    /* 能力の決定 */
    socket.on('mm:act', ({ abilityId, target }, cb) => {
      const c = ctx(socket); if (!c || !c.seat.charId) return cb && cb({ ok: false });
      const { room, seat } = c;
      if (room.stage !== 'play') return cb && cb({ ok: false });
      const r = room.game.submitMove(seat.charId, { abilityId: abilityId || null, target: target || {} });
      if (!r.ok) return cb && cb(r);
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* 最終回答 */
    socket.on('mm:answers', (payload, cb) => {
      const c = ctx(socket); if (!c || !c.seat.charId) return cb && cb({ ok: false });
      const { room, seat } = c;
      const r = room.game.submitAnswers(seat.charId, payload || {});
      if (!r.ok) return cb && cb(r);
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const c = ctx(socket);
      if (!c) return;
      c.seat.connected = false;
      c.seat.socketId = null;
      if (c.room.stage === 'lobby') {
        c.room.seats.splice(c.idx, 1);
        if (!c.room.seats.length) { clearTimer(c.room); rooms.delete(c.room.code); return; }
        if (c.room.hostIdx >= c.room.seats.length) c.room.hostIdx = 0;
      }
      broadcast(c.room);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.createdAt > ROOM_TTL) { clearTimer(room); rooms.delete(code); }
    }
  }, 30 * 60 * 1000);

  return { rooms };
};
