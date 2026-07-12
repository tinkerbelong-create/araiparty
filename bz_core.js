/* ドロボウ市場(いちば) コアロジック — AI作オリジナルゲーム
 *
 * 売れているショートゲームの定石(同時出し・バッティング無効=ハゲタカのえじき系、
 * 使い切りリソース、セットコレクション)をベースにAIが設計したオリジナル作品。
 *
 * 【ルール概要】2〜4人 / 10ラウンド / 約8分
 *  - 毎ラウンド、人数分の品物(コイン/宝石/ドロボウ)が市場に並ぶ
 *  - 全員が手持ちの値札(1〜5、使い切り・5ラウンドで一巡)から1枚を同時に出す
 *  - 高い値札の人から順に、残っている一番良い品物を自動で取る
 *  - 同じ数字を出した人同士は「ケンカ」になり何も取れない(品物は流れる)
 *  - ドロボウ(マイナス点)は最後まで残るので、一番安い値札の人に押し付けられがち
 *    → わざとケンカを狙ってドロボウを回避する読み合いが核
 *  - 宝石は1個2点+3色セットごとに+7点。10ラウンド後の合計点勝負 */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [1, 2, 3, 4, 5];
const ROUNDS = 10;
const GEM_COLORS = ['R', 'G', 'B'];
const GEM_VALUE = 2;      // 宝石1個の点
const SET_BONUS = 7;      // 3色セットの追加点

/* ── デッキ(40枚) ── */
function buildDeck(rng) {
  const deck = [];
  let id = 0;
  // コイン22枚: 1×2, 2×3, 3×4, 4×4, 5×3, 6×3, 7×2, 8×1
  const coinDist = { 1: 2, 2: 3, 3: 4, 4: 4, 5: 3, 6: 3, 7: 2, 8: 1 };
  for (const [v, n] of Object.entries(coinDist))
    for (let i = 0; i < n; i++) deck.push({ id: id++, t: 'coin', v: Number(v) });
  // 宝石12枚: 3色×4
  for (const c of GEM_COLORS)
    for (let i = 0; i < 4; i++) deck.push({ id: id++, t: 'gem', c, v: GEM_VALUE });
  // ドロボウ6枚: −3×2, −4×2, −5×2
  for (const v of [-3, -3, -4, -4, -5, -5]) deck.push({ id: id++, t: 'thief', v });
  // シャッフル
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* ── 品物の評価(自動取得・CPU共用): 取る人の宝石状況でセット完成を加味 ── */
function evalItem(item, gems) {
  if (item.t === 'coin') return item.v;
  if (item.t === 'thief') return item.v;
  // 宝石: 基礎2点 + セット完成に近づく価値
  const g = { R: gems.R, G: gems.G, B: gems.B };
  const before = Math.min(g.R, g.G, g.B);
  g[item.c]++;
  const after = Math.min(g.R, g.G, g.B);
  if (after > before) return GEM_VALUE + SET_BONUS;         // セット完成!
  const have = gems[item.c];
  return GEM_VALUE + (have === 0 ? 1.5 : have === 1 ? 0.5 : 0); // 新しい色ほど価値
}

/* ══ エンジン ══ */
class BZEngine {
  constructor(playerCount, seed = Date.now()) {
    if (playerCount < 2 || playerCount > 4) throw new Error('2〜4人用です');
    this.n = playerCount;
    this.rng = mulberry32(seed & 0xffffffff);
    this.deck = buildDeck(this.rng);
    this.round = 1;               // 1..10
    this.scores = Array.from({ length: playerCount }, () => 0);
    this.gems = Array.from({ length: playerCount }, () => ({ R: 0, G: 0, B: 0 }));
    this.sets = Array.from({ length: playerCount }, () => 0);
    this.thieves = Array.from({ length: playerCount }, () => 0); // 食らったドロボウ枚数
    this.tokens = Array.from({ length: playerCount }, () => TOKENS.slice()); // 残り値札
    this.items = [];              // 今ラウンドの市場
    this.log = [];
    this.dealItems();
  }
  dealItems() {
    this.items = this.deck.splice(0, this.n);
  }
  get finished() { return this.round > ROUNDS; }
  legalTokens(p) { return this.tokens[p].slice(); }

  /* 全員の提出(token配列)を受けてラウンドを解決する */
  resolve(subs) {
    if (subs.length !== this.n) throw new Error('提出数が不正です');
    subs.forEach((t, p) => {
      if (!this.tokens[p].includes(t)) throw new Error(`P${p}: 値札${t}は使用済みです`);
    });
    // 値札を消費
    subs.forEach((t, p) => { this.tokens[p] = this.tokens[p].filter(x => x !== t); });
    // バッティング判定
    const count = {};
    subs.forEach(t => { count[t] = (count[t] || 0) + 1; });
    const uniquePlayers = subs.map((t, p) => ({ t, p })).filter(x => count[x.t] === 1)
      .sort((a, b) => b.t - a.t); // 高い値札から
    const clashed = subs.map((t, p) => ({ t, p })).filter(x => count[x.t] > 1).map(x => x.p);
    // 優先順に「その人にとって一番良い品」を自動取得
    const remaining = this.items.slice();
    const gains = []; // {p, token, item, points, setDone}
    for (const { t, p } of uniquePlayers) {
      let best = 0;
      for (let i = 1; i < remaining.length; i++)
        if (evalItem(remaining[i], this.gems[p]) > evalItem(remaining[best], this.gems[p])) best = i;
      const item = remaining.splice(best, 1)[0];
      let points = 0, setDone = false;
      if (item.t === 'coin') points = item.v;
      else if (item.t === 'thief') { points = item.v; this.thieves[p]++; }
      else { // gem
        const before = Math.min(this.gems[p].R, this.gems[p].G, this.gems[p].B);
        this.gems[p][item.c]++;
        const after = Math.min(this.gems[p].R, this.gems[p].G, this.gems[p].B);
        points = GEM_VALUE;
        if (after > before) { points += SET_BONUS; setDone = true; this.sets[p] = after; }
      }
      this.scores[p] += points;
      gains.push({ p, token: t, item, points, setDone });
    }
    const rec = {
      round: this.round,
      subs: subs.slice(),
      gains,
      clashed,                 // ケンカで何も取れなかった人
      discarded: remaining,    // 流れた品物(ケンカ分)
      scores: this.scores.slice(),
      tokensLeft: this.tokens.map(t => t.slice()),
    };
    this.log.push(rec);
    // 次ラウンドへ
    this.round++;
    if (!this.finished) {
      // 値札一巡(全員使い切ったら補充)
      if (this.tokens.every(t => t.length === 0))
        this.tokens = this.tokens.map(() => TOKENS.slice());
      this.dealItems();
    }
    return rec;
  }

  /* 勝敗: 点 > 宝石数 > ドロボウ被弾の少なさ > 引き分け */
  result() {
    const key = p => [
      this.scores[p],
      this.gems[p].R + this.gems[p].G + this.gems[p].B,
      -this.thieves[p],
    ];
    const order = Array.from({ length: this.n }, (_, p) => p).sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    });
    const topKey = JSON.stringify(key(order[0]));
    const winners = order.filter(p => JSON.stringify(key(p)) === topKey);
    return { order, winners, scores: this.scores.slice() };
  }
}

/* ══ CPUブレイン ══
 * 公開情報(市場・全員の残り値札・点数)から値札を選ぶ。
 * 市場が豊かなら高札で確実に取りに行き、ドロボウだらけなら安札や
 * 「あえて人気そうな札」でケンカ狙い、を確率的に混ぜる。 */
class BZBrain {
  constructor(rng) { this.rng = rng || Math.random; }
  choose(E, me) {
    const rng = this.rng;
    const my = E.tokens[me];
    if (my.length === 1) return my[0];
    const vals = E.items.map(it => evalItem(it, E.gems[me]));
    const best = Math.max(...vals);
    const worst = Math.min(...vals);
    const hasThief = E.items.some(it => it.t === 'thief');
    const myMax = Math.max(...my);
    const oppMax = Math.max(...E.tokens.filter((_, p) => p !== me).map(t => t.length ? Math.max(...t) : 0));
    const sorted = my.slice().sort((a, b) => a - b);
    let pick;
    if (best >= 7 && myMax > oppMax) pick = myMax;              // 大物+最高札を独占→確実に総取り
    else if (best >= 6) pick = rng() < 0.7 ? myMax : sorted[sorted.length - 2] || myMax;
    else if (hasThief && best <= 3) {
      // うまみが薄くドロボウ入り: 安札で流すかケンカ狙い
      pick = rng() < 0.5 ? sorted[0] : sorted[Math.floor(rng() * sorted.length)];
    } else if (worst <= -3) {
      // ドロボウ入りだが良い品もある: 中〜高札
      pick = rng() < 0.6 ? myMax : sorted[Math.floor(sorted.length / 2)];
    } else {
      pick = sorted[Math.floor(sorted.length / 2)] || sorted[0]; // 平凡な場は中札で節約
    }
    if (rng() < 0.2) pick = my[Math.floor(rng() * my.length)];   // 読まれないように2割ランダム
    return pick;
  }
}

module.exports = {
  mulberry32, TOKENS, ROUNDS, GEM_COLORS, GEM_VALUE, SET_BONUS,
  buildDeck, evalItem, BZEngine, BZBrain,
};
