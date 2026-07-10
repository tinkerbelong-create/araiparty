/* カウントフルーツ オンライン対戦サーバー(1対1) — server-authoritative
 * 正解・採点はすべてサーバー側(cf_core.js)。落下シーケンスは演出のため両者に配信する。 */
'use strict';
const CF = require('./cf_core.js');

module.exports = function attach(io, opts = {}) {
  const QPICK_MS  = opts.qpickMs  || 60_000;  // 15問から3問選ぶ時間
  const SETUP_MS  = opts.setupMs  || 75_000;  // 出題(問題+配分)の時間
  const ANSWER_MS = opts.answerMs || 30_000;  // 回答時間
  const GAP_MS    = opts.gapMs    || 6_000;   // 結果表示の間
  const rooms = new Map();

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'F' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
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

  /* ── 状態配信(各プレイヤー視点: 0=自分) ── */
  function view(room, me) {
    const E = room.engine, op = 1 - me;
    const pub = {
      code: room.code,
      phase: room.phase, // lobby | qpick | setup | drop | answer | result | ended
      isHost: me === 0,
      budget: room.budget,
      names: [room.seats[me]?.name || '?', room.seats[op]?.name || null],
      seats: room.seats.map(s => ({ name: s.name, isCpu: s.isCpu, connected: s.connected })),
      deadline: room.deadline,
    };
    if (E) {
      const info = E.finished ? null : E.duelInfo();
      Object.assign(pub, {
        questions: E.questions.map(q => ({ id: q.id, text: q.text, kind: q.kind })), // 15問は共有公開
        first: E.first === me ? 0 : 1,
        round: Math.min(3, Math.floor(E.duelNo / 2) + 1),
        duelNo: E.duelNo,
        scores: [E.scores[me], E.scores[op]],
        remaining: [E.remaining[me], E.remaining[op]], // 残りフルーツは公開情報
        myRole: info ? (info.setter === me ? 'setter' : 'answerer') : null,
        pickDone: [!!E.picks[me], !!E.picks[op]],
      });
    }
    const priv = {};
    if (E && E.picks[me]) {
      priv.myPicks = E.picks[me];
      priv.myUsed = E.usedQ[me];
    }
    // 回答フェーズ: 回答者にだけ問題を見せる…ではなく両者に見せる(出題者は自分で選んだので知っている)
    if (E && room.phase === 'answer' && E.current) {
      pub.currentQ = { text: E.current.question.text, kind: E.current.resolved.kind, options: E.current.resolved.options || null };
      pub.answered = !!room.answered;
    }
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('cf:state', view(room, i));
    });
  }

  /* ══ フェーズ進行 ══ */
  function startQpick(room) {
    room.phase = 'qpick';
    room.deadline = Date.now() + QPICK_MS;
    clearTimeout(room.timer);
    room.timer = setTimeout(() => onQpickTimeout(room), QPICK_MS + 300);
    // CPUは即選ぶ
    room.seats.forEach((s, i) => {
      if ((s.isCpu || !s.connected) && !room.engine.picks[i]) room.engine.picks[i] = s.brain.pickQuestions(room.engine.questions);
    });
    broadcast(room);
    maybeStartDuels(room);
  }
  function onQpickTimeout(room) {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'qpick') return;
    const E = room.engine;
    // 時間切れ: 未選択分をランダムで埋める
    for (const i of [0, 1]) {
      if (!E.picks[i]) {
        const ids = E.questions.map(q => q.id);
        for (let k = ids.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [ids[k], ids[j]] = [ids[j], ids[k]]; }
        E.picks[i] = ids.slice(0, 3);
      }
    }
    maybeStartDuels(room);
  }
  function maybeStartDuels(room) {
    const E = room.engine;
    if (room.phase !== 'qpick' || !E.picks[0] || !E.picks[1]) return;
    startSetup(room);
  }

  function startSetup(room) {
    clearTimer(room);
    const E = room.engine;
    if (E.finished) return endGame(room);
    room.phase = 'setup';
    room.answered = false;
    const { setter } = E.duelInfo();
    const seat = room.seats[setter];
    if (seat.isCpu || !seat.connected) {
      broadcast(room);
      setTimeout(() => {
        if (!rooms.has(room.code) || room.phase !== 'setup') return;
        const unused = E.picks[setter].filter(id => !E.usedQ[setter].includes(id)).map(id => E.questions.find(q => q.id === id));
        const plan = seat.brain.plan(unused, E.remaining[setter], E.setupsLeftOf(setter));
        doSetup(room, plan.qid, plan.alloc);
      }, 1600);
    } else {
      room.deadline = Date.now() + SETUP_MS;
      room.timer = setTimeout(() => onSetupTimeout(room), SETUP_MS + 300);
      broadcast(room);
    }
  }
  function onSetupTimeout(room) {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'setup') return;
    const E = room.engine;
    const { setter } = E.duelInfo();
    // 時間切れ: 未使用問題からランダム+残りを均等配分
    const unusedIds = E.picks[setter].filter(id => !E.usedQ[setter].includes(id));
    const qid = unusedIds[Math.floor(Math.random() * unusedIds.length)];
    const left = E.setupsLeftOf(setter);
    const total = Math.max(1, Math.floor(E.remaining[setter] / Math.max(1, left)));
    const alloc = { ichigo: 0, cherry: 0, lemon: 0, banana: 0 };
    for (let i = 0; i < total; i++) alloc[CF.FKEYS[Math.floor(Math.random() * 4)]]++;
    doSetup(room, qid, alloc);
  }
  function doSetup(room, qid, alloc) {
    const E = room.engine;
    const cur = E.commitSetup(qid, alloc); // remaining減算・seq/正解確定
    room.phase = 'drop';
    clearTimer(room);
    // 落下映像は両者に同じものを配信(問題文はまだ隠す)
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) {
        io.to(s.socketId).emit('cf:drop', {
          seq: cur.drop.seq, duration: cur.drop.duration,
          setter: E.duelInfo().setter === i ? 0 : 1,
          round: E.duelInfo().round, duelNo: E.duelNo,
        });
      }
    });
    broadcast(room);
    room.timer = setTimeout(() => startAnswer(room), cur.drop.duration + 600);
  }
  function startAnswer(room) {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'drop') return;
    const E = room.engine;
    room.phase = 'answer';
    const { answerer } = E.duelInfo();
    const seat = room.seats[answerer];
    if (seat.isCpu || !seat.connected) {
      broadcast(room);
      setTimeout(() => {
        if (!rooms.has(room.code) || room.phase !== 'answer') return;
        const ans = seat.brain.answer(E.current.question, E.current.resolved, E.current.alloc);
        finishDuel(room, ans);
      }, 2200);
    } else {
      room.deadline = Date.now() + ANSWER_MS;
      room.timer = setTimeout(() => {
        room.timer = null;
        if (!rooms.has(room.code) || room.phase !== 'answer') return;
        finishDuel(room, null); // 時間切れ=0点
      }, ANSWER_MS + 300);
      broadcast(room);
    }
  }
  function finishDuel(room, answer) {
    clearTimer(room);
    const E = room.engine;
    const rec = E.commitAnswer(answer);
    room.phase = 'result';
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('cf:reveal', {
        ...rec,
        setter: rec.setter === i ? 0 : 1,
        answerer: rec.answerer === i ? 0 : 1,
        scores: [rec.scores[i], rec.scores[1 - i]],
        finished: E.finished,
      });
    });
    broadcast(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code)) return;
      if (E.finished) endGame(room);
      else startSetup(room);
    }, GAP_MS);
  }
  function endGame(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'ended';
    const res = E.result();
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('cf:end', {
        scores: [res.scores[i], res.scores[1 - i]],
        winner: res.winner === null ? null : (res.winner === i ? 0 : 1),
        log: E.log.map(r => ({ ...r, setter: r.setter === i ? 0 : 1, answerer: r.answerer === i ? 0 : 1, scores: [r.scores[i], r.scores[1 - i]] })),
      });
    });
    broadcast(room);
  }

  /* ══ 接続処理 ══ */
  io.on('connection', (socket) => {
    socket.on('cf:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), phase: 'lobby', seats: [], engine: null,
        budget: 75, deadline: null, timer: null, answered: false, createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('cf:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= 2) return cb && cb({ ok: false, error: '満席です(2人まで)' });
      if (room.seats.some(s => s.name === name)) name = name + '2';
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('cf:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= 2) return cb && cb({ ok: false, error: '追加できません' });
      room.seats.push({ name: 'CPUモンキー', socketId: null, isCpu: true, brain: null, connected: true });
      cb && cb({ ok: true });
      broadcast(room);
    });

    /* フルーツ総数の変更(ホストのみ・ロビー中のみ) */
    socket.on('cf:setBudget', ({ budget }, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ変更できます' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は変更できません' });
      const b = Math.floor(Number(budget));
      if (!Number.isFinite(b) || b < 15 || b > 300) return cb && cb({ ok: false, error: '15〜300個の範囲で設定してください' });
      room.budget = b;
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('cf:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length !== 2) return cb && cb({ ok: false, error: '対戦相手(またはCPU)が必要です' });
      room.engine = new CF.CFEngine(room.budget, Date.now());
      room.seats.forEach((s, i) => { s.brain = new CF.CFBrain(CF.mulberry32((Date.now() ^ (i * 104729)) & 0xffffffff)); });
      cb && cb({ ok: true });
      startQpick(room);
    });

    /* 15問から3問選ぶ(選択は相手に見えない) */
    socket.on('cf:pick', ({ ids }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'qpick') return cb && cb({ ok: false, error: '問題選択中ではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.picks[i]) return cb && cb({ ok: false, error: '選択済みです' });
      const arr = Array.isArray(ids) ? [...new Set(ids.map(Number))] : [];
      if (arr.length !== 3 || arr.some(id => !room.engine.questions.find(q => q.id === id)))
        return cb && cb({ ok: false, error: '問題を3つ選んでください' });
      room.engine.picks[i] = arr;
      cb && cb({ ok: true });
      broadcast(room);
      maybeStartDuels(room);
    });

    /* 出題: 問題+フルーツ配分 */
    socket.on('cf:setup', ({ qid, alloc }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'setup') return cb && cb({ ok: false, error: '出題フェーズではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.duelInfo().setter !== i) return cb && cb({ ok: false, error: 'あなたは出題者ではありません' });
      try {
        doSetup(room, Number(qid), alloc || {});
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
    });

    /* 回答 */
    socket.on('cf:answer', ({ value }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'answer') return cb && cb({ ok: false, error: '回答フェーズではありません' });
      const i = seatIdx(room, socket);
      if (room.engine.duelInfo().answerer !== i) return cb && cb({ ok: false, error: 'あなたは回答者ではありません' });
      if (room.answered) return cb && cb({ ok: false, error: '回答済みです' });
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0) return cb && cb({ ok: false, error: '0以上の数値で答えてください' });
      room.answered = true;
      cb && cb({ ok: true });
      finishDuel(room, Math.floor(v));
    });

    socket.on('cf:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.phase = 'lobby';
      room.answered = false;
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
      if (!s.brain) s.brain = new CF.CFBrain(CF.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      const E = room.engine;
      if (room.phase === 'qpick') {
        if (!E.picks[i]) { E.picks[i] = s.brain.pickQuestions(E.questions); maybeStartDuels(room); }
      } else if (room.phase === 'setup' && E.duelInfo().setter === i) {
        clearTimer(room);
        startSetup(room); // CPU分岐に入り直す
      } else if (room.phase === 'answer' && E.duelInfo().answerer === i && !room.answered) {
        clearTimer(room);
        const ans = s.brain.answer(E.current.question, E.current.resolved, E.current.alloc);
        setTimeout(() => { if (rooms.has(room.code) && room.phase === 'answer') finishDuel(room, ans); }, 1200);
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
