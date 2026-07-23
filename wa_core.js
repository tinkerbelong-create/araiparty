/* ユーレイ?エイリアン? コアロジック
 * 自分の正体(👻ゆうれい / 👽エイリアン)が分からない正体探しゲーム。4〜8人・3ラウンド。
 *
 *  - 全員が「特徴のしるし」を3つ持つが、自分のしるしだけ見えない(他人のは全部見える)
 *  - 共有の「化け物注意情報」(真実のルール)で他人の正体は見極められる。でも自分だけ謎
 *  - 1回きりの能力と「そぶり」(ウソOKの公開シグナル)を頼りに自分の陣営を推理
 *  - 投票は「👻を罰する / 👽を罰する」の多数決。陣営ごと罰せられる
 *  - 得点: 対陣営が罰せられた+3 / 同数で罰なし+1(生存) / 自陣営が罰せられた0
 *  - 3惑星(ラウンド)で正体・特徴・能力を配り直し。合計点で優勝 */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const ROUNDS = 3;
const PLANETS = ['第1惑星 ボヨヨン', '第2惑星 グニャラ', '第3惑星 ドロロン'];

/* 特徴タグ12種(毎ラウンド、👻のしるし2つ・👽のしるし2つが決まり、残りは中立) */
const TRAITS = [
  { id: 'sukitoru', name: 'すきとおる', emoji: '🫥' },
  { id: 'ashinai',  name: 'あしがない', emoji: '🦶' },
  { id: 'hikaru',   name: 'ひかる',     emoji: '✨' },
  { id: 'antenna',  name: 'アンテナ',   emoji: '📡' },
  { id: 'midori',   name: 'みどりいろ', emoji: '🟢' },
  { id: 'marui',    name: 'まるい',     emoji: '⚪' },
  { id: 'tsumetai', name: 'つめたい',   emoji: '🧊' },
  { id: 'fuwafuwa', name: 'ふわふわ',   emoji: '☁️' },
  { id: 'shippo',   name: 'しっぽ',     emoji: '🦎' },
  { id: 'memittsu', name: 'めがみっつ', emoji: '👀' },
  { id: 'kagenai',  name: 'かげがない', emoji: '🌑' },
  { id: 'nureteru', name: 'ぬれている', emoji: '💧' },
];
const TRAIT_BY_ID = Object.fromEntries(TRAITS.map(t => [t.id, t]));

/* 能力6種(1ラウンド1回だけ使える) */
const ABILITIES = {
  kagami:    { name: 'かがみ',     emoji: '🪞', text: '自分の特徴をランダムに1つ見る(しるしなら正体確定!)', target: false },
  kehai:     { name: 'けはい',     emoji: '👣', text: 'プレイヤーを1人えらび、自分と同じ陣営かどうかを知る', target: true },
  toomegane: { name: 'とおめがね', emoji: '🔭', text: 'この星で👻と👽のどちらが多いか(または同数か)を知る', target: false },
  uranai:    { name: 'うらない',   emoji: '🔮', text: '自分の正体を占う。ただし80%の確率でしか当たらない', target: false },
  mimizuku:  { name: 'みみずく',   emoji: '🦉', text: 'この星の👻の総数(自分をふくむ)を知る', target: false },
  nirami:    { name: 'にらみ',     emoji: '👁️', text: 'プレイヤーを1人えらび、その「そぶり」が本心かウソかを見抜く', target: true },
};
const ABILITY_IDS = Object.keys(ABILITIES);

/* ── ラウンド生成 ──
 * 各プレイヤー: 陣営 + 特徴3つ(自陣営のしるしちょうど1つ + 中立2つ)
 * 注意情報(全て真実):
 *  1.「G1/G2のしるしを持つのは👻だけ」 2.「A1/A2のしるしを持つのは👽だけ」
 *  3.「全員、自分の陣営のしるしをちょうど1つ持っている」 */
function generateRound(n, rng) {
  // 陣営: 1〜n-1のあいだで👻の人数をだいたい半々に
  let ghosts;
  do {
    ghosts = Math.floor(n / 2) + (rng() < 0.5 ? 0 : n % 2 === 0 ? (rng() < 0.5 ? -1 : 1) : 1) * (rng() < 0.35 ? 1 : 0);
    ghosts = Math.max(1, Math.min(n - 1, ghosts));
  } while (false);
  const factions = Array.from({ length: n }, (_, i) => i < ghosts ? 'ghost' : 'alien');
  for (let i = factions.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [factions[i], factions[j]] = [factions[j], factions[i]]; }
  // しるし4つ(👻2・👽2)を抽選、残り8つが中立
  const pool = TRAITS.map(t => t.id);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const markers = { ghost: [pool[0], pool[1]], alien: [pool[2], pool[3]] };
  const neutral = pool.slice(4);
  // 特徴: 自陣営のしるし1つ + 中立2つ(重複なし)
  const traits = factions.map(f => {
    const m = markers[f][Math.floor(rng() * 2)];
    const ns = neutral.slice();
    for (let i = ns.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ns[i], ns[j]] = [ns[j], ns[i]]; }
    const arr = [m, ns[0], ns[1]];
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  });
  // 注意情報(表示用テキスト)
  const tn = id => `${TRAIT_BY_ID[id].emoji}${TRAIT_BY_ID[id].name}`;
  const rules = [
    `「${tn(markers.ghost[0])}」「${tn(markers.ghost[1])}」のしるしを持つのは 👻ゆうれい だけ!`,
    `「${tn(markers.alien[0])}」「${tn(markers.alien[1])}」のしるしを持つのは 👽エイリアン だけ!`,
    'ぜんいん、自分の陣営のしるしを ちょうど1つ 持っている(のこり2つはただの特徴)',
  ];
  // 能力をランダム配布(重複あり)
  const abilities = Array.from({ length: n }, () => ABILITY_IDS[Math.floor(rng() * ABILITY_IDS.length)]);
  return { factions, traits, markers, rules, abilities, ghosts: factions.filter(f => f === 'ghost').length };
}

/* ── 能力の解決(結果は本人だけに返す・「Aさんは👻」の直接情報は返さない) ── */
function resolveAbility(round, p, abilityId, target, rng) {
  const f = round.factions;
  switch (abilityId) {
    case 'kagami': {
      const t = round.traits[p][Math.floor(rng() * 3)];
      return { kind: 'kagami', trait: t, text: `あなたの特徴のひとつは…「${TRAIT_BY_ID[t].emoji}${TRAIT_BY_ID[t].name}」だ!` };
    }
    case 'kehai': {
      const same = f[p] === f[target];
      return { kind: 'kehai', target, same, text: same ? 'この人からは…なかまのけはいがする!(同じ陣営)' : 'この人は…自分とはちがうけはいだ!(ちがう陣営)' };
    }
    case 'toomegane': {
      const g = round.ghosts, a = f.length - g;
      const ans = g > a ? '👻ゆうれいのほうが多い' : a > g ? '👽エイリアンのほうが多い' : '👻と👽は同数';
      return { kind: 'toomegane', text: `この星では… ${ans}!` };
    }
    case 'uranai': {
      const truth = f[p];
      const told = rng() < 0.8 ? truth : (truth === 'ghost' ? 'alien' : 'ghost');
      return { kind: 'uranai', told, text: `水晶玉いわく…あなたはたぶん ${told === 'ghost' ? '👻ゆうれい' : '👽エイリアン'}(的中率80%)` };
    }
    case 'mimizuku': {
      return { kind: 'mimizuku', count: round.ghosts, text: `ホーホー…この星の👻は ぜんぶで${round.ghosts}人 だ(あなたをふくむ)` };
    }
    case 'nirami': {
      const ges = round.gestures[target];
      if (!ges || ges === 'none') return { kind: 'nirami', target, result: 'unknown', text: 'すまし顔だ…なにもわからない' };
      const honest = (ges === 'ghost') === (f[target] === 'ghost');
      return { kind: 'nirami', target, result: honest ? 'honest' : 'lie', text: honest ? 'そのそぶり…本心のようだ!' : 'そのそぶり…ウソだ!!' };
    }
    default: throw new Error('未知の能力');
  }
}

/* ── 投票解決 ── */
function resolveVotes(round, votes) {
  // votes: 配列('ghost'|'alien'|null) null=棄権
  let g = 0, a = 0;
  votes.forEach(v => { if (v === 'ghost') g++; else if (v === 'alien') a++; });
  const punished = g > a ? 'ghost' : a > g ? 'alien' : null;
  const results = round.factions.map((f, p) => {
    if (punished === null) return { outcome: 'tie', points: 1 };
    if (f === punished) return { outcome: 'lose', points: 0 };
    return { outcome: 'win', points: 3 };
  });
  return { punished, tally: { ghost: g, alien: a }, results };
}

/* ══ エンジン(3ラウンド) ══ */
class WAEngine {
  constructor(playerCount, seed = Date.now()) {
    if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) throw new Error(`${MIN_PLAYERS}〜${MAX_PLAYERS}人用です`);
    this.n = playerCount;
    this.rng = mulberry32(seed & 0xffffffff);
    this.roundNo = 0;              // 0..2
    this.points = Array.from({ length: playerCount }, () => 0);
    this.history = [];
    this.round = null;
    this.newRound();
  }
  newRound() {
    this.round = generateRound(this.n, this.rng);
    this.round.gestures = Array.from({ length: this.n }, () => 'none'); // none|ghost|alien
    this.round.abilityUsed = Array.from({ length: this.n }, () => false);
    this.round.abilityResult = Array.from({ length: this.n }, () => null);
    this.round.votes = Array.from({ length: this.n }, () => null);
  }
  setGesture(p, g) {
    if (!['none', 'ghost', 'alien'].includes(g)) throw new Error('不正なそぶり');
    this.round.gestures[p] = g;
  }
  useAbility(p, target) {
    const r = this.round;
    if (r.abilityUsed[p]) throw new Error('能力はもう使いました(1ラウンド1回)');
    const ab = r.abilities[p];
    if (ABILITIES[ab].target) {
      target = Number(target);
      if (!Number.isInteger(target) || target < 0 || target >= this.n || target === p) throw new Error('相手を選んでください');
    }
    const res = resolveAbility(r, p, ab, target, this.rng);
    r.abilityUsed[p] = true;
    r.abilityResult[p] = res;
    return res;
  }
  vote(p, v) {
    if (!['ghost', 'alien'].includes(v)) throw new Error('投票は👻か👽です');
    this.round.votes[p] = v;
  }
  get allVoted() { return this.round.votes.every(v => v !== null); }
  /* 開票してラウンドを締める */
  closeRound() {
    const r = this.round;
    const res = resolveVotes(r, r.votes);
    res.results.forEach((x, p) => { this.points[p] += x.points; });
    const rec = {
      roundNo: this.roundNo,
      planet: PLANETS[this.roundNo],
      factions: r.factions.slice(),
      traits: r.traits.map(t => t.slice()),
      markers: r.markers,
      votes: r.votes.slice(),
      punished: res.punished,
      tally: res.tally,
      results: res.results,
      points: this.points.slice(),
    };
    this.history.push(rec);
    this.roundNo++;
    if (!this.finished) this.newRound();
    return rec;
  }
  get finished() { return this.roundNo >= ROUNDS; }
  standings() {
    const arr = Array.from({ length: this.n }, (_, p) => ({
      p, points: this.points[p],
      wins: this.history.filter(h => h.results[p].outcome === 'win').length,
    }));
    arr.sort((x, y) => (y.points - x.points) || (y.wins - x.wins) || (x.p - y.p));
    const top = arr[0];
    const winners = arr.filter(x => x.points === top.points && x.wins === top.wins).map(x => x.p);
    return { order: arr, winners };
  }
}

/* ══ CPUブレイン ══
 * 他人はしるしで完全に見極められる。自分の推定(👻確率)を能力結果で更新し、
 * 「自分じゃない方」を罰する投票をする。そぶりはだいたい正直(2割でウソ)。 */
class WABrain {
  constructor(rng) { this.rng = rng || Math.random; }
  /* 他人の陣営をしるしから判定 */
  classify(round, viewer) {
    const out = {};
    for (let q = 0; q < round.factions.length; q++) {
      if (q === viewer) continue;
      const ts = round.traits[q];
      if (ts.some(t => round.markers.ghost.includes(t))) out[q] = 'ghost';
      else if (ts.some(t => round.markers.alien.includes(t))) out[q] = 'alien';
    }
    return out;
  }
  /* 自分が👻である確率を推定 */
  believeGhost(E, p) {
    const r = E.round;
    let prob = 0.5;
    const res = r.abilityResult[p];
    if (res) {
      if (res.kind === 'kagami') {
        if (r.markers.ghost.includes(res.trait)) prob = 1;
        else if (r.markers.alien.includes(res.trait)) prob = 0;
      } else if (res.kind === 'kehai') {
        const others = this.classify(r, p);
        const t = others[res.target];
        if (t) prob = res.same ? (t === 'ghost' ? 1 : 0) : (t === 'ghost' ? 0 : 1);
      } else if (res.kind === 'uranai') {
        prob = res.told === 'ghost' ? 0.8 : 0.2;
      } else if (res.kind === 'mimizuku' || res.kind === 'toomegane') {
        const others = this.classify(r, p);
        const gOthers = Object.values(others).filter(x => x === 'ghost').length;
        if (res.kind === 'mimizuku') prob = res.count > gOthers ? 1 : 0;
        else {
          const n = E.n, aOthers = n - 1 - gOthers;
          // 「多い/少ない/同数」から自分の分を逆算できるケース
          if (res.text.includes('同数')) prob = gOthers < n / 2 ? 1 : 0;
          else if (res.text.includes('👻ゆうれいのほうが多い')) prob = gOthers <= aOthers ? 1 : 0.7;
          else prob = gOthers >= aOthers ? 0 : 0.3;
        }
      }
    }
    return prob;
  }
  actStudy(E, p) {
    // 能力を(まだなら)使う。ターゲットが要るならランダムな他人
    const r = E.round;
    const acts = {};
    if (!r.abilityUsed[p]) {
      const ab = r.abilities[p];
      let target;
      if (ABILITIES[ab].target) {
        do { target = Math.floor(this.rng() * E.n); } while (target === p);
      }
      acts.ability = { target };
    }
    // そぶり: 自分の推定に沿う(2割でウソ、確信がなければすまし顔)
    const prob = this.believeGhost(E, p);
    let gesture = 'none';
    if (prob >= 0.75) gesture = this.rng() < 0.2 ? 'alien' : 'ghost';
    else if (prob <= 0.25) gesture = this.rng() < 0.2 ? 'ghost' : 'alien';
    acts.gesture = gesture;
    return acts;
  }
  chooseVote(E, p) {
    const prob = this.believeGhost(E, p);
    if (prob > 0.55) return 'alien';   // 自分は👻っぽい → 👽を罰する
    if (prob < 0.45) return 'ghost';
    // 確信なし: 他人の少数派を罰する側に賭ける(自分がそっちの可能性に備える…逆張り半々)
    const others = this.classify(E.round, p);
    const g = Object.values(others).filter(x => x === 'ghost').length;
    const a = Object.keys(others).length - g;
    if (g === a) return this.rng() < 0.5 ? 'ghost' : 'alien';
    return this.rng() < 0.6 ? (g > a ? 'ghost' : 'alien') : (g > a ? 'alien' : 'ghost');
  }
}

module.exports = {
  mulberry32, MIN_PLAYERS, MAX_PLAYERS, ROUNDS, PLANETS,
  TRAITS, TRAIT_BY_ID, ABILITIES, ABILITY_IDS,
  generateRound, resolveAbility, resolveVotes, WAEngine, WABrain,
};
