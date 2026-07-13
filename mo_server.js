/* モンオク! オンライン対戦サーバー v2(2〜4人)
 * オークション → 個人ショップ → 手動トーナメント(毎試合選び直し)
 * 初期2体は本人にのみ配信。試合のリプレイは対戦者だけに送る(他は待機) */
'use strict';
const MO = require('./mo_core.js');

module.exports = function attach(io, opts = {}) {
  const BID_MS   = opts.bidMs   || 25_000;
  const SHOP_MS  = opts.shopMs  || 40_000;
  const TPICK_MS = opts.tpickMs || 50_000;  // 試合ごとの編成時間
  const ACT_MS   = opts.actMs   || 25_000;  // バトル1ターンの行動時間
  const SEND_MS  = opts.sendMs  || 15_000;  // 送り出しの時間
  const GAP_MS   = opts.gapMs   || 4_500;
  const CPU_ACT_MS = opts.cpuActMs || 1_200;
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
      phase: room.phase, // lobby | auction | lotReveal | shop | matchPick | battle | matchGap | ended
      isHost: me === 0,
      deadline: room.deadline,
      seats: room.seats.map((s, i) => ({
        name: s.name, isCpu: s.isCpu, connected: s.connected,
        coins: E ? E.coins[i] : MO.COINS,
        ownedCount: E ? E.ownedCount(i) : 2,
        wonMons: E ? E.wonMons[i] : [],       // 落札分だけ公開(初期2体は秘密)
        items: E ? E.items[i] : [],           // アイテムは公開
        bidSubmitted: room.phase === 'auction' ? s.bid !== null : false,
        shopDone: !!s.shopDone,
        pickSubmitted: !!s.pick,
        place: E ? E.places[i] : null,
      })),
    };
    if (E) {
      pub.lots = E.lots;
      pub.lotIdx = E.lotIdx;
      pub.mustBid = E.mustBid;
      if (E.matches) {
        pub.bracket = E.matches.map(m => ({ round: m.round, a: m.a, b: m.b, winner: m.winner }));
        pub.matchIdx = E.matchIdx;
        const cm = E.currentMatch();
        pub.match = cm ? { round: cm.round, a: cm.a, b: cm.b } : null;
      }
    }
    const priv = { myIdx: me };
    if (E) {
      priv.myMons = E.owned(me);   // 初期2体込みの全所持(本人のみ)
      priv.myItems = E.items[me];
      if (room.phase === 'auction') priv.myBid = room.seats[me].bid;
      if (room.phase === 'matchPick') priv.myPick = room.seats[me].pick;
      // バトル中: 対戦者にだけ盤面と行動状況を配信
      if (room.phase === 'battle' && room.battle) {
        const side = sideOf(room, me);
        if (side >= 0) {
          priv.battle = {
            youAre: side,
            snap: room.battle.snapshot(),
            mySubmitted: room.actions[side] !== null,
            oppSubmitted: room.actions[1 - side] !== null,
            needAction: room.battle.needsAction(side),
            legal: room.battle.legalActions(side),
          };
        }
      }
    }
    return { pub, priv };
  }
  function broadcast(room) {
    room.seats.forEach((s, i) => {
      if (!s.isCpu && s.connected && s.socketId) io.to(s.socketId).emit('mo:state', view(room, i));
    });
  }

  /* ══ オークション ══ */
  function startLot(room) {
    clearTimer(room);
    const E = room.engine;
    if (E.auctionDone) return startShop(room);
    room.phase = 'auction';
    room.seats.forEach(s => { s.bid = null; });
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
      room.seats.forEach(s => { if (s.bid === null) s.bid = 0; });
      maybeResolveLot(room);
    }, BID_MS + 300);
    broadcast(room);
  }
  function maybeResolveLot(room) {
    if (room.phase !== 'auction') return;
    if (room.seats.some(s => s.bid === null)) return;
    clearTimer(room);
    const E = room.engine;
    const rec = E.resolveBids(room.seats.map(s => s.bid));
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

  /* ══ ショップ(個人購入) ══ */
  function startShop(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'shop';
    room.seats.forEach(s => { s.shopDone = false; });
    room.seats.forEach((s, i) => {
      if (s.isCpu || !s.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'shop' || s.shopDone) return;
          s.brain.shop(E, i);
          s.shopDone = true;
          broadcast(room);
          maybeEndShop(room);
        }, 1500 + Math.random() * 3000);
      }
    });
    room.deadline = Date.now() + SHOP_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'shop') return;
      room.seats.forEach(s => { s.shopDone = true; });
      maybeEndShop(room);
    }, SHOP_MS + 300);
    broadcast(room);
  }
  function maybeEndShop(room) {
    if (room.phase !== 'shop') return;
    if (room.seats.some(s => !s.shopDone)) return;
    clearTimer(room);
    room.engine.seedBracket();
    startMatchPick(room);
  }

  /* ══ トーナメント ══ */
  function startMatchPick(room) {
    clearTimer(room);
    const E = room.engine;
    const m = E.currentMatch();
    if (!m) return endGame(room);
    room.phase = 'matchPick';
    room.seats.forEach(s => { s.pick = null; });
    for (const p of [m.a, m.b]) {
      const seat = room.seats[p];
      if (seat.isCpu || !seat.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'matchPick' || room.seats[p].pick) return;
          room.seats[p].pick = seat.brain.pickTeam(E, p);
          broadcast(room);
          maybePlayMatch(room);
        }, 1500 + Math.random() * 3000);
      }
    }
    room.deadline = Date.now() + TPICK_MS;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'matchPick') return;
      const brain = new MO.MOBrain(Math.random);
      for (const p of [m.a, m.b]) if (!room.seats[p].pick) room.seats[p].pick = brain.pickTeam(E, p);
      maybePlayMatch(room);
    }, TPICK_MS + 300);
    broadcast(room);
  }
  /* ── 対話型バトル ── */
  function sideOf(room, p) {
    const m = room.engine.currentMatch();
    if (!m) return -1;
    return p === m.a ? 0 : p === m.b ? 1 : -1;
  }
  function maybePlayMatch(room) {
    if (room.phase !== 'matchPick') return;
    const E = room.engine;
    const m = E.currentMatch();
    if (!m || !room.seats[m.a].pick || !room.seats[m.b].pick) return;
    clearTimer(room);
    room.battle = new MO.BattleState(room.seats[m.a].pick, room.seats[m.b].pick, E.items[m.a], E.items[m.b]);
    room.actions = [null, null];
    room.phase = 'battle';
    // 開幕を対戦者に通知
    for (const [p, side] of [[m.a, 0], [m.b, 1]]) {
      const s = room.seats[p];
      if (!s.isCpu && s.connected && s.socketId)
        io.to(s.socketId).emit('mo:battleStart', {
          round: m.round, youAre: side,
          names: [room.seats[m.a].name, room.seats[m.b].name],
          snap: room.battle.snapshot(),
        });
    }
    scheduleBattleActions(room);
  }
  function scheduleBattleActions(room) {
    clearTimer(room);
    const E = room.engine;
    const m = E.currentMatch();
    const bs = room.battle;
    if (!bs) return;
    if (bs.finished) return finishBattle(room);
    room.actions = [null, null];
    for (const side of [0, 1]) {
      if (!bs.needsAction(side)) continue;
      const p = side === 0 ? m.a : m.b;
      const seat = room.seats[p];
      if (seat.isCpu || !seat.connected) {
        setTimeout(() => {
          if (!rooms.has(room.code) || room.phase !== 'battle' || room.battle !== bs) return;
          if (room.actions[side] !== null || !bs.needsAction(side)) return;
          room.actions[side] = bs.phase === 'replace' ? seat.brain.send(bs, side) : seat.brain.act(bs, side);
          broadcast(room);
          maybeStepBattle(room);
        }, CPU_ACT_MS * (0.5 + Math.random()));
      }
    }
    room.deadline = Date.now() + (bs.phase === 'replace' ? SEND_MS : ACT_MS);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code) || room.phase !== 'battle' || room.battle !== bs) return;
      for (const side of [0, 1])
        if (bs.needsAction(side) && room.actions[side] === null)
          room.actions[side] = bs.phase === 'replace' ? { t: 'send', to: bs.aliveIdx(side)[0] } : { t: 'attack' };
      maybeStepBattle(room);
    }, (bs.phase === 'replace' ? SEND_MS : ACT_MS) + 300);
    broadcast(room);
  }
  function maybeStepBattle(room) {
    if (room.phase !== 'battle') return;
    const bs = room.battle;
    for (const side of [0, 1]) if (bs.needsAction(side) && room.actions[side] === null) return;
    clearTimer(room);
    const ev = bs.phase === 'replace'
      ? bs.stepReplace(room.actions[0], room.actions[1])
      : bs.stepChoice(room.actions[0], room.actions[1]);
    const m = room.engine.currentMatch();
    for (const [p, side] of [[m.a, 0], [m.b, 1]]) {
      const s = room.seats[p];
      if (!s.isCpu && s.connected && s.socketId)
        io.to(s.socketId).emit('mo:turn', { events: ev, snap: bs.snapshot(), youAre: side });
    }
    if (bs.finished) finishBattle(room);
    else scheduleBattleActions(room);
  }
  function finishBattle(room) {
    clearTimer(room);
    const E = room.engine;
    const bs = room.battle;
    const rec = E.reportMatch(bs.winner, { hpLeft: bs.hpLeft(), turns: bs.turn });
    room.battle = null;
    room.actions = [null, null];
    room.seats.forEach(s => {
      if (!s.isCpu && s.connected && s.socketId)
        io.to(s.socketId).emit('mo:matchResult', {
          round: rec.round, a: rec.a, b: rec.b, winner: rec.winner,
          names: room.seats.map(x => x.name),
        });
    });
    room.phase = 'matchGap';
    broadcast(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!rooms.has(room.code)) return;
      if (room.engine.tournamentDone) endGame(room);
      else startMatchPick(room);
    }, GAP_MS);
  }
  function endGame(room) {
    clearTimer(room);
    const E = room.engine;
    room.phase = 'ended';
    const st = E.standings();
    room.seats.forEach((s) => {
      if (s.isCpu || !s.connected || !s.socketId) return;
      io.to(s.socketId).emit('mo:end', {
        standings: st,
        names: room.seats.map(x => x.name),
        bracket: E.matches.map(m => ({ round: m.round, a: m.a, b: m.b, winner: m.winner })),
      });
    });
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
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, bid: null, pick: null, shopDone: false });
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
      room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, bid: null, pick: null, shopDone: false });
      cb && cb({ ok: true, code });
      broadcast(room);
    });

    socket.on('mo:addCpu', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return cb && cb({ ok: false, error: 'ホストのみ' });
      if (room.engine || room.seats.length >= 4) return cb && cb({ ok: false, error: '追加できません(4人まで)' });
      const used = room.seats.map(s => s.name);
      const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
      room.seats.push({ name, socketId: null, isCpu: true, brain: null, connected: true, bid: null, pick: null, shopDone: false });
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
      room.seats.forEach((s, i) => { s.bid = null; s.pick = null; s.shopDone = false; s.brain = new MO.MOBrain(MO.mulberry32((Date.now() ^ (i * 52361)) & 0xffffffff)); });
      cb && cb({ ok: true });
      startLot(room);
    });

    socket.on('mo:bid', ({ amount }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'auction') return cb && cb({ ok: false, error: '入札タイミングではありません' });
      const i = seatIdx(room, socket);
      const E = room.engine;
      if (room.seats[i].bid !== null) return cb && cb({ ok: false, error: '入札済みです' });
      let v = Math.floor(Number(amount));
      if (!Number.isFinite(v) || v < 0) return cb && cb({ ok: false, error: '0以上で入札してください(0=パス)' });
      if (v > E.coins[i]) return cb && cb({ ok: false, error: `コインが足りません(残り${E.coins[i]})` });
      if (E.mustBid && E.needMore(i) && v === 0) return cb && cb({ ok: false, error: 'あと' + (3 - E.ownedCount(i)) + '体必要! パスできません(1以上)' });
      if (E.mustBid && !E.needMore(i) && v > 0) return cb && cb({ ok: false, error: '今は足りない人の優先タイム! パスしてね' });
      room.seats[i].bid = v;
      cb && cb({ ok: true });
      broadcast(room);
      maybeResolveLot(room);
    });

    socket.on('mo:buy', ({ itemId }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'shop') return cb && cb({ ok: false, error: 'ショップは開いていません' });
      const i = seatIdx(room, socket);
      if (room.seats[i].shopDone) return cb && cb({ ok: false, error: '買い物は終了しています' });
      try {
        room.engine.buyItem(i, String(itemId));
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      cb && cb({ ok: true });
      broadcast(room);
    });

    socket.on('mo:shopDone', (_, cb) => {
      const room = roomOf(socket);
      if (!room || room.phase !== 'shop') return cb && cb({ ok: false, error: 'ショップは開いていません' });
      room.seats[seatIdx(room, socket)].shopDone = true;
      cb && cb({ ok: true });
      broadcast(room);
      maybeEndShop(room);
    });

    /* トーナメント: 試合ごとの編成(対戦者のみ) */
    socket.on('mo:pickTeam', ({ ids }, cb) => {
      const room = roomOf(socket);
      if (!room || !room.engine || room.phase !== 'matchPick') return cb && cb({ ok: false, error: '編成タイミングではありません' });
      const i = seatIdx(room, socket);
      const m = room.engine.currentMatch();
      if (!m || (m.a !== i && m.b !== i)) return cb && cb({ ok: false, error: 'あなたの試合ではありません(待機中)' });
      if (room.seats[i].pick) return cb && cb({ ok: false, error: '編成済みです' });
      let team;
      try {
        team = room.engine.validateTeam(i, ids);
      } catch (e) { return cb && cb({ ok: false, error: e.message }); }
      room.seats[i].pick = team;
      cb && cb({ ok: true });
      broadcast(room);
      maybePlayMatch(room);
    });

    /* バトルの行動: {t:'attack'} | {t:'switch', to} | {t:'send', to} */
    socket.on('mo:action', (action, cb) => {
      const room = roomOf(socket);
      if (!room || room.phase !== 'battle' || !room.battle) return cb && cb({ ok: false, error: 'バトル中ではありません' });
      const i = seatIdx(room, socket);
      const side = sideOf(room, i);
      if (side < 0) return cb && cb({ ok: false, error: 'あなたの試合ではありません(待機中)' });
      const bs = room.battle;
      if (!bs.needsAction(side)) return cb && cb({ ok: false, error: 'いまは行動できません' });
      if (room.actions[side] !== null) return cb && cb({ ok: false, error: '行動済みです' });
      if (!bs.validate(side, action)) return cb && cb({ ok: false, error: 'その行動はできません' });
      room.actions[side] = { t: action.t, to: action.to !== undefined ? Number(action.to) : undefined };
      cb && cb({ ok: true });
      broadcast(room);
      maybeStepBattle(room);
    });

    socket.on('mo:backToLobby', (_, cb) => {
      const room = roomOf(socket);
      if (!room || seatIdx(room, socket) !== 0) return;
      if (room.engine && room.phase !== 'ended') return;
      clearTimer(room);
      room.engine = null;
      room.phase = 'lobby';
      room.seats.forEach(s => { s.bid = null; s.pick = null; s.shopDone = false; s.brain = null; });
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
      s.connected = false; s.isCpu = true; s.socketId = null; s.name += '(CPU代行)';
      if (!s.brain) s.brain = new MO.MOBrain(MO.mulberry32(Date.now() & 0xffffffff));
      if (!room.seats.some(x => !x.isCpu && x.connected)) return destroy(room);
      const E = room.engine;
      if (room.phase === 'auction' && s.bid === null) {
        s.bid = s.brain.bid(E, i);
        maybeResolveLot(room);
      } else if (room.phase === 'shop' && !s.shopDone) {
        s.brain.shop(E, i);
        s.shopDone = true;
        maybeEndShop(room);
      } else if (room.phase === 'matchPick') {
        const m = E.currentMatch();
        if (m && (m.a === i || m.b === i) && !s.pick) {
          s.pick = s.brain.pickTeam(E, i);
          maybePlayMatch(room);
        }
      } else if (room.phase === 'battle' && room.battle) {
        const side = sideOf(room, i);
        if (side >= 0 && room.battle.needsAction(side) && room.actions[side] === null) {
          room.actions[side] = room.battle.phase === 'replace' ? s.brain.send(room.battle, side) : s.brain.act(room.battle, side);
          maybeStepBattle(room);
        }
      }
      broadcast(room);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 24 * 3600 * 1000) { clearTimer(room); rooms.delete(code); }
  }, 3600 * 1000);
};
