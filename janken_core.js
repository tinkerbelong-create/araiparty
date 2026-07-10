/* ジャンデッキケン コアロジック v0.3 — 能力実装版 */
'use strict';

const HANDS = ['G', 'C', 'P'];
const HAND_NAME = { G: 'グー', C: 'チョキ', P: 'パー' };
const HAND_EMOJI = { G: '✊', C: '✌️', P: '✋' };
const BEATS = { G: 'C', C: 'P', P: 'G' };
const LOSES = { G: 'P', C: 'G', P: 'C' };
const DRAFT_ORDER = [0, 1, 1, 0, 1, 0, 1, 0, 1, 0];
const MAX_ROUNDS = 30; // もう一丁ループ等の安全弁

/* 能力定義: tr = win|lose|tie|play */
const ABILITIES = {
  double:  { hand: 'G', tr: 'win',  name: 'ダブルナックル',  text: 'このカードでの勝利は2勝分' },
  counter: { hand: 'G', tr: 'win',  name: 'カウンターアイ',  text: '勝ったら、次のラウンドは相手の手を見てから出せる' },
  revG:    { hand: 'G', tr: 'lose', name: 'リベンジ・グー',  text: '負けたら、次のラウンド相手はパーを出せない' },
  freeze:  { hand: 'G', tr: 'play', name: 'フリーズ',        text: 'このラウンド、相手の能力は発動しない' },
  cut:     { hand: 'C', tr: 'tie',  name: 'チョッキン',      text: 'あいこなら、相手の勝利を1消す' },
  revC:    { hand: 'C', tr: 'lose', name: 'リベンジ・チョキ', text: '負けたら、次のラウンド相手はグーを出せない' },
  peektop: { hand: 'C', tr: 'win',  name: '山さぐり',        text: '勝ったら、相手の山札の一番上を自分だけ見る' },
  rebound: { hand: 'C', tr: 'tie',  name: 'もう一丁',        text: 'あいこなら、このカードは手札に戻る' },
  scan:    { hand: 'P', tr: 'play', name: 'スキャン',        text: '出した時、相手の残りのパーの枚数が分かる' },
  revP:    { hand: 'P', tr: 'lose', name: 'リベンジ・パー',  text: '負けたら、次のラウンド相手はチョキを出せない' },
  sticky:  { hand: 'P', tr: 'tie',  name: 'ねばりごし',      text: '次のラウンドもあいこなら、自分の勝ちになる' },
  draw1:   { hand: 'P', tr: 'lose', name: '転売テクニック',  text: '負けたら、山札から1枚ドロー' },
};
const REV_BAN = { revG: 'P', revC: 'G', revP: 'C' };
/* 各手10枚: 能力4種×2 + 素2 */
const HAND_ABS = {
  G: ['double', 'double', 'counter', 'counter', 'revG', 'revG', 'freeze', 'freeze', null, null],
  C: ['cut', 'cut', 'revC', 'revC', 'peektop', 'peektop', 'rebound', 'rebound', null, null],
  P: ['scan', 'scan', 'revP', 'revP', 'sticky', 'sticky', 'draw1', 'draw1', null, null],
};

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
function judge(h0, h1) {
  if (h0 === h1) return 0;
  return BEATS[h0] === h1 ? 1 : -1;
}
function buildDeal(rng) {
  const cards = [];
  HANDS.forEach((h, hi) => {
    HAND_ABS[h].forEach((ab, k) => cards.push({ id: hi * 10 + k + 1, hand: h, ab }));
  });
  shuffle(cards, rng);
  return {
    initial: [cards.slice(0, 7), cards.slice(7, 14)],
    market: cards.slice(14, 29),
    unused: cards[29],
  };
}

class JankenEngine {
  constructor(seed) {
    this.rng = mulberry32(seed ?? (Date.now() & 0xffffffff));
    const deal = buildDeal(this.rng);
    this.decks = [[...deal.initial[0]], [...deal.initial[1]]];
    this.market = [...deal.market];
    this.unused = deal.unused;
    this.draftPicks = [[], []];
    this.draftStep = 0;
    this.phase = 'draft'; // draft | battle | sudden | ended
    this.wins = [0, 0];
    this.round = 0;
    this.piles = null;
    this.hands = null;
    this.discards = [[], []];
    this.winner = null;
    this.endReason = null; // three | more | sudden
    this.suddenLog = [];
    /* 持ち越し効果 */
    this.restrict = [null, null];     // p は次ラウンドこの手を出せない
    this.counterNext = [false, false]; // p は次ラウンドあと出しできる
    this.stickyNext = [false, false];  // p は次ラウンドあいこなら勝ち
  }

  currentDrafter() { return this.phase === 'draft' ? DRAFT_ORDER[this.draftStep] : null; }

  draftPick(pIdx, cardId) {
    if (this.phase !== 'draft') throw new Error('ドラフト中ではない');
    if (DRAFT_ORDER[this.draftStep] !== pIdx) throw new Error('あなたの手番ではない');
    const mi = this.market.findIndex(c => c.id === cardId);
    if (mi < 0) throw new Error('場にないカード');
    const card = this.market.splice(mi, 1)[0];
    this.decks[pIdx].push(card);
    this.draftPicks[pIdx].push(card);
    this.draftStep++;
    if (this.draftStep >= DRAFT_ORDER.length) this.startBattle();
    return card;
  }

  startBattle() {
    this.phase = 'battle';
    this.piles = [shuffle([...this.decks[0]], this.rng), shuffle([...this.decks[1]], this.rng)];
    this.hands = [this.piles[0].splice(0, 5), this.piles[1].splice(0, 5)];
  }

  /* 制限を考慮した出せるカード(全部禁止なら制限無効) */
  legalPlays(p) {
    const ban = this.restrict[p];
    if (!ban) return [...this.hands[p]];
    const ok = this.hands[p].filter(c => c.hand !== ban);
    return ok.length ? ok : [...this.hands[p]];
  }

  playRound(id0, id1) {
    if (this.phase !== 'battle') throw new Error('対戦中ではない');
    this.round++;
    const ids = [id0, id1];
    const cs = [];
    for (const p of [0, 1]) {
      const legal = this.legalPlays(p).map(c => c.id);
      if (!legal.includes(ids[p])) throw new Error(`P${p}: そのカードは出せない(制限中)`);
      const hi = this.hands[p].findIndex(c => c.id === ids[p]);
      const c = this.hands[p].splice(hi, 1)[0];
      cs.push(c);
    }
    /* 持ち越し効果はこのラウンドで消費 */
    const sticky = [...this.stickyNext];
    this.stickyNext = [false, false];
    this.restrict = [null, null];
    this.counterNext = [false, false];
    /* フリーズ: frozen[p]=pのカード能力が無効(フリーズ自体は止められない) */
    const frozen = [cs[1].ab === 'freeze', cs[0].ab === 'freeze'];
    const active = p => !frozen[p] && cs[p].ab;
    const effects = [];       // 公開される発動ログ {p, ab}
    const info = [[], []];    // 本人限定情報
    /* 【出】 */
    for (const p of [0, 1]) {
      if (cs[p].ab === 'freeze') effects.push({ p, ab: 'freeze' }); // フリーズは常に発動
      if (active(p) === 'scan') {
        const cnt = [...this.hands[1 - p], ...this.piles[1 - p]].filter(c => c.hand === 'P').length;
        info[p].push({ ab: 'scan', count: cnt });
        effects.push({ p, ab: 'scan' });
      }
    }
    /* 判定 + ねばりごし変換 */
    let res = judge(cs[0].hand, cs[1].hand);
    if (res === 0) {
      if (sticky[0] && !sticky[1]) { res = 1; effects.push({ p: 0, ab: 'sticky-win' }); }
      else if (sticky[1] && !sticky[0]) { res = -1; effects.push({ p: 1, ab: 'sticky-win' }); }
      // 両者発動は相殺(素のあいこ)
    }
    this.discards[0].push(cs[0]);
    this.discards[1].push(cs[1]);
    /* 勝敗適用(ダブルナックル) */
    const winner = res === 1 ? 0 : res === -1 ? 1 : null;
    if (winner !== null) {
      const inc = active(winner) === 'double' ? 2 : 1;
      this.wins[winner] += inc;
      if (inc === 2) effects.push({ p: winner, ab: 'double' });
    }
    /* 【勝】【負】 */
    if (winner !== null) {
      const w = winner, l = 1 - winner;
      if (active(w) === 'counter') { this.counterNext[w] = true; effects.push({ p: w, ab: 'counter' }); }
      if (active(w) === 'peektop') {
        const top = this.piles[l][0] || null;
        info[w].push({ ab: 'peektop', card: top ? { hand: top.hand, ab: top.ab } : null });
        effects.push({ p: w, ab: 'peektop' });
      }
      if (REV_BAN[active(l)]) { this.restrict[w] = REV_BAN[cs[l].ab]; effects.push({ p: l, ab: cs[l].ab }); }
      if (active(l) === 'draw1' && this.piles[l].length) {
        this.hands[l].push(this.piles[l].shift());
        effects.push({ p: l, ab: 'draw1' });
      }
    } else { /* 【引】(素のあいこのみ) */
      for (const p of [0, 1]) {
        if (active(p) === 'cut') {
          if (this.wins[1 - p] > 0) { this.wins[1 - p]--; effects.push({ p, ab: 'cut' }); }
          else effects.push({ p, ab: 'cut-miss' });
        }
        if (active(p) === 'rebound') {
          this.discards[p].pop();
          this.hands[p].push(cs[p]);
          effects.push({ p, ab: 'rebound' });
        }
        if (active(p) === 'sticky') { this.stickyNext[p] = true; effects.push({ p, ab: 'sticky' }); }
      }
    }
    /* 終了判定 */
    let ended = false;
    if (this.wins[0] >= 3) { this.winner = 0; this.endReason = 'three'; this.phase = 'ended'; ended = true; }
    else if (this.wins[1] >= 3) { this.winner = 1; this.endReason = 'three'; this.phase = 'ended'; ended = true; }
    else {
      for (const p of [0, 1]) if (this.piles[p].length) this.hands[p].push(this.piles[p].shift());
      const anyEmpty = this.hands[0].length === 0 || this.hands[1].length === 0;
      if (anyEmpty || this.round >= MAX_ROUNDS) {
        if (this.wins[0] !== this.wins[1]) {
          this.winner = this.wins[0] > this.wins[1] ? 0 : 1;
          this.endReason = 'more'; this.phase = 'ended'; ended = true;
        } else {
          this.phase = 'sudden';
        }
      }
    }
    return {
      round: this.round,
      cards: cs.map(c => ({ id: c.id, hand: c.hand, ab: c.ab })),
      res, wins: [...this.wins], effects, info,
      restrict: [...this.restrict], counterNext: [...this.counterNext], stickyNext: [...this.stickyNext],
      ended, sudden: this.phase === 'sudden',
    };
  }

  suddenStep() {
    if (this.phase !== 'sudden') throw new Error('サドンデス中ではない');
    const h0 = HANDS[Math.floor(this.rng() * 3)];
    const h1 = HANDS[Math.floor(this.rng() * 3)];
    const res = judge(h0, h1);
    this.suddenLog.push({ h0, h1, res });
    if (res !== 0) {
      this.winner = res === 1 ? 0 : 1;
      this.endReason = 'sudden';
      this.phase = 'ended';
    }
    return { h0, h1, res, ended: this.phase === 'ended' };
  }
}

/* ===== CPU ===== */
const DRAFT_AB_W = {
  double: 1.1, counter: 0.8, cut: 0.8, freeze: 0.5,
  revG: 0.55, revC: 0.55, revP: 0.55,
  scan: 0.35, sticky: 0.5, rebound: 0.5, peektop: 0.3, draw1: 0.3,
};
class JankenBrain {
  constructor(pIdx, rng) { this.p = pIdx; this.rng = rng ?? Math.random; }
  countHands(cards) {
    const c = { G: 0, C: 0, P: 0 };
    cards.forEach(x => c[x.hand]++);
    return c;
  }
  draftChoose(E) {
    const me = this.p, op = 1 - me;
    const mine = this.countHands(E.decks[me]);
    const oppPicks = this.countHands(E.draftPicks[op]);
    let best = null, bestScore = -Infinity;
    for (const card of E.market) {
      const h = card.hand;
      const need = 4 - mine[h];
      const deny = Math.max(0, 2 - oppPicks[h]) * 0.3;
      const abw = card.ab ? (DRAFT_AB_W[card.ab] || 0) : 0;
      const score = need + deny + abw + (this.rng() - 0.5) * 0.8;
      if (score > bestScore) { bestScore = score; best = card; }
    }
    return best.id;
  }
  /* knownOppCard: あと出し(カウンターアイ)時に相手の出したカードが分かる */
  playChoose(E, knownOppCard = null) {
    const me = this.p, op = 1 - me;
    const legal = E.legalPlays(me);
    if (knownOppCard) { // 確定情報で最善手
      let best = legal[0], bestS = -2;
      for (const card of legal) {
        const r = judge(card.hand, knownOppCard.hand);
        const s = r + (card.ab === 'double' && r === 1 ? 0.5 : 0) - (card.ab ? 0.05 : 0);
        if (s > bestS) { bestS = s; best = card; }
      }
      return best.id;
    }
    /* 相手の残り構成を推定 */
    const oppDiscard = this.countHands(E.discards[op]);
    const oppKnown = this.countHands(E.draftPicks[op]);
    const seen = { G: 0, C: 0, P: 0 };
    [...E.decks[me], ...E.draftPicks[op], ...E.market].forEach(c => seen[c.hand]++);
    const unseen = { G: 10 - seen.G, C: 10 - seen.C, P: 10 - seen.P };
    const unseenTotal = Math.max(1, unseen.G + unseen.C + unseen.P);
    const est = {};
    for (const h of HANDS) {
      const knownLeft = Math.max(0, oppKnown[h] - Math.min(oppDiscard[h], oppKnown[h]));
      const unknownDiscarded = Math.max(0, oppDiscard[h] - oppKnown[h]);
      const unknownLeft = Math.max(0, (7 * unseen[h] / unseenTotal) - unknownDiscarded);
      est[h] = knownLeft + unknownLeft;
    }
    /* 相手の制限を考慮 */
    if (E.restrict[op]) est[E.restrict[op]] = 0;
    const total = Math.max(0.001, est.G + est.C + est.P);
    let best = null, bestScore = -Infinity;
    for (const card of legal) {
      const h = card.hand;
      const winP = est[BEATS[h]] / total;
      const loseP = est[LOSES[h]] / total;
      const tieP = est[h] / total;
      let bias = 0;
      if (card.ab === 'double') bias += 0.35 * winP;
      if (card.ab === 'cut' && E.wins[op] > 0) bias += 0.5 * tieP;
      if (card.ab === 'sticky') bias += 0.3 * tieP;
      if (card.ab === 'rebound') bias += 0.2 * tieP;
      if (card.ab === 'counter') bias += 0.15 * winP;
      if (REV_BAN[card.ab]) bias += 0.15 * loseP;
      if (card.ab === 'freeze') bias += 0.05;
      const score = winP - loseP + bias + (this.rng() - 0.5) * 0.2;
      if (score > bestScore) { bestScore = score; best = card; }
    }
    return best.id;
  }
}

const api = {
  HANDS, HAND_NAME, HAND_EMOJI, BEATS, LOSES, DRAFT_ORDER, ABILITIES, REV_BAN, HAND_ABS, MAX_ROUNDS,
  mulberry32, shuffle, judge, buildDeal, JankenEngine, JankenBrain,
};
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.Janken = api;
