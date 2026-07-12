/* ジャンデッキケン オンライン対戦サーバー(1対1) — server-authoritative */
'use strict';
const J = require('./janken_core.js');

module.exports = function attach(io, opts) {
  const PICK_MS = opts.pickMs, PLAY_MS = opts.playMs;
  const GAP_MS = opts.gapMs || 2600; // 公開演出のためのラウンド間隔
  const rooms = new Map();

  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = 'J' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
    while (rooms.has(c));
    return c;
  }
  function roomOf(socket) {
    for (const room of rooms.values()) if (room.seats.some(s => s.socketId === socket.id)) return room;
    return null;
  }
  function seatIdx(room, socket) { return room.seats.findIndex(s => s.socketId === socket.id); }
  function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } room.deadline = null; }

  /* ── 状態配信(各プレイヤー視点: 0=自分) ── */
  function view(room, me) {
    const E = room.engine, op = 1 - me;
    const swapFx = e => ({ p: e.p === me ? 0 : 1, ab: e.ab });
    const pub = {
      code: room.code,
      phase: E ? E.phase : 'lobby',
      isHost: me === 0,
      names: [room.seats[me]?.name || '?', room.seats[op]?.name || null],
      seats: room.seats.map(s => ({ name: s.name, isCpu: s.isCpu, connected: s.connected })),
      round: E ? E.round : 0,
      wins: E && E.wins ? [E.wins[me], E.wins[op]] : [0, 0],
      market: E && E.phase === 'draft' ? E.market : [],
      draftStep: E ? E.draftStep : 0,
      drafter: E && E.phase === 'draft' ? (E.currentDrafter() === me ? 0 : 1) : null,
      draftPicks: E ? [E.draftPicks[me], E.draftPicks[op]] : [[], []],
      discards: E && E.discards ? [E.discards[me], E.discards[op]] : [[], []],
      oppHandCount: E && E.hands ? E.hands[op].length : 0,
      oppPileCount: E && E.piles ? E.piles[op].length : 0,
      restrict: E ? [E.restrict[me], E.restrict[op]] : [null, null],
      counterNext: E ? [E.counterNext[me], E.counterNext[op]] : [false, false],
      stickyNext: E ? [E.stickyNext[me], E.stickyNext[op]] : [false, false],
      mySubmitted: !!room.seats[me].sub,
      oppSubmitted: !!(room.seats[op] && room.seats[op].sub),
      deadline: room.deadline,
      winner: E && E.winner !== null ? (E.winner === me ? 0 : 1) : null,
      endReason: E ? E.endReason : null,
      suddenCount: E ? E.suddenLog.length : 0,
    };
    const priv = {
      myDeck: E ? E.decks[me] : [],
      myHand: E && E.hands ? E.hands[me] : [],
      legalIds: E && E.hands && E.phase === 'battle' ? E.legalPlays(me).map(c => c.id) : [],
      myPileCount: E && E.piles ? E.piles[me].length : 0,
    };
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('jd:state', view(room, i));
    });
  }

  /* ── ドラフト進行 ── */
  function scheduleDraft(room) {
    clearTimer(room);
    const E = room.engine;
    if (!E || E.phase !== 'draft') return;
    const cur = E.currentDrafter();
    const seat = room.seats[cur];
    if (seat.isCpu || !seat.connected) {
      setTimeout(() => {
        if (!rooms.has(room.code) || E.phase !== 'draft' || E.currentDrafter() !== cur) return;
        E.draftPick(cur, seat.brain.draftChoose(E));
        afterDraftStep(room);
      }, 700);
    } else {
      room.deadline = Date.now() + PICK_MS;
      room.timer = setTimeout(() => {
        room.timer = null;
        if (!rooms.has(room.code) || E.phase !== 'draft' || E.currentDrafter() !== cur) return;
        E.draftPick(cur, E.market[Math.floor(Math.random() * E.market.length)].id); // 時間切れ: ランダムピック
        afterDraftStep(room);
      }, PICK_MS + 300);
      broadcast(room);
    }
  }
  function afterDraftStep(room) {
    if (room.engine.phase === 'battle') startBattleRound(room);
    else { broadcast(room); scheduleDraft(room); }
  }

  /* ── 対戦ラウンド進行 ── */
  function startBattleRound(room) {
    clearTimer(room);
    const E = room.engine;
    room.seats.forEach(s => { s.sub = null; });
    room.pendingCounter = E.counterNext[0] ? 0 : E.counterNext[1] ? 1 : -1;
    maybeCpuActs(room);
    if (E.phase !== 'battle') return; // CPU同士で即決着した場合
    setPlayDeadline(room);
    broadcast(room);
  }
  function setPlayDeadline(room) {
    clearTimer(room);
    room.deadline = Date.now() + PLAY_MS;
    room.timer = setTimeout(() => onPlayTimeout(room), PLAY_MS + 300);
  }
  function canAct(room, i) {
    // あと出し権者は相手の提出後にしか出せない
    if (room.pendingCounter === i && !room.seats[1 - i].sub) return false;
    return !room.seats[i].sub;
  }
  function maybeCpuActs(room) {
    const E = room.engine;
    let acted = true;
    while (acted && E.phase === 'battle') {
      acted = false;
      for (const i of [0, 1]) {
        const s = room.seats[i];
        if ((s.isCpu || !s.connected) && !s.sub && canAct(room, i)) {
          let known = null;
          if (room.pendingCounter === i) {
            const oc = room.seats[1 - i].sub;
            known = { hand: oc.hand };
          }
          s.sub = E.hands[i].find(c => c.id === s.brain.playChoose(E, known));
          acted = true;
          notifyCounter(room, i);
        }
      }
      if (room.seats[0].sub && room.seats[1].sub) { resolveRound(room); return; }
    }
  }
  function notifyCounter(room, submitted) {
    // 提出者の相手があと出し権者(人間)なら、カードを見せて考え直しの時間を与える
    const w = room.pendingCounter;
    if (w === -1 || w === submitted) return;
    const ws = room.seats[w];
    if (!ws.isCpu && ws.connected && !ws.sub) {
      io.to(ws.socketId).emit('jd:counter', { card: room.seats[submitted].sub });
      setPlayDeadline(room);
    }
  }
  function onPlayTimeout(room) {
    room.timer = null;
    if (!rooms.has(room.code)) return;
    const E = room.engine;
    if (!E || E.phase !== 'battle') return;
    let forced = false;
    for (const i of [0, 1]) {
      const s = room.seats[i];
      if (!s.isCpu && s.connected && !s.sub && canAct(room, i)) {
        const legal = E.legalPlays(i);
        s.sub = legal[Math.floor(Math.random() * legal.length)]; // 時間切れ: ランダム
        forced = true;
        notifyCounter(room, i);
      }
    }
    if (room.seats[0].sub && room.seats[1].sub) { resolveRound(room); return; }
    if (forced) { maybeCpuActs(room); if (E.phase !== 'battle') return; }
    if (room.seats[0].sub && room.seats[1].sub) { resolveRound(room); return; }
    setPlayDeadline(room); // あと出し権者に新しい持ち時間
    broadcast(room);
  }
  function resolveRound(room) {
    clearTimer(room);
    const E = room.engine;
    const r = E.playRound(room.seats[0].sub.id, room.seats[1].sub.id);
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) return;
      const me = i, op = 1 - i;
      io.to(s.socketId).emit('jd:reveal', {
        round: r.round,
        cards: [r.cards[me], r.cards[op]],
        res: me === 0 ? r.res : -r.res,
        wins: [r.wins[me], r.wins[op]],
        effects: r.effects.map(e => ({ p: e.p === me ? 0 : 1, ab: e.ab })),
        info: r.info[me],
        ended: r.ended,
        sudden: r.sudden,
      });
    });
    if (r.ended) { broadcast(room); return; }
    if (r.sudden) { setTimeout(() => suddenLoop(room), GAP_MS); return; }
    setTimeout(() => { if (rooms.has(room.code) && E.phase === 'battle') startBattleRound(room); }, GAP_MS);
  }
  function suddenLoop(room) {
    if (!rooms.has(room.code)) return;
    const E = room.engine;
    if (E.phase !== 'sudden') return;
    const st = E.suddenStep();
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) return;
      io.to(s.socketId).emit('jd:sudden', {
        h0: i === 0 ? st.h0 : st.h1,
        h1: i === 0 ? st.h1 : st.h0,
        res: i === 0 ? st.res : -st.res,
        count: E.suddenLog.length,
        ended: st.ended,
      });
    });
    if (st.ended) { broadcast(room); return; }
    setTimeout(() => suddenLoop(room), Math.max(600, GAP_MS * 0.6));
  }

  /* ── 接続処理 ── */
  io.on('connection', (socket) => {
    socket.on('jd:createRoom', ({ name }, cb) => {
      name = String(name || '').trim().slice(0, 10) || 'ホスト';
      const room = {
        code: genCode(), seats: [], engine: null,
        deadline: null, timer: null, pendingCounter: -1, createdAt: Date.now(),
      };
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, sub: null });
      rooms.set(room.code, room);
      cb && cb({ ok: true, code: room.code });
      broadcast(room);
    });

    socket.on('jd:joinRoom', ({ code, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 10) || 'ゲスト';
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: '部屋が見つかりません' });
      if (room.engine) return cb && cb({ ok: false, error: 'この部屋は対戦中です' });
      if (room.seats.length >= 2) return cb && cb({ ok: false, error: '満席です(2人まで)' });
      if (room.seats.some(s => s.name === name)) name = name + '2';
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, sub: null });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('jd:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= 2) return cb && cb({ ok: false, error: '追加できません' });
      room.seats.push({ name: 'CPUハンス', socketId: null, isCpu: true, brain: null, connected: true, sub: null });
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('jd:removeCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine) return cb && cb({ ok: false, error: '対戦中は削除できません' });
      for (let i = room.seats.length - 1; i >= 0; i--) {
        if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
      }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('jd:start', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
      if (room.engine) return cb && cb({ ok: false, error: '開始済みです' });
      if (room.seats.length !== 2) return cb && cb({ ok: false, error: '対戦相手(またはCPU)が必要です' });
      room.engine = new J.JankenEngine();
      room.seats.forEach((s, i) => { s.sub = null; s.brain = new J.JankenBrain(i, J.mulberry32((Date.now() ^ (i * 7919)) & 0xffffffff)); });
      cb && cb({ ok: true });
      broadcast(room);
      scheduleDraft(room);
    });

    socket.on('jd:draftPick', ({ id }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine) return cb && cb({ ok: false, error: '対戦中ではありません' });
      const i = seatIdx(room, socket);
      try {
        room.engine.draftPick(i, Number(id));
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
      clearTimer(room);
      afterDraftStep(room);
    });

    socket.on('jd:play', ({ id }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.engine.phase !== 'battle') return cb && cb({ ok: false, error: '対戦中ではありません' });
      const i = seatIdx(room, socket);
      const s = room.seats[i];
      if (s.sub) return cb && cb({ ok: false, error: '提出済みです' });
      if (!canAct(room, i)) return cb && cb({ ok: false, error: '相手の提出を待っています(あと出し権)' });
      const card = room.engine.legalPlays(i).find(c => c.id === Number(id));
      if (!card) return cb && cb({ ok: false, error: 'そのカードは出せません' });
      s.sub = card;
      cb && cb({ ok: true });
      notifyCounter(room, i);
      if (room.seats[0].sub && room.seats[1].sub) { resolveRound(room); return; }
      maybeCpuActs(room);
      broadcast(room);
    });

    socket.on('jd:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.engine.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.pendingCounter = -1;
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
        if (!room.seats.some(x => !x.isCpu)) { clearTimer(room); rooms.delete(room.code); return; }
        // ホスト継承: 先頭が人間になるよう並べ替え
        room.seats.sort((a, b) => (a.isCpu ? 1 : 0) - (b.isCpu ? 1 : 0));
        broadcast(room);
        return;
      }
      // 対戦中: CPU代行
      s.connected = false; s.isCpu = true; s.socketId = null; s.name += '(CPU代行)';
      if (!s.brain) s.brain = new J.JankenBrain(i, J.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) { clearTimer(room); rooms.delete(room.code); return; }
      if (room.engine.phase === 'draft') scheduleDraft(room);
      else if (room.engine.phase === 'battle') { maybeCpuActs(room); if (room.engine.phase === 'battle') broadcast(room); }
      else if (room.engine.phase === 'sudden') suddenLoop(room);
    });
  });

  /* 古い部屋の掃除 */
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) { clearTimer(room); rooms.delete(code); }
  }, 3600 * 1000);
};
