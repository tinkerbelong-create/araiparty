/* ドロボウ市場 オンライン対戦サーバー(2〜4人) — server-authoritative */
'use strict';
const BZ = require('./bz_core.js');

module.exports = function attach(io, opts = {}) {
  const PLAY_MS = opts.playMs || 25_000;   // 値札を選ぶ時間
  const PICK_MS = opts.pickMs || 20_000;   // 品物を選ぶ時間(1人あたり)
  const GAP_MS  = opts.gapMs  || 6_500;    // 公開演出の間
  const rooms = new Map();
  const CPU_NAMES = ['CPUタヌキ', 'CPUキツネ', 'CPUイタチ'];

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'B' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(c));
    return c;
  }
  function roomOf(socket) {
    for (const room of rooms.values()) if (room.seats.some(s => s.socketId === socket.id)) return room;
    return null;
  }
  function seatIdx(room, socket) { return room.seats.findIndex(s => s.socketId === socket.id); }
  function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } room.deadline = null; }
  function destroy(room) { clearTimer(room); rooms.delete(room.code); }

  /* ── 状態配信(座席は絶対番号 / priv.myIdx で自分を知る) ── */
  function view(room, me) {
    const E = room.engine;
    const pub = {
      code: room.code,
      phase: room.phase, // lobby | play | pick | reveal | ended
      isHost: me === 0,
      round: E ? Math.min(E.round, BZ.ROUNDS) : 0,
      rounds: BZ.ROUNDS,
      items: E && !E.finished ? E.items : [],
      deadline: room.deadline,
      // 品物選択フェーズの公開情報(値札は全公開)
      picking: E && E.pending ? {
        subs: E.pending.subs,
        order: E.pending.order,
        currentPicker: E.currentPicker,
        remainingIds: E.pending.remaining.map(it => it.id),
        gains: E.pending.gains.map(g => ({ p: g.p, token: g.token, itemId: g.item.id, points: g.points, setDone: g.setDone })),
        clashed: E.pending.clashed,
      } : null,
      seats: room.seats.map((s, i) => ({
        name: s.name, isCpu: s.isCpu, connected: s.connected,
        submitted: s.sub !== null && s.sub !== undefined,
        score: E ? E.scores[i] : 0,
        gems: E ? E.gems[i] : { R: 0, G: 0, B: 0 },
        sets: E ? E.sets[i] : 0,
        thieves: E ? E.thieves[i] : 0,
        tokensLeft: E ? E.tokens[i] : BZ.TOKENS, // 残り値札は公開情報(数えれば分かる)
      })),
    };
    const priv = { myIdx: me, myTokens: E ? E.legalTokens(me) : [], mySub: room.seats[me] ? room.seats[me].sub : null };
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('bz:state', view(room, i));
    });
  }

  /* ══ ラウンド進行 ══ */
  function startRound(room) {
    clearTimer(room);
    const E = room.engine;
    if (E.finished) return endGame(room);
    room.phase = 'play';
    room.seats.forEach(s => { s.sub = null; });
    // CPUは少し遅れて提出(人間っぽく)
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'play' || room.seats[i].sub !== null) return;
          room.seats[i].sub = s.brain.choose(E, i);
          broadcast(room);
          maybeResolve(room);
        }, 900 + Math.random() * 1800);
      }
    });
    room.deadline = Date.now() + PLAY_MS;
    room.timer = setTimeout(() => onPlayTimeout(room), PLAY_MS + 300);
    broadcast(room);
  }
  function onPlayTimeout(room) {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'play') return;
    const E = room.engine;
    room.seats.forEach((s, i) => {
      if (s.sub === null || s.sub === undefined) {
        const legal = E.legalTokens(i);
        s.sub = legal[Math.floor(Math.random() * legal.length)]; // 時間切れ: ランダム
      }
    });
    maybeResolve(room);
  }
  function maybeResolve(room) {
    if (room.phase !== 'play') return;
    if (room.seats.some(s => s.sub === null || s.sub === undefined)) return;
    clearTimer(room);
    const E = room.engine;
    const begin = E.beginResolve(room.seats.map(s => s.sub));
    if (begin.rec) return showReveal(room, begin.rec); // 全員ケンカ → 即結果
    room.phase = 'pick';
    schedulePick(room);
  }
  /* 手番の人に品物を選ばせる(CPU/切断は自動、残り1品も自動) */
  function schedulePick(room) {
    clearTimer(room);
    const E = room.engine;
    if (!E.pending) return;
    const p = E.currentPicker;
    const seat = room.seats[p];
    const onlyOne = E.pending.remaining.length === 1;
    if (seat.isCpu || !seat.connected || onlyOne) {
      broadcast(room);
      setTimeout(() => {
        if (!rooms.has(room.code) || room.phase !== 'pick' || E.currentPicker !== p) return;
        doPick(room, p, null);
      }, 1100);
    } else {
      room.deadline = Date.now() + PICK_MS;
      room.timer = setTimeout(() => {
        room.timer = null;
        if (!rooms.has(room.code) || room.phase !== 'pick' || E.currentPicker !== p) return;
        doPick(room, p, null); // 時間切れ: 自動で最良を取る
      }, PICK_MS + 300);
      broadcast(room);
    }
  }
  function doPick(room, p, itemId) {
    const E = room.engine;
    const r = E.pickItem(p, itemId);
    // 取った瞬間を全員に通知(演出用)
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('bz:picked', {
        p, token: r.gain.token, item: r.gain.item, points: r.gain.points, setDone: r.gain.setDone,
      });
    });
    if (r.rec) return showReveal(room, r.rec);
    schedulePick(room);
  }
  function showReveal(room, rec) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'reveal';
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('bz:reveal', { ...rec, finished: E.finished });
    });
    broadcast(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code)) return;
      if (E.finished) endGame(room);
      else startRound(room);
    }, GAP_MS);
  }
  function endGame(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'ended';
    const res = E.result();
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('bz:end', {
        winners: res.winners, order: res.order, scores: res.scores,
        gems: E.gems, sets: E.sets, thieves: E.thieves,
        log: E.log,
      });
    });
    broadcast(room);
  }

  /* ══ 接続処理 ══ */
  io.on('connection', (socket) => {
    socket.on('bz:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), phase: 'lobby', seats: [], engine: null,
        deadline: null, timer: null, createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, sub: null });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('bz:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= 4) return cb && cb({ ok: false, error: '満席です(4人まで)' });
      if (room.seats.some(s => s.name === name)) name = name + (room.seats.length + 1);
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, sub: null });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('bz:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= 4) return cb && cb({ ok: false, error: '追加できません(4人まで)' });
      const used = room.seats.map(s => s.name);
      const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
      room.seats.push({ name, socketId: null, isCpu: true, brain: null, connected: true, sub: null });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('bz:removeCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は削除できません' });
      for (let i = room.seats.length - 1; i >= 0; i--) {
        if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('bz:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length < 2) return cb && cb({ ok: false, error: '2人以上必要です(CPU追加もOK)' });
      room.engine = new BZ.BZEngine(room.seats.length, Date.now());
      room.seats.forEach((s, i) => { s.sub = null; s.brain = new BZ.BZBrain(BZ.mulberry32((Date.now() ^ (i * 30011)) & 0xffffffff)); });
      cb && cb({ ok: true });
      startRound(room);
    });

    socket.on('bz:play', ({ token }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'play') return cb && cb({ ok: false, error: '値札を選ぶタイミングではありません' });
      const i = seatIdx(room, socket);
      const s = room.seats[i];
      if (s.sub !== null && s.sub !== undefined) return cb && cb({ ok: false, error: '提出済みです' });
      const t = Number(token);
      if (!room.engine.legalTokens(i).includes(t)) return cb && cb({ ok: false, error: 'その値札は使えません' });
      s.sub = t;
      cb && cb({ ok: true });
      broadcast(room);
      maybeResolve(room);
    });

    socket.on('bz:pickItem', ({ itemId }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'pick') return cb && cb({ ok: false, error: '品物を選ぶタイミングではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.currentPicker !== i) return cb && cb({ ok: false, error: 'あなたの選ぶ番ではありません' });
      try {
        clearTimer(room);
        doPick(room, i, Number(itemId));
      } catch (e) { schedulePick(room); return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
    });

    socket.on('bz:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.phase = 'lobby';
      room.seats.forEach(s => { s.sub = null; s.brain = null; });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const room = roomOf(socket);
      if (!room) return;
      const i = seatIdx(room, socket);
      const s = room.seats[i];
      if (!room.engine) {
        room.seats.splice(i, 1);
        if (!room.seats.some(x => !x.isCpu)) return destroy(room);
        broadcast(room);
        return;
      }
      /* 対戦中: CPU代行 */
      s.connected = false; s.isCpu = true; s.socketId = null; s.name += '(CPU代行)';
      if (!s.brain) s.brain = new BZ.BZBrain(BZ.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      if (room.phase === 'play' && (s.sub === null || s.sub === undefined)) {
        s.sub = s.brain.choose(room.engine, i);
        maybeResolve(room);
      } else if (room.phase === 'pick' && room.engine.currentPicker === i) {
        schedulePick(room); // CPU化したので自動選択の分岐に入り直す
      }
      broadcast(room);
    });
  });

  /* 古い部屋の掃除 */
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) { clearTimer(room); rooms.delete(code); }
  }, 3600 * 1000);
};
