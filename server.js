/* シュゾマス オンライン版サーバー (server-authoritative)
 * 度数・判定はすべてサーバーが保持。クライアントには可視情報のみ配信。 */
'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const S = require('./shuzomas_core.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ROUND_MS = (parseFloat(process.env.ROUND_SECONDS) || 60) * 1000; // 1ラウンドの考慮時間
const rooms = new Map(); // code -> room
const CPU_NAMES = ['ハンス', 'グレーテル', 'オットー', 'リーゼル', 'ブルーノ', 'エルザ', 'クラウス'];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function makeRoom() {
  const room = {
    code: genCode(),
    phase: 'lobby', // lobby | myselect | play | ended
    seats: [],      // {name, socketId, isCpu, brain, connected, myId, chosen, sub}
    engine: null,
    reveal: null,   // 直近ラウンドの公開結果(観戦/再入室用)
    endInfo: null,
    deadline: null, // 現ラウンドの提出期限(epoch ms)
    timer: null,
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function seatOf(room, socketId) {
  const i = room.seats.findIndex(s => s.socketId === socketId);
  return i >= 0 ? { seat: room.seats[i], idx: i } : null;
}
function humanSeats(room) { return room.seats.filter(s => !s.isCpu); }
function roomOf(socket) {
  for (const room of rooms.values()) if (seatOf(room, socket.id)) return room;
  return null;
}

/* ── 可視情報のみのビュー構築 ── */
function publicState(room) {
  const E = room.engine;
  return {
    code: room.code,
    phase: room.phase,
    round: E ? E.round : 0,
    stars: E ? E.stars : null,
    starName: E ? S.STAR_NAMES[E.stars] : null,
    ingredients: E ? E.ingredients.map(g => ({ id: g.id, attr: g.attr })) : null, // 個別の度数は送らない!
    dosSet: E ? E.ingredients.map(g => g.dos).sort((a, b) => a - b) : null, // 内訳セットのみ公開(昇順)
    deadline: room.phase === 'play' ? room.deadline : null,
    seats: room.seats.map((s, i) => {
      const p = E ? E.players[i] : null;
      return {
        idx: i, name: s.name, isCpu: s.isCpu, connected: s.connected,
        chosen: !!s.myId, submitted: !!s.sub,
        money: p ? p.money : 10, eval: p ? p.eval : 3,
        lastRank: p ? p.lastRank : null,
        lastLabel: s.lastLabel || null,
        revealed: p ? p.revealed : false,
        // 評価0のプレイヤーのみ度数を公開(永続)
        openMyId: p && p.revealed ? p.myIngredientId : null,
        openMyDos: p && p.revealed ? E.ing(p.myIngredientId).dos : null,
        openSakeDos: p && p.revealed ? p.lastSakeDos : null,
      };
    }),
    takenMyIds: room.seats.map(s => s.myId).filter(Boolean),
    endInfo: room.phase === 'ended' ? room.endInfo : null,
  };
}
function privateView(room, idx) {
  const E = room.engine;
  const s = room.seats[idx];
  if (!E || !s.myId) return { myIdx: idx, myId: s.myId || null };
  const p = E.players[idx];
  return {
    myIdx: idx,
    myId: s.myId,
    myDos: E.ing(s.myId).dos,
    buyCount: p.buyCount,
    money: p.money,
    canRest: E.canRest(p),
    submitted: !!s.sub,
  };
}
function broadcast(room) {
  const pub = publicState(room);
  room.seats.forEach((s, i) => {
    if (!s.isCpu && s.connected && s.socketId) {
      io.to(s.socketId).emit('state', { pub, priv: privateView(room, i) });
    }
  });
}

/* ── ラウンドタイマー: 期限切れの席は timeout 提出扱い ── */
function clearRoundTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.deadline = null;
}
function startRoundTimer(room) {
  clearRoundTimer(room);
  if (room.phase !== 'play') return;
  room.deadline = Date.now() + ROUND_MS;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'play') return;
    let forced = false;
    room.seats.forEach(s => {
      if (!s.isCpu && s.connected && !s.sub) { s.sub = { type: 'timeout' }; forced = true; }
    });
    if (forced) { checkRoundDone(room); broadcast(room); }
  }, ROUND_MS + 250); // 通信ラグ分の猶予
}

/* ── ゲーム進行 ── */
function startGame(room) {
  room.engine = new S.Engine(undefined, room.seats.length);
  room.phase = 'myselect';
  room.reveal = null;
  room.endInfo = null;
  room.seats.forEach((s, i) => {
    s.myId = null; s.chosen = false; s.sub = null; s.lastLabel = null;
    if (s.isCpu) s.brain = new S.CpuBrain(i, S.mulberry32((Date.now() ^ (i * 7919)) & 0xffffffff));
  });
  checkMySelectDone(room); // 全員CPUなら即進行(通常は待ち)
  broadcast(room);
}

function chooseMy(room, idx, ingId) {
  const s = room.seats[idx];
  if (room.phase !== 'myselect' || s.myId) return 'すでに選択済みか、選択フェーズではありません';
  if (ingId < 1 || ingId > 24) return '不正な食材です';
  if (room.seats.some(x => x.myId === ingId)) return 'その食材は他の人が選びました';
  s.myId = ingId;
  room.engine.setMyIngredient(idx, ingId);
  if (s.brain) s.brain.setKnown(ingId, room.engine.ing(ingId).dos);
  checkMySelectDone(room);
  broadcast(room);
  return null;
}

function checkMySelectDone(room) {
  // 人間全員が選び終わったらCPUが選ぶ
  if (room.seats.some(s => !s.isCpu && s.connected && !s.myId)) return;
  room.seats.forEach((s, i) => {
    if (!s.myId) {
      const taken = room.seats.map(x => x.myId).filter(Boolean);
      const id = (s.brain || new S.CpuBrain(i, Math.random)).chooseMyIngredient(taken);
      s.myId = id;
      room.engine.setMyIngredient(i, id);
      if (s.brain) s.brain.setKnown(id, room.engine.ing(id).dos);
    }
  });
  if (room.seats.every(s => s.myId)) {
    room.phase = 'play';
    startRoundTimer(room);
  }
}

function submit(room, idx, sub) {
  const E = room.engine;
  const s = room.seats[idx];
  if (room.phase !== 'play') return 'プレイ中ではありません';
  if (s.sub) return '提出済みです';
  const p = E.players[idx];
  if (sub.type === 'rest') {
    if (!E.canRest(p)) return '休憩できるのは最小コストのお酒すら買えないときだけです';
  } else if (sub.type === 'brew') {
    if (!S.isValidPicks(sub.picks)) return '食材は3つ(同じ食材は2つまで)選んでください';
    if (S.pickCost(p.buyCount, sub.picks) > p.money) return '所持金が足りません';
  } else return '不正な提出です';
  if (room.deadline && Date.now() > room.deadline + 500) return '時間切れです';
  s.sub = sub.type === 'brew' ? { type: 'brew', picks: sub.picks.map(Number) } : { type: 'rest' };
  checkRoundDone(room);
  broadcast(room);
  return null;
}

function checkRoundDone(room) {
  if (room.seats.some(s => !s.isCpu && s.connected && !s.sub)) return;
  // CPU(および切断者の代行)が決定
  room.seats.forEach((s, i) => {
    if (!s.sub) s.sub = s.brain.decide(room.engine);
  });
  const subs = room.seats.map(s => s.sub);
  const r = room.engine.resolveRound(subs);
  // CPU学習
  room.seats.forEach((s, i) => {
    if (s.brain && subs[i].type === 'brew') s.brain.learnBrew(subs[i].picks, r.results[i].dos);
  });
  // 公開情報と本人限定情報を分けて配信
  const E = room.engine;
  const pubResults = r.results.map((res, i) => ({
    idx: i,
    type: res.type,
    rank: res.rank ?? null,
    failed: !!res.failed,
    winner: !!res.winner,
    pay: res.pay ?? null, // もらった賞金(表示用)
    label: res.type === 'brew' ? res.label : null, // 完成酒の種類は公開
    moneyDelta: res.moneyDelta ?? 0,
    evalDelta: res.evalDelta ?? 0,
    openDos: (E.players[i].revealed && res.type === 'brew') ? res.dos : null, // 評価0のみ公開
  }));
  room.seats.forEach((s, i) => { s.lastLabel = r.results[i].type === 'brew' ? r.results[i].label : null; });
  room.reveal = { roundNo: r.roundNo, results: pubResults, ended: r.ended };
  if (r.ended) {
    room.phase = 'ended';
    clearRoundTimer(room);
    const franks = {};
    E.finalRanking().forEach(x => { franks[x.idx] = x.rank; });
    room.endInfo = {
      winners: E.winnerIdxs,
      reason: E.endReason,
      patterns: E.patterns,
      stars: E.stars,
      // 最終順位: ピッタリ > 評価 > お金 > 同着
      final: room.seats.map((s, i) => ({
        idx: i, name: s.name, rank: franks[i],
        money: E.players[i].money, eval: E.players[i].eval,
        myId: E.players[i].myIngredientId,
        myDos: E.ing(E.players[i].myIngredientId).dos, // 終了時は全公開
      })).sort((a, b) => a.rank - b.rank),
    };
  }
  room.seats.forEach((s, i) => {
    if (!s.isCpu && s.connected && s.socketId) {
      const mine = r.results[i];
      io.to(s.socketId).emit('reveal', {
        roundNo: r.roundNo,
        results: pubResults,
        ended: r.ended,
        endInfo: room.endInfo,
        mine: mine.type === 'brew'
          ? { type: 'brew', picks: mine.picks, dos: mine.dos, label: mine.label, rank: mine.rank ?? null, failed: !!mine.failed, winner: !!mine.winner }
          : { type: mine.type },
      });
    }
  });
  if (!r.ended) {
    room.seats.forEach(s => { s.sub = null; });
    startRoundTimer(room);
  }
  broadcast(room);
}

/* ── 接続処理 ── */
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    name = String(name || '').trim().slice(0, 10) || 'ホスト';
    const room = makeRoom();
    room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, myId: null, sub: null });
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 10) || 'ゲスト';
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: '部屋が見つかりません' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'この部屋は対戦中です' });
    if (room.seats.length >= 8) return cb({ ok: false, error: '満席です(8人まで)' });
    if (room.seats.some(s => s.name === name)) name = name + (room.seats.length + 1);
    room.seats.push({ name, socketId: socket.id, isCpu: false, brain: null, connected: true, myId: null, sub: null });
    socket.join(room.code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('addCpu', (_, cb) => {
    const room = roomOf(socket);
    if (!room) return cb && cb({ ok: false, error: '部屋にいません' });
    const me = seatOf(room, socket.id);
    if (me.idx !== 0) return cb && cb({ ok: false, error: 'ホストのみ操作できます' });
    if (room.phase !== 'lobby' || room.seats.length >= 8) return cb && cb({ ok: false, error: '追加できません(8人まで)' });
    const used = room.seats.map(s => s.name);
    const name = CPU_NAMES.find(n => !used.includes(n)) || ('CPU' + room.seats.length);
    room.seats.push({ name, socketId: null, isCpu: true, brain: null, connected: true, myId: null, sub: null });
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('removeCpu', (_, cb) => {
    const room = roomOf(socket);
    if (!room) return;
    const me = seatOf(room, socket.id);
    if (me.idx !== 0 || room.phase !== 'lobby') return;
    for (let i = room.seats.length - 1; i >= 0; i--) {
      if (room.seats[i].isCpu) { room.seats.splice(i, 1); break; }
    }
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('startGame', (_, cb) => {
    const room = roomOf(socket);
    if (!room) return cb && cb({ ok: false, error: '部屋にいません' });
    const me = seatOf(room, socket.id);
    if (me.idx !== 0) return cb && cb({ ok: false, error: 'ホストのみ開始できます' });
    if (room.phase !== 'lobby') return cb && cb({ ok: false, error: 'すでに開始しています' });
    if (room.seats.length < 2 || room.seats.length > 8) return cb && cb({ ok: false, error: '2〜8人で開始できます(CPU追加可)' });
    startGame(room);
    cb && cb({ ok: true });
  });

  socket.on('chooseMy', ({ ingId }, cb) => {
    const room = roomOf(socket);
    if (!room) return cb && cb({ ok: false, error: '部屋にいません' });
    const me = seatOf(room, socket.id);
    const err = chooseMy(room, me.idx, Number(ingId));
    cb && cb(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('submit', (sub, cb) => {
    const room = roomOf(socket);
    if (!room) return cb && cb({ ok: false, error: '部屋にいません' });
    const me = seatOf(room, socket.id);
    const err = submit(room, me.idx, sub || {});
    cb && cb(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('backToLobby', (_, cb) => {
    const room = roomOf(socket);
    if (!room) return;
    const me = seatOf(room, socket.id);
    if (me.idx !== 0 || room.phase !== 'ended') return;
    clearRoundTimer(room);
    room.phase = 'lobby';
    room.engine = null;
    room.reveal = null;
    room.endInfo = null;
    room.seats.forEach(s => { s.myId = null; s.sub = null; s.brain = null; });
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const found = seatOf(room, socket.id);
    if (!found) return;
    const { seat, idx } = found;
    if (room.phase === 'lobby') {
      room.seats.splice(idx, 1);
      if (humanSeats(room).length === 0) { rooms.delete(room.code); return; }
    } else {
      // 対戦中の切断はCPUが代行(マイ食材の度数だけ引き継ぐ)
      seat.connected = false;
      seat.isCpu = true;
      seat.socketId = null;
      seat.name = seat.name + '(CPU代行)';
      seat.brain = new S.CpuBrain(idx, S.mulberry32(Date.now() & 0xffffffff));
      if (seat.myId && room.engine) seat.brain.setKnown(seat.myId, room.engine.ing(seat.myId).dos);
      if (humanSeats(room).length === 0) { rooms.delete(room.code); return; }
      if (room.phase === 'myselect') { checkMySelectDone(room); }
      else if (room.phase === 'play') { checkRoundDone(room); }
    }
    broadcast(room);
  });
});

/* 古い部屋の掃除(24時間) */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 24 * 3600 * 1000) rooms.delete(code);
  }
}, 3600 * 1000);

server.listen(PORT, () => console.log(`シュゾマス オンライン版 : http://localhost:${PORT}`));
