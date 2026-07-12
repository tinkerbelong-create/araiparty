/* クアドルカラー オンライン対戦サーバー(1〜10人) — server-authoritative
 * 同時進行レース。手札は本人だけに送り、抜けた人には全員の手札を公開(観戦)。 */
'use strict';
const QC = require('./qc_core.js');

module.exports = function attach(io, opts = {}) {
  const GAP_MS  = opts.gapMs  || 1200;     // 全員完了→結果画面までの間
  const LOCK_MS = opts.lockMs !== undefined ? opts.lockMs : 2000; // お手つきロック
  const CPU_MIN = opts.cpuMinMs || 15000;  // CPUが1枚はめる間隔(最短)
  const CPU_MAX = opts.cpuMaxMs || 40000;  // (最長)
  const rooms = new Map();
  const CPU_NAMES = ['CPUリス', 'CPUウサギ', 'CPUカメ', 'CPUネコ', 'CPUイヌ', 'CPUペンギン', 'CPUパンダ', 'CPUコアラ', 'CPUフクロウ'];

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'Q' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(c));
    return c;
  }
  function roomOf(socket) {
    for (const room of rooms.values()) if (room.seats.some(s => s.socketId === socket.id)) return room;
    return null;
  }
  function seatIdx(room, socket) { return room.seats.findIndex(s => s.socketId === socket.id); }
  function clearTimers(room) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    (room.cpuTimers || []).forEach(clearTimeout);
    room.cpuTimers = [];
    room.deadline = null;
  }
  function destroy(room) { clearTimers(room); rooms.delete(room.code); }

  /* ── 状態配信 ── */
  function view(room, me) {
    const E = room.engine;
    const meFinished = E ? E.finished.includes(me) : false;
    const pub = {
      code: room.code,
      phase: room.phase, // lobby | play | ended
      isHost: me === 0,
      opts: room.opts,
      deadline: room.deadline,
      board: E ? E.board : null,
      size: E ? E.size : room.opts.size,
      seats: room.seats.map((s, i) => ({
        name: s.name, isCpu: s.isCpu, connected: s.connected,
        remaining: E ? E.remaining(i) : null,
        total: E ? E.pieceCount : room.opts.pieces,
        finished: E ? E.finished.includes(i) : false,
        rank: E && E.finished.includes(i) ? E.finished.indexOf(i) + 1 : null,
        timeMs: E ? (E.finishMs[i] ?? null) : null,
        misses: E ? E.misses[i] : 0,
      })),
    };
    const priv = { myIdx: me };
    if (E) {
      priv.myHand = E.hands[me];
      priv.lockedUntil = room.seats[me].lockedUntil || 0;
      priv.finished = meFinished;
      // 抜けた人だけ全員の手札を観戦できる
      if (meFinished || room.phase === 'ended') {
        priv.allHands = E.hands.map((h, i) => ({
          p: i, name: room.seats[i].name,
          pieces: h.map(x => ({ pattern: x.pattern, placed: x.placed })),
        }));
      }
    }
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('qc:state', view(room, i));
    });
  }

  /* ══ ゲーム進行 ══ */
  function startGame(room) {
    clearTimers(room);
    room.engine = new QC.QCEngine(room.seats.length, room.opts, Date.now());
    room.engine.startAt = Date.now();
    room.phase = 'play';
    room.seats.forEach(s => { s.lockedUntil = 0; });
    const limitMs = opts.limitMsOverride || room.engine.minutes * 60 * 1000; // limitMsOverrideはテスト用
    room.deadline = Date.now() + limitMs;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (rooms.has(room.code) && room.phase === 'play') endGame(room, 'time');
    }, limitMs + 300);
    // CPU: 各ピースをランダムな時刻にはめる予約
    room.cpuTimers = [];
    room.seats.forEach((s, i) => {
      if (!s.isCpu) return;
      scheduleCpu(room, i);
    });
    broadcast(room);
  }
  function scheduleCpu(room, i) {
    const E = room.engine;
    let t = 0;
    for (let k = 0; k < E.pieceCount; k++) {
      t += CPU_MIN + Math.random() * (CPU_MAX - CPU_MIN);
      room.cpuTimers.push(setTimeout(() => {
        if (!rooms.has(room.code) || room.phase !== 'play') return;
        const idx = E.hands[i].findIndex(x => !x.placed);
        if (idx < 0) return;
        const spot = E.findSpot(i, idx);
        if (!spot) return;
        const r = E.place(i, idx, spot[0], spot[1], Date.now() - E.startAt);
        afterPlace(room, i, r);
      }, t));
    }
  }
  function afterPlace(room, p, r) {
    const E = room.engine;
    if (r.ok) {
      // 「はめた」通知(全員へ)
      room.seats.forEach(s => {
        if (!s.isCpu && s.connected && s.socketId)
          io.to(s.socketId).emit('qc:solved', { p, remaining: E.remaining(p) });
      });
      if (r.finished) {
        // 「抜けた!」を全員に通知
        room.seats.forEach(s => {
          if (!s.isCpu && s.connected && s.socketId)
            io.to(s.socketId).emit('qc:finished', { p, rank: r.rank, timeMs: E.finishMs[p] });
        });
      }
    }
    broadcast(room);
    if (E.allFinished) {
      clearTimers(room);
      room.timer = setTimeout(() => { if (rooms.has(room.code)) endGame(room, 'all'); }, GAP_MS);
    }
  }
  function endGame(room, reason) {
    clearTimers(room);
    const E = room.engine;
    room.phase = 'ended';
    const res = E.result();
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('qc:end', {
        reason, // 'all' | 'time'
        ranks: res.ranks.map(e => ({ ...e, name: room.seats[e.p].name })),
        board: E.board,
        hands: E.hands.map((h, i) => ({ p: i, name: room.seats[i].name, pieces: h })),
      });
    });
    broadcast(room);
  }

  /* ══ 接続処理 ══ */
  io.on('connection', (socket) => {
    socket.on('qc:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), phase: 'lobby', seats: [], engine: null,
        opts: { size: 6, pieces: 3, minutes: 3 },
        deadline: null, timer: null, cpuTimers: [], createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, connected: true, lockedUntil: 0 });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('qc:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= QC.MAX_PLAYERS) return cb && cb({ ok: false, error: `満席です(${QC.MAX_PLAYERS}人まで)` });
      if (room.seats.some(s => s.name === name)) name = name + (room.seats.length + 1);
      room.seats.push({ name, socketId: socket.id, isCpu: false, connected: true, lockedUntil: 0 });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('qc:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= QC.MAX_PLAYERS) return cb && cb({ ok: false, error: `追加できません(${QC.MAX_PLAYERS}人まで)` });
      const used = room.seats.map(s => s.name);
      const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
      room.seats.push({ name, socketId: null, isCpu: true, connected: true, lockedUntil: 0 });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('qc:removeCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は削除できません' });
      for (let i = room.seats.length - 1; i >= 0; i--) {
        if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* 設定変更(ホストのみ・ロビー中のみ): 盤面36/64マス、手持ち3〜5枚、制限3〜5分 */
    socket.on('qc:setOpts', ({ size, pieces, minutes }, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ変更できます' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は変更できません' });
      if (size !== undefined) {
        if (!QC.BOARD_SIZES.includes(Number(size))) return cb && cb({ ok: false, error: '盤面は6×6か8×8です' });
        room.opts.size = Number(size);
      }
      if (pieces !== undefined) {
        if (!QC.PIECE_COUNTS.includes(Number(pieces))) return cb && cb({ ok: false, error: '手持ちは3〜5枚です' });
        room.opts.pieces = Number(pieces);
      }
      if (minutes !== undefined) {
        if (!QC.MINUTES.includes(Number(minutes))) return cb && cb({ ok: false, error: '制限時間は3〜5分です' });
        room.opts.minutes = Number(minutes);
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('qc:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length < 1) return cb && cb({ ok: false, error: 'プレイヤーがいません' });
      cb && cb({ ok: true });
      startGame(room);
    });

    /* ピース配置 */
    socket.on('qc:place', ({ pieceIdx, r, c }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'play') return cb && cb({ ok: false, error: '対戦中ではありません' });
      const i = seatIdx(room, socket);
      const seat = room.seats[i];
      const E = room.engine;
      if (E.finished.includes(i)) return cb && cb({ ok: false, error: 'すでに抜けています' });
      const now = Date.now();
      if (seat.lockedUntil && now < seat.lockedUntil)
        return cb && cb({ ok: false, error: 'お手つき中…', locked: true, lockedUntil: seat.lockedUntil });
      let r2;
      try {
        r2 = E.place(i, Number(pieceIdx), Number(r), Number(c), now - E.startAt);
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      if (!r2.ok) {
        if (r2.miss) {
          seat.lockedUntil = now + LOCK_MS; // お手つき: 少しの間置けない
          cb && cb({ ok: false, error: r2.error, miss: true, lockedUntil: seat.lockedUntil });
          broadcast(room);
          return;
        }
        return cb && cb({ ok: false, error: r2.error });
      }
      cb && cb({ ok: true, finished: r2.finished, rank: r2.rank });
      afterPlace(room, i, r2);
    });

    socket.on('qc:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimers(room);
      room.engine = null;
      room.phase = 'lobby';
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
      /* 対戦中: CPU代行(残りピースを自動で解いていく) */
      s.connected = false; s.isCpu = true; s.socketId = null; s.name += '(CPU代行)';
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      if (room.phase === 'play' && !room.engine.finished.includes(i)) scheduleCpu(room, i);
      broadcast(room);
    });
  });

  /* 古い部屋の掃除 */
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) { clearTimers(room); rooms.delete(code); }
  }, 3600 * 1000);
};
