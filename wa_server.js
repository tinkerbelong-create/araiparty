/* ユーレイ?エイリアン? オンライン対戦サーバー(4〜8人) — server-authoritative
 * 陣営・自分の特徴は本人にも送らない(それがゲームの核!)。能力結果は本人だけに配信 */
'use strict';
const WA = require('./wa_core.js');

module.exports = function attach(io, opts = {}) {
  const STUDY_MS  = opts.studyMs  || 90_000;  // 調査フェーズ
  const VOTE_MS   = opts.voteMs   || 30_000;  // 投票フェーズ
  const REVEAL_MS = opts.revealMs || 12_000;  // 開票の間
  const rooms = new Map();
  const CPU_NAMES = ['CPUぽよん', 'CPUぴかり', 'CPUもやし', 'CPUどろん', 'CPUうにょ', 'CPUびび', 'CPUほわん'];

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'W' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
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
      phase: room.phase, // lobby | study | vote | reveal | ended
      isHost: me === 0,
      deadline: room.deadline,
      roundNo: E ? E.roundNo : 0,
      planet: E && !E.finished ? WA.PLANETS[E.roundNo] : null,
      rules: E && !E.finished ? E.round.rules : null,
      seats: room.seats.map((s, i) => ({
        name: s.name, isCpu: s.isCpu, connected: s.connected,
        points: E ? E.points[i] : 0,
        gesture: E && !E.finished ? E.round.gestures[i] : 'none',
        abilityUsed: E && !E.finished ? E.round.abilityUsed[i] : false,
        voted: room.phase === 'vote' ? E.round.votes[i] !== null : false,
        // ★他人の特徴は見える。自分の特徴だけ null(見えない)
        traits: E && !E.finished ? (i === me ? null : E.round.traits[i]) : null,
      })),
    };
    const priv = { myIdx: me };
    if (E && !E.finished) {
      priv.myAbility = E.round.abilities[me];
      priv.abilityUsed = E.round.abilityUsed[me];
      priv.abilityResult = E.round.abilityResult[me]; // 本人の能力結果のみ
      priv.myVote = E.round.votes[me];
      // ★自分の陣営・自分の特徴は絶対に送らない
    }
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('wa:state', view(room, i));
    });
  }

  /* ══ ラウンド進行 ══ */
  function startStudy(room) {
    clearTimer(room);
    const E = room.engine;
    if (E.finished) return endGame(room);
    room.phase = 'study';
    // CPU: 能力使用+そぶり(ばらけた時刻で)
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'study') return;
          const acts = s.brain.actStudy(E, i);
          if (acts.ability && !E.round.abilityUsed[i]) {
            try { E.useAbility(i, acts.ability.target); } catch (e) {}
          }
          // 能力結果を見てからそぶりを更新
          const acts2 = s.brain.actStudy(E, i);
          try { E.setGesture(i, acts2.gesture); } catch (e) {}
          broadcast(room);
        }, 2000 + Math.random() * (opts.cpuStudyMs || 20000));
      }
    });
    room.deadline = Date.now() + STUDY_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (rooms.has(room.code) && room.phase === 'study') startVote(room);
    }, STUDY_MS + 300);
    broadcast(room);
  }
  function startVote(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'vote';
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'vote' || E.round.votes[i] !== null) return;
          E.vote(i, s.brain.chooseVote(E, i));
          broadcast(room);
          maybeCloseVote(room);
        }, 1500 + Math.random() * 6000);
      }
    });
    room.deadline = Date.now() + VOTE_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'vote') return;
      closeRound(room); // 未投票は棄権のまま開票
    }, VOTE_MS + 300);
    broadcast(room);
  }
  function maybeCloseVote(room) {
    if (room.phase !== 'vote') return;
    if (!room.engine.allVoted) return;
    closeRound(room);
  }
  function closeRound(room) {
    clearTimer(room);
    const E = room.engine;
    const rec = E.closeRound();
    room.phase = 'reveal';
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('wa:reveal', {
        ...rec,
        names: room.seats.map(x => x.name),
        finished: E.finished,
        myIdx: i,
      });
    });
    broadcast(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code)) return;
      if (E.finished) endGame(room);
      else startStudy(room);
    }, REVEAL_MS);
  }
  function endGame(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'ended';
    const st = E.standings();
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('wa:end', {
        standings: st,
        names: room.seats.map(x => x.name),
        history: E.history,
      });
    });
    broadcast(room);
  }

  /* ══ 接続処理 ══ */
  io.on('connection', (socket) => {
    socket.on('wa:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), phase: 'lobby', seats: [], engine: null,
        deadline: null, timer: null, createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('wa:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= WA.MAX_PLAYERS) return cb && cb({ ok: false, error: `満席です(${WA.MAX_PLAYERS}人まで)` });
      if (room.seats.some(s => s.name === name)) name = name + (room.seats.length + 1);
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('wa:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= WA.MAX_PLAYERS) return cb && cb({ ok: false, error: `追加できません(${WA.MAX_PLAYERS}人まで)` });
      const used = room.seats.map(s => s.name);
      const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
      room.seats.push({ name, socketId: null, isCpu: true, brain: null, connected: true });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('wa:removeCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は削除できません' });
      for (let i = room.seats.length - 1; i >= 0; i--) {
        if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('wa:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length < WA.MIN_PLAYERS) return cb && cb({ ok: false, error: `${WA.MIN_PLAYERS}人以上必要です(CPU追加もOK)` });
      room.engine = new WA.WAEngine(room.seats.length, Date.now());
      room.seats.forEach((s, i) => { s.brain = new WA.WABrain(WA.mulberry32((Date.now() ^ (i * 7477)) & 0xffffffff)); });
      cb && cb({ ok: true });
      startStudy(room);
    });

    /* そぶり変更(調査フェーズ中いつでも) */
    socket.on('wa:gesture', ({ g }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'study') return cb && cb({ ok: false, error: '今はそぶりを変えられません' });
      const i = seatIdx(room, socket);
      try { room.engine.setGesture(i, String(g)); } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* 能力使用(1ラウンド1回) */
    socket.on('wa:ability', ({ target }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'study') return cb && cb({ ok: false, error: '能力は調査フェーズで使います' });
      const i = seatIdx(room, socket);
      let res;
      try { res = room.engine.useAbility(i, target); } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true, result: res });
      broadcast(room);
    });

    /* 投票 */
    socket.on('wa:vote', ({ v }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'vote') return cb && cb({ ok: false, error: '投票フェーズではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.round.votes[i] !== null) return cb && cb({ ok: false, error: '投票済みです' });
      try { room.engine.vote(i, String(v)); } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
      broadcast(room);
      maybeCloseVote(room);
    });

    socket.on('wa:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.phase = 'lobby';
      room.seats.forEach(s => { s.brain = null; });
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
      if (!s.brain) s.brain = new WA.WABrain(WA.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      const E = room.engine;
      if (room.phase === 'study') {
        const acts = s.brain.actStudy(E, i);
        if (acts.ability && !E.round.abilityUsed[i]) { try { E.useAbility(i, acts.ability.target); } catch (e) {} }
        try { E.setGesture(i, s.brain.actStudy(E, i).gesture); } catch (e) {}
      } else if (room.phase === 'vote' && E.round.votes[i] === null) {
        E.vote(i, s.brain.chooseVote(E, i));
        maybeCloseVote(room);
      }
      broadcast(room);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) { clearTimer(room); rooms.delete(code); }
  }, 3600 * 1000);
};
