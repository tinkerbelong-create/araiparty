/* モンオク! オンライン対戦サーバー(2〜4人) — server-authoritative */
'use strict';
const MO = require('./mo_core.js');

module.exports = function attach(io, opts = {}) {
  const BID_MS  = opts.bidMs  || 25_000;  // 入札時間
  const PICK_MS = opts.pickMs || 60_000;  // 編成時間
  const GAP_MS  = opts.gapMs  || 4_500;   // 落札発表の間
  const rooms = new Map();
  const CPU_NAMES = ['CPUガチャ男', 'CPUセリ子', 'CPUフトコロ'];

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'M' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
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

  function view(room, me) {
    const E = room.engine;
    const pub = {
      code: room.code,
      phase: room.phase, // lobby | auction | pick | battle | ended
      isHost: me === 0,
      deadline: room.deadline,
      seats: room.seats.map((s, i) => ({
        name: s.name, isCpu: s.isCpu, connected: s.connected,
        coins: E ? E.coins[i] : MO.COINS,
        won: E ? E.wonCount[i] : 0,
        owned: E ? E.owned[i] : [],        // 手持ちは公開情報
        bidSubmitted: room.phase === 'auction' ? s.bid !== null : false,
        teamSet: E ? E.teams[i] !== null : false,
        points: E ? E.points[i] : 0,
      })),
    };
    if (E) {
      pub.lots = E.lots;           // 競り出品は全公開(先を見て予算計画を立てる)
      pub.lotIdx = E.lotIdx;
      pub.mustBid = E.mustBid;
      pub.auctionLog = E.auctionLog.map(r => ({ lotIdx: r.lotIdx, lot: r.lot, winner: r.winner, price: r.price }));
    }
    const priv = { myIdx: me };
    if (E && room.phase === 'auction') priv.myBid = room.seats[me].bid;
    if (E && (room.phase === 'pick' || room.phase === 'battle' || room.phase === 'ended')) priv.myTeam = E.teams[me];
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('mo:state', view(room, i));
    });
  }

  /* ══ オークション進行 ══ */
  function startLot(room) {
    clearTimer(room);
    const E = room.engine;
    if (E.auctionDone) return startPick(room);
    room.phase = 'auction';
    room.seats.forEach(s => { s.bid = null; });
    // CPU入札(少し遅れて)
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'auction' || room.seats[i].bid !== null) return;
          room.seats[i].bid = s.brain.bid(E, i);
          broadcast(room);
          maybeResolveLot(room);
        }, 800 + Math.random() * 2000);
      }
    });
    room.deadline = Date.now() + BID_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'auction') return;
      room.seats.forEach(s => { if (s.bid === null) s.bid = 0; }); // 時間切れ=パス(強制入札はエンジンが処理)
      maybeResolveLot(room);
    }, BID_MS + 300);
    broadcast(room);
  }
  function maybeResolveLot(room) {
    if (room.phase !== 'auction') return;
    const E = room.engine;
    if (room.seats.some((s, i) => E.needMore(i) && s.bid === null)) return;
    clearTimer(room);
    const rec = E.resolveBids(room.seats.map(s => s.bid === null ? 0 : s.bid));
    room.phase = 'lotReveal';
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('mo:lotResult', { ...rec, auctionDone: E.auctionDone });
    });
    broadcast(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code)) return;
      startLot(room);
    }, GAP_MS);
  }

  /* ══ 編成 ══ */
  function startPick(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'pick';
    room.seats.forEach((s, i) => {
      if ((s.isCpu || !s.connected) && E.teams[i] === null) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'pick' || E.teams[i] !== null) return;
          E.setTeam(i, s.brain.pickTeam(E, i));
          broadcast(room);
          maybeBattle(room);
        }, 1200 + Math.random() * 2500);
      }
    });
    room.deadline = Date.now() + PICK_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'pick') return;
      const brain = new MO.MOBrain(Math.random);
      room.seats.forEach((s, i) => { if (E.teams[i] === null) E.setTeam(i, brain.pickTeam(E, i)); });
      maybeBattle(room);
    }, PICK_MS + 300);
    broadcast(room);
  }
  function maybeBattle(room) {
    const E = room.engine;
    if (room.phase !== 'pick' || !E.allTeamsSet) return;
    clearTimer(room);
    room.phase = 'battle';
    E.runBattles();
    const st = E.standings();
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('mo:battles', {
        teams: E.teams,
        results: E.results,
        points: E.points,
        standings: st,
        names: room.seats.map(x => x.name),
        coins: E.coins,
      });
    });
    room.phase = 'ended';
    broadcast(room);
  }

  /* ══ 接続処理 ══ */
  io.on('connection', (socket) => {
    socket.on('mo:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), phase: 'lobby', seats: [], engine: null,
        deadline: null, timer: null, createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, bid: null });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('mo:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= 4) return cb && cb({ ok: false, error: '満席です(4人まで)' });
      if (room.seats.some(s => s.name === name)) name = name + (room.seats.length + 1);
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, bid: null });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('mo:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= 4) return cb && cb({ ok: false, error: '追加できません(4人まで)' });
      const used = room.seats.map(s => s.name);
      const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
      room.seats.push({ name, socketId: null, isCpu: true, brain: null, connected: true, bid: null });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('mo:removeCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は削除できません' });
      for (let i = room.seats.length - 1; i >= 0; i--) {
        if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('mo:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length < 2) return cb && cb({ ok: false, error: '2人以上必要です(CPU追加もOK)' });
      room.engine = new MO.MOEngine(room.seats.length, Date.now());
      room.seats.forEach((s, i) => { s.bid = null; s.brain = new MO.MOBrain(MO.mulberry32((Date.now() ^ (i * 52361)) & 0xffffffff)); });
      cb && cb({ ok: true });
      startLot(room);
    });

    socket.on('mo:bid', ({ amount }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'auction') return cb && cb({ ok: false, error: '入札タイミングではありません' });
      const i = seatIdx(room, socket);
      const E = room.engine;
      if (!E.needMore(i)) return cb && cb({ ok: false, error: 'もう3体そろっています' });
      if (room.seats[i].bid !== null) return cb && cb({ ok: false, error: '入札済みです' });
      let v = Math.floor(Number(amount));
      if (!Number.isFinite(v) || v < 0) return cb && cb({ ok: false, error: '0以上で入札してください(0=パス)' });
      if (v > E.coins[i]) return cb && cb({ ok: false, error: `コインが足りません(残り${E.coins[i]})` });
      if (v === 0 && E.mustBid) return cb && cb({ ok: false, error: '残りロットが少ないのでパスできません(1以上で入札)' });
      room.seats[i].bid = v;
      cb && cb({ ok: true });
      broadcast(room);
      maybeResolveLot(room);
    });

    socket.on('mo:setTeam', ({ ids }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'pick') return cb && cb({ ok: false, error: '編成タイミングではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.teams[i] !== null) return cb && cb({ ok: false, error: '編成済みです' });
      try {
        room.engine.setTeam(i, ids);
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
      broadcast(room);
      maybeBattle(room);
    });

    socket.on('mo:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.phase = 'lobby';
      room.seats.forEach(s => { s.bid = null; s.brain = null; });
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
      if (!s.brain) s.brain = new MO.MOBrain(MO.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      const E = room.engine;
      if (room.phase === 'auction' && s.bid === null) {
        s.bid = s.brain.bid(E, i);
        maybeResolveLot(room);
      } else if (room.phase === 'pick' && E.teams[i] === null) {
        E.setTeam(i, s.brain.pickTeam(E, i));
        maybeBattle(room);
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
