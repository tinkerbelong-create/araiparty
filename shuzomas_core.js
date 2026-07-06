/* シュゾマス コアロジック v1.0 — server-authoritative 相当の真実を Engine が保持 */
'use strict';

const ATTR_NAME = { A: '薫', B: '爽', C: '醇', D: '熟' };
const SPECIAL_BY_MISSING = { D: '花', C: '鳥', B: '風', A: '月' }; // 欠けた属性→花鳥風月
const STAR_NAMES = { 1: '楽勝', 2: '簡単', 3: '普通', 4: '難しい', 5: '激ムズ' };
const TARGET = 30; // 3.0% (0.1%=1)

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* (a) 度数のランダム配布: 0..28 ×2 のプールから24個抽出 → 同値最大2を自動保証 */
function dealIngredients(rng) {
  const pool = [];
  for (let d = 0; d <= 28; d++) pool.push(d, d);
  shuffle(pool, rng);
  const dosList = pool.slice(0, 24);
  // 属性は固定: No.1-6=薫(A), 7-12=爽(B), 13-18=醇(C), 19-24=熟(D)
  const attrs = ['A','B','C','D'].flatMap(a => [a,a,a,a,a,a]);
  return dosList.map((dos, i) => ({ id: i + 1, dos, attr: attrs[i] }));
}

/* (b) 難易度カウント: 合計30になる3食材の選び方(同一食材は最大2回) */
function countPatterns(ingredients) {
  const dos = ingredients.map(g => g.dos);
  const n = dos.length;
  let c = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        if (dos[i] + dos[j] + dos[k] === TARGET) c++;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && 2 * dos[i] + dos[j] === TARGET) c++;
  return c;
}
function starsFromPatterns(p) {
  if (p >= 69) return 1;
  if (p >= 59) return 2;
  if (p >= 42) return 3;
  if (p >= 31) return 4;
  return 5;
}

/* (c) 完成酒の判定 */
function sakeLabel(attrs3) {
  const cnt = { A: 0, B: 0, C: 0, D: 0 };
  attrs3.forEach(a => cnt[a]++);
  const max = Math.max(cnt.A, cnt.B, cnt.C, cnt.D);
  if (max === 1) {
    const missing = ['A','B','C','D'].find(a => cnt[a] === 0);
    return SPECIAL_BY_MISSING[missing];
  }
  const mode = ['A','B','C','D'].find(a => cnt[a] === max);
  return ATTR_NAME[mode] + '酒';
}

/* (d) 使用料: buyCount はプレイヤー別・食材別累積。picks は id 3つ(同一は2まで) */
function pickCost(buyCount, picks) {
  const tmp = {};
  let cost = 0;
  for (const id of picks) {
    tmp[id] = (tmp[id] ?? (buyCount[id] || 0)) + 1;
    cost += tmp[id];
  }
  return cost;
}
function isValidPicks(picks) {
  if (!picks || picks.length !== 3) return false;
  const cnt = {};
  picks.forEach(id => cnt[id] = (cnt[id] || 0) + 1);
  return Math.max(...Object.values(cnt)) <= 2;
}

/* 全合法コンボ列挙 (i<=j<=k、全部同一は除外) */
function allCombos(n) {
  const out = [];
  for (let i = 1; i <= n; i++)
    for (let j = i; j <= n; j++)
      for (let k = j; k <= n; k++) {
        if (i === j && j === k) continue;
        out.push([i, j, k]);
      }
  return out;
}
function minBrewCost(buyCount, combos) {
  let m = Infinity;
  for (const c of combos) m = Math.min(m, pickCost(buyCount, c));
  return m;
}

/* competition ranking: dos降順 → [{playerIdx, rank}] */
function rankByDos(entries) { // entries: [{idx, dos}]
  const sorted = [...entries].sort((a, b) => b.dos - a.dos);
  const ranks = [];
  let prevDos = null, prevRank = 0;
  sorted.forEach((e, i) => {
    const rank = (e.dos === prevDos) ? prevRank : i + 1;
    ranks.push({ idx: e.idx, rank });
    prevDos = e.dos; prevRank = rank;
  });
  return ranks;
}

/* ===== Engine ===== */
class Engine {
  constructor(seed, playerCount = 4) {
    this.rng = mulberry32(seed ?? (Date.now() & 0xffffffff));
    this.ingredients = dealIngredients(this.rng);
    this.patterns = countPatterns(this.ingredients);
    this.stars = starsFromPatterns(this.patterns);
    this.combos = allCombos(24);
    this.round = 0;
    this.winnerIdxs = null; // 勝者(複数可)
    this.endReason = null;  // 'exact' | 'survivor' | 'draw'
    this.players = Array.from({ length: playerCount }, (_, i) => ({
      idx: i, money: 10, eval: 5, myIngredientId: null,
      revealed: false, buyCount: {}, restedLastRound: false,
      lastSakeDos: null, lastRank: null,
    }));
    this.log = [];
  }
  ing(id) { return this.ingredients[id - 1]; }
  setMyIngredient(pIdx, id) { this.players[pIdx].myIngredientId = id; }

  canAffordAnyBrew(p) { return minBrewCost(p.buyCount, this.combos) <= p.money; }
  /* 休憩可否: 最小コストの酒すら買えない & 前ラウンド休憩でない。
     ソフトロック回避: 買えない状態で前回も休憩なら例外的に休憩許可 */
  canRest(p) {
    if (this.canAffordAnyBrew(p)) return false;
    return !p.restedLastRound || !this.canAffordAnyBrew(p); // 後半は常にtrue→買えなければ許可
  }
  restIsException(p) { return !this.canAffordAnyBrew(p) && p.restedLastRound; }

  /* submissions: 配列4件 {type:'brew', picks:[id,id,id]} | {type:'rest'} */
  resolveRound(submissions) {
    this.round++;
    const results = this.players.map(() => ({}));
    const brewers = [];

    // 支払い・度数計算
    submissions.forEach((s, i) => {
      const p = this.players[i];
      if (s.type === 'rest') {
        if (this.canAffordAnyBrew(p)) throw new Error(`P${i}: 休憩条件を満たしていない`);
        p.money += 5;
        p.eval = Math.max(0, p.eval - 1);
        p.restedLastRound = true;
        p.lastSakeDos = null;
        results[i] = { type: 'rest', moneyDelta: +5, evalDelta: -1 };
      } else {
        if (!isValidPicks(s.picks)) throw new Error(`P${i}: 不正な選択`);
        const cost = pickCost(p.buyCount, s.picks);
        if (cost > p.money) throw new Error(`P${i}: 支払い不能`);
        p.money -= cost;
        s.picks.forEach(id => p.buyCount[id] = (p.buyCount[id] || 0) + 1);
        const dos = s.picks.reduce((t, id) => t + this.ing(id).dos, 0);
        const label = sakeLabel(s.picks.map(id => this.ing(id).attr));
        p.restedLastRound = false;
        p.lastSakeDos = dos;
        brewers.push({ idx: i, dos });
        results[i] = { type: 'brew', picks: [...s.picks], cost, dos, label, moneyDelta: -cost, evalDelta: 0 };
      }
    });

    // 勝利①: ちょうど3.0% (複数なら同時勝利)
    const exact = brewers.filter(b => b.dos === TARGET);
    if (exact.length > 0) {
      this.winnerIdxs = exact.map(b => b.idx);
      this.endReason = 'exact';
      exact.forEach(b => results[b.idx].winner = true);
      return { results, roundNo: this.round, ended: true };
    }

    // スコアリング
    const HIGH = brewers.filter(b => b.dos >= 31);
    const LOW = brewers.filter(b => b.dos <= 29);
    HIGH.forEach(b => {
      const p = this.players[b.idx];
      const loss = Math.floor(p.money / 2);
      p.money -= loss;
      p.eval = Math.max(0, p.eval - 1);
      results[b.idx].failed = true;
      results[b.idx].moneyDelta -= loss;
      results[b.idx].evalDelta -= 1;
    });
    const PAYOUT = [10, 8, 6, 5, 4, 3, 2, 1]; // 1位から順(最大8人)
    const ranked = rankByDos(LOW);
    ranked.forEach(({ idx, rank }) => {
      const p = this.players[idx];
      const pay = PAYOUT[rank - 1] || 1;
      p.money += pay;
      results[idx].rank = rank;
      results[idx].moneyDelta += pay;
      if (rank === 1) { p.eval += 1; results[idx].evalDelta += 1; }
    });
    // 失敗者がいないラウンドは最下位(同率は全員)が評価−1
    if (HIGH.length === 0 && ranked.length > 0) {
      const maxRank = Math.max(...ranked.map(r => r.rank));
      if (maxRank > 1) {
        ranked.filter(r => r.rank === maxRank).forEach(({ idx }) => {
          const p = this.players[idx];
          p.eval = Math.max(0, p.eval - 1);
          results[idx].evalDelta -= 1;
        });
      }
    }

    // 評価0 → 永続公開
    this.players.forEach(p => { if (p.eval <= 0) { p.eval = 0; p.revealed = true; } });

    // 勝利②: 評価>0 が1人だけ → 生き残り勝利 / 0人 → 引き分け
    const alive = this.players.filter(p => p.eval > 0);
    if (alive.length === 1) {
      this.winnerIdxs = [alive[0].idx];
      this.endReason = 'survivor';
      return { results, roundNo: this.round, ended: true };
    }
    if (alive.length === 0) {
      this.winnerIdxs = [];
      this.endReason = 'draw';
      return { results, roundNo: this.round, ended: true };
    }
    this.players.forEach((p, i) => { p.lastRank = results[i].rank ?? null; });
    return { results, roundNo: this.round, ended: false };
  }
}

/* ===== CPU AI =====
 * 知識: 自分のマイ食材の度数 + 自分の醸造履歴(picks→合計) + 公開情報(revealedプレイヤーの度数)
 * 推定: known(確定) / est(推定, 初期14) を保持し、履歴で更新
 */
class CpuBrain {
  constructor(pIdx, rng) {
    this.pIdx = pIdx;
    this.rng = rng;
    this.known = {};           // id -> exact dos
    this.est = {};             // id -> estimated dos
    for (let id = 1; id <= 24; id++) this.est[id] = 14;
  }
  setKnown(id, dos) { this.known[id] = dos; this.est[id] = dos; }
  learnBrew(picks, total) {
    // 未知食材へ誤差を配分。未知1種なら確定。
    const cnt = {};
    picks.forEach(id => cnt[id] = (cnt[id] || 0) + 1);
    const unknownIds = Object.keys(cnt).map(Number).filter(id => !(id in this.known));
    const knownSum = picks.reduce((t, id) => t + (id in this.known ? this.known[id] : 0), 0);
    if (unknownIds.length === 0) return;
    if (unknownIds.length === 1) {
      const id = unknownIds[0];
      const rem = total - knownSum;
      if (rem % cnt[id] === 0) this.setKnown(id, rem / cnt[id]);
      else this.est[id] = rem / cnt[id];
      return;
    }
    // 複数未知: 現推定との誤差を等分配
    const estSum = picks.reduce((t, id) => t + (id in this.known ? this.known[id] : this.est[id]), 0);
    const err = total - estSum;
    const totalUnknownCount = unknownIds.reduce((t, id) => t + cnt[id], 0);
    unknownIds.forEach(id => {
      this.est[id] = Math.max(0, Math.min(28, this.est[id] + (err / totalUnknownCount)));
    });
  }
  learnPublic(engine) {
    engine.players.forEach(p => {
      if (p.revealed && p.myIngredientId) {
        this.setKnown(p.myIngredientId, engine.ing(p.myIngredientId).dos);
      }
    });
  }
  chooseMyIngredient(takenIds) {
    const avail = [];
    for (let id = 1; id <= 24; id++) if (!takenIds.includes(id)) avail.push(id);
    return avail[Math.floor(this.rng() * avail.length)];
  }
  decide(engine) {
    const p = engine.players[this.pIdx];
    this.learnPublic(engine);
    const affordable = engine.combos.filter(c => pickCost(p.buyCount, c) <= p.money);
    if (affordable.length === 0) return { type: 'rest' };

    let best = null, bestU = -Infinity;
    for (const c of affordable) {
      const allKnown = c.every(id => id in this.known);
      const est = c.reduce((t, id) => t + (id in this.known ? this.known[id] : this.est[id]), 0);
      const cost = pickCost(p.buyCount, c);
      let u;
      if (allKnown) {
        u = est === TARGET ? 1e9 : (est <= 29 ? est + 2 : -60);
      } else {
        u = est - (est > 29 ? (est - 29) * 4 : 0);
      }
      u -= cost * 0.35;
      u += (this.rng() - 0.5) * 6; // 揺らぎ
      if (u > bestU) { bestU = u; best = c; }
    }
    return { type: 'brew', picks: [...best] };
  }
}

const api = {
  ATTR_NAME, SPECIAL_BY_MISSING, STAR_NAMES, TARGET,
  mulberry32, shuffle, dealIngredients, countPatterns, starsFromPatterns,
  sakeLabel, pickCost, isValidPicks, allCombos, minBrewCost, rankByDos,
  Engine, CpuBrain,
};
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.Shuzomas = api;
