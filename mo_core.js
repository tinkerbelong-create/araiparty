/* モンオク! コアロジック
 * オークションでモンスターを集めてコンボ編成で戦う2〜4人ゲーム。
 *  - 各自コイン60+初期モンスター2体(公開)。共有15体を1体ずつ同時入札で競る
 *  - ちょうど3体落札して手持ち5体 → 3体+並び順を秘密で選ぶ
 *  - 総当たりの自動バトル(勝ち抜き3v3)。勝ち3点/引き分け1点。同点は残りコイン
 *  - タイプ相性: 火>草>雷>水>火(有利1.5倍 / 不利0.75倍)
 *  - 能力のコンボ(群れ/応援/仇討ち/毒/再生…)を意識した編成が核 */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COINS = 60;          // 初期コイン
const AUCTION_LOTS = 15;   // 競りに出る数
const NEED_WINS = 3;       // 落札しなければならない数
const TEAM_SIZE = 3;       // 出撃数
const MAX_TURNS = 60;      // バトルのターン上限(超えたらHP割合勝負)

/* タイプ: 火>草>雷>水>火 */
const TYPES = ['fire', 'grass', 'elec', 'water'];
const TYPE_META = {
  fire:  { name: 'ほのお', emoji: '🔥', beats: 'grass' },
  grass: { name: 'くさ',   emoji: '🌿', beats: 'elec' },
  elec:  { name: 'でんき', emoji: '⚡', beats: 'water' },
  water: { name: 'みず',   emoji: '💧', beats: 'fire' },
};
function typeMult(atkType, defType) {
  if (TYPE_META[atkType].beats === defType) return 1.5;
  if (TYPE_META[defType].beats === atkType) return 0.75;
  return 1;
}

/* 能力(コンボの核) */
const ABILITIES = {
  mure:      { name: 'むれ',     text: 'チームの同タイプの味方1体につき自分のこうげき+3' },
  ougen:     { name: 'おうえん', text: '自分が生きている間、チーム全員のこうげき+2' },
  senjin:    { name: 'せんじん', text: '先頭で出撃するとこうげき+4' },
  kataki:    { name: 'かたきうち', text: '味方が倒れるたび自分のこうげき+5' },
  tate:      { name: 'おおだて', text: '登場後、最初に受けるダメージを半分にする' },
  doku:      { name: 'どくばり', text: '攻撃した相手を毒にする(毎ターン3ダメージ)' },
  saisei:    { name: 'さいせい', text: '毎ターン終了時にHP+4' },
  toushi:    { name: 'とうし',   text: '自分のターンが進むたびこうげき+1(最大+6)' },
  sokko:     { name: 'そっこう', text: '登場して最初の攻撃のダメージ2倍' },
  ace:       { name: 'エース',   text: '自分が最後の1体だとこうげき+6・すばやさ+4' },
  typeboost: { name: 'ぞくせい', text: 'タイプ相性で有利なとき、さらにダメージ+4' },
  oukyuu:    { name: 'おうきゅう', text: '自分が倒れたとき、次に出る味方のHP+8' },
};

/* ══ モンスター図鑑(20種・オリジナル) ══ */
const SPECIES = [
  { id: 'meraboo',   name: 'メラボー',     type: 'fire',  emoji: '🔥', hp: 30, atk: 10, spd: 9,  ab: 'sokko' },
  { id: 'hidaneko',  name: 'ヒダネコ',     type: 'fire',  emoji: '😼', hp: 26, atk: 9,  spd: 13, ab: 'senjin' },
  { id: 'kazagon',   name: 'カザゴン',     type: 'fire',  emoji: '🌋', hp: 40, atk: 8,  spd: 5,  ab: 'kataki' },
  { id: 'homuradori',name: 'ホムラドリ',   type: 'fire',  emoji: '🐦', hp: 28, atk: 8,  spd: 12, ab: 'typeboost' },
  { id: 'taimatsun', name: 'タイマッツン', type: 'fire',  emoji: '🕯️', hp: 32, atk: 7,  spd: 8,  ab: 'ougen' },
  { id: 'awagame',   name: 'アワガメ',     type: 'water', emoji: '🐢', hp: 42, atk: 6,  spd: 4,  ab: 'tate' },
  { id: 'shizukun',  name: 'シズックン',   type: 'water', emoji: '💧', hp: 30, atk: 8,  spd: 9,  ab: 'saisei' },
  { id: 'namiuo',    name: 'ナミウオ',     type: 'water', emoji: '🐟', hp: 28, atk: 9,  spd: 11, ab: 'toushi' },
  { id: 'shiomaneki',name: 'シオマネキング', type: 'water', emoji: '🦀', hp: 34, atk: 9, spd: 6,  ab: 'mure' },
  { id: 'yukidaruman',name: 'ユキダルマン', type: 'water', emoji: '☃️', hp: 36, atk: 7,  spd: 7,  ab: 'oukyuu' },
  { id: 'happanin',  name: 'ハッパニン',   type: 'grass', emoji: '🍃', hp: 28, atk: 9,  spd: 12, ab: 'doku' },
  { id: 'morigon',   name: 'モリゴン',     type: 'grass', emoji: '🌳', hp: 40, atk: 7,  spd: 6,  ab: 'saisei' },
  { id: 'kinokoro',  name: 'キノコロ',     type: 'grass', emoji: '🍄', hp: 32, atk: 7,  spd: 9,  ab: 'ougen' },
  { id: 'tsururisu', name: 'ツルリス',     type: 'grass', emoji: '🐿️', hp: 26, atk: 9,  spd: 13, ab: 'mure' },
  { id: 'togebouzu', name: 'トゲボウズ',   type: 'grass', emoji: '🌵', hp: 34, atk: 8,  spd: 7,  ab: 'typeboost' },
  { id: 'birimushi', name: 'ビリムシ',     type: 'elec',  emoji: '🐛', hp: 24, atk: 10, spd: 13, ab: 'toushi' },
  { id: 'gorogoron', name: 'ゴロゴロン',   type: 'elec',  emoji: '🌩️', hp: 36, atk: 8,  spd: 6,  ab: 'kataki' },
  { id: 'chikudenchu',name: 'チクデンチュウ', type: 'elec', emoji: '🔋', hp: 30, atk: 8, spd: 9,  ab: 'oukyuu' },
  { id: 'inazumao',  name: 'イナズマオー', type: 'elec',  emoji: '⚡', hp: 28, atk: 10, spd: 11, ab: 'ace' },
  { id: 'pikahane',  name: 'ピカバネ',     type: 'elec',  emoji: '🪶', hp: 30, atk: 7,  spd: 10, ab: 'sokko' },
];
const SP_BY_ID = Object.fromEntries(SPECIES.map(s => [s.id, s]));

/* ══ バトルシミュレーション(決定論) ══
 * teamA/teamB: species idの配列(先頭から出撃)。返り値: {winner:0|1|null, log:[...], hpLeft:[%,%]} */
function makeFighter(spId, pos) {
  const sp = SP_BY_ID[spId];
  return {
    sp, pos,
    hp: sp.hp, maxHp: sp.hp,
    atkBonus: 0,        // かたきうち/とうし などの累積
    turns: 0,           // 自分が行動した回数(とうし用)
    attacked: false,    // そっこう用(最初の攻撃済みか)
    shielded: sp.ab === 'tate', // おおだて未消費か
    poisoned: false,
  };
}
function teamAtkAura(team) {
  // おうえん: 生きている応援持ち1体につき全員+2
  return team.filter(f => f.hp > 0 && f.sp.ab === 'ougen').length * 2;
}
function effAtk(f, team, oppActive) {
  let a = f.sp.atk + f.atkBonus + teamAtkAura(team);
  if (f.sp.ab === 'mure') a += 3 * team.filter(x => x !== f && x.sp.type === f.sp.type).length;
  if (f.sp.ab === 'senjin' && f.pos === 0) a += 4;
  if (f.sp.ab === 'ace' && team.filter(x => x.hp > 0).length === 1) a += 6;
  return a;
}
function effSpd(f, team) {
  let s = f.sp.spd;
  if (f.sp.ab === 'ace' && team.filter(x => x.hp > 0).length === 1) s += 4;
  return s;
}
function battle(teamAIds, teamBIds) {
  const teams = [teamAIds.map((id, i) => makeFighter(id, i)), teamBIds.map((id, i) => makeFighter(id, i))];
  const act = [0, 0]; // 出撃中のindex
  const log = [];
  const alive = side => teams[side].some(f => f.hp > 0);
  const active = side => teams[side][act[side]];
  log.push({ t: 'start', a: teamAIds, b: teamBIds });

  function onFaint(side) {
    const f = active(side);
    log.push({ t: 'faint', side, name: f.sp.name });
    // かたきうち: 残りの味方が強化
    teams[side].forEach(x => { if (x.hp > 0 && x.sp.ab === 'kataki') { x.atkBonus += 5; log.push({ t: 'ab', side, name: x.sp.name, ab: 'kataki' }); } });
    // 次のモンスターへ
    let nx = act[side] + 1;
    while (nx < TEAM_SIZE && teams[side][nx].hp <= 0) nx++;
    if (nx < TEAM_SIZE) {
      // おうきゅう: 倒れた子が持っていたら次の子を回復
      if (f.sp.ab === 'oukyuu') {
        teams[side][nx].hp = Math.min(teams[side][nx].maxHp, teams[side][nx].hp + 8);
        log.push({ t: 'ab', side, name: f.sp.name, ab: 'oukyuu' });
      }
      act[side] = nx;
      log.push({ t: 'enter', side, name: teams[side][nx].sp.name });
    }
  }
  function attack(atkSide) {
    const defSide = 1 - atkSide;
    const A = active(atkSide), D = active(defSide);
    if (A.hp <= 0 || D.hp <= 0) return;
    const mult = typeMult(A.sp.type, D.sp.type);
    let dmg = Math.round(effAtk(A, teams[atkSide], D) * mult);
    if (A.sp.ab === 'typeboost' && mult > 1) dmg += 4;
    if (A.sp.ab === 'sokko' && !A.attacked) dmg *= 2;
    A.attacked = true;
    if (D.shielded) { dmg = Math.ceil(dmg / 2); D.shielded = false; log.push({ t: 'ab', side: defSide, name: D.sp.name, ab: 'tate' }); }
    dmg = Math.max(1, dmg);
    D.hp -= dmg;
    if (A.sp.ab === 'doku' && !D.poisoned && D.hp > 0) { D.poisoned = true; log.push({ t: 'ab', side: atkSide, name: A.sp.name, ab: 'doku' }); }
    log.push({ t: 'hit', side: atkSide, name: A.sp.name, target: D.sp.name, dmg, mult, hp: Math.max(0, D.hp) });
    A.turns++;
    if (A.sp.ab === 'toushi') A.atkBonus = Math.min(6, A.atkBonus + 1);
    if (D.hp <= 0) onFaint(defSide);
  }
  let turn = 0;
  while (alive(0) && alive(1) && turn < MAX_TURNS) {
    turn++;
    log.push({ t: 'turn', n: turn });
    // すばやさ順に両者が攻撃(同速は現HPが高い方が先、同HPはA側)
    const s0 = effSpd(active(0), teams[0]), s1 = effSpd(active(1), teams[1]);
    let first = s0 > s1 ? 0 : s1 > s0 ? 1 : (active(0).hp >= active(1).hp ? 0 : 1);
    attack(first);
    if (alive(0) && alive(1)) attack(1 - first);
    // ターン終了処理: 毒 → さいせい
    for (const side of [0, 1]) {
      if (!alive(0) || !alive(1)) break;
      const f = active(side);
      if (f.hp > 0 && f.poisoned) {
        f.hp -= 3;
        log.push({ t: 'poison', side, name: f.sp.name, hp: Math.max(0, f.hp) });
        if (f.hp <= 0) { onFaint(side); continue; }
      }
      if (f.hp > 0 && f.sp.ab === 'saisei') {
        const heal = Math.min(4, f.maxHp - f.hp);
        if (heal > 0) { f.hp += heal; log.push({ t: 'heal', side, name: f.sp.name, hp: f.hp }); }
      }
    }
  }
  const hpLeft = teams.map(team =>
    team.reduce((s, f) => s + Math.max(0, f.hp), 0) / team.reduce((s, f) => s + f.maxHp, 0));
  let winner = null;
  if (alive(0) && !alive(1)) winner = 0;
  else if (alive(1) && !alive(0)) winner = 1;
  else if (turn >= MAX_TURNS) winner = hpLeft[0] > hpLeft[1] ? 0 : hpLeft[1] > hpLeft[0] ? 1 : null;
  log.push({ t: 'end', winner, hpLeft });
  return { winner, log, hpLeft };
}

/* ══ エンジン(オークション→編成→総当たり) ══ */
class MOEngine {
  constructor(playerCount, seed = Date.now()) {
    if (playerCount < 2 || playerCount > 4) throw new Error('2〜4人用です');
    this.n = playerCount;
    this.rng = mulberry32(seed & 0xffffffff);
    // 山: 全20種をシャッフルして初期2体×人数 + 競り15体(重複なしで足りない分は再シャッフル追加)
    let pool = SPECIES.map(s => s.id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const need = playerCount * 2 + AUCTION_LOTS;
    while (pool.length < need) {
      let extra = SPECIES.map(s => s.id);
      for (let i = extra.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [extra[i], extra[j]] = [extra[j], extra[i]]; }
      pool = pool.concat(extra);
    }
    this.owned = Array.from({ length: playerCount }, (_, p) => [pool[p * 2], pool[p * 2 + 1]]); // 公開
    this.lots = pool.slice(playerCount * 2, playerCount * 2 + AUCTION_LOTS);
    this.lotIdx = 0;
    this.coins = Array.from({ length: playerCount }, () => COINS);
    this.wonCount = Array.from({ length: playerCount }, () => 0);
    this.auctionLog = [];
    this.teams = Array.from({ length: playerCount }, () => null); // 編成(3体+順)
    this.results = [];  // 総当たり結果
    this.points = Array.from({ length: playerCount }, () => 0);
  }
  needMore(p) { return this.wonCount[p] < NEED_WINS; }
  get auctionDone() {
    return this.lotIdx >= this.lots.length || this.owned.every((_, p) => !this.needMore(p));
  }
  currentLot() { return this.auctionDone ? null : this.lots[this.lotIdx]; }
  /* 残りロット数が「全員の残り必要数」ちょうどなら、必要な人はパス不可(強制1入札) */
  get mustBid() {
    const remainingLots = this.lots.length - this.lotIdx;
    const needTotal = this.owned.reduce((s, _, p) => s + Math.max(0, NEED_WINS - this.wonCount[p]), 0);
    return remainingLots <= needTotal;
  }
  /* 全員の入札(0=パス)を受けて1ロットを解決 */
  resolveBids(bids) {
    if (this.auctionDone) throw new Error('オークションは終了しています');
    const lot = this.currentLot();
    const eff = bids.map((b, p) => {
      let v = Math.max(0, Math.min(Math.floor(Number(b) || 0), this.coins[p]));
      if (!this.needMore(p)) v = 0;                      // 3体そろった人は参加不可
      if (v === 0 && this.needMore(p) && this.mustBid) v = Math.min(1, this.coins[p]); // 強制入札
      return v;
    });
    let winner = null, price = 0;
    const top = Math.max(...eff);
    if (top > 0) {
      // 同額は「落札数が少ない→コインが多い→席順が早い」順で解決
      const cands = eff.map((v, p) => ({ v, p })).filter(x => x.v === top)
        .sort((a, b) => (this.wonCount[a.p] - this.wonCount[b.p]) || (this.coins[b.p] - this.coins[a.p]) || (a.p - b.p));
      winner = cands[0].p;
      price = top;
      this.coins[winner] -= price;
      this.owned[winner].push(lot);
      this.wonCount[winner]++;
    }
    const rec = { lotIdx: this.lotIdx, lot, bids: eff, winner, price, coins: this.coins.slice() };
    this.auctionLog.push(rec);
    this.lotIdx++;
    return rec;
  }
  /* 編成: 手持ちから3体(並び順=出撃順) */
  setTeam(p, ids) {
    if (!Array.isArray(ids) || ids.length !== TEAM_SIZE) throw new Error('3体えらんでください');
    const pool = this.owned[p].slice();
    for (const id of ids) {
      const i = pool.indexOf(id);
      if (i < 0) throw new Error('もっていないモンスターです');
      pool.splice(i, 1);
    }
    this.teams[p] = ids.slice();
  }
  get allTeamsSet() { return this.teams.every(t => t !== null); }
  /* 総当たり戦を実行 */
  runBattles() {
    this.results = [];
    for (let a = 0; a < this.n; a++) {
      for (let b = a + 1; b < this.n; b++) {
        const r = battle(this.teams[a], this.teams[b]);
        if (r.winner === 0) this.points[a] += 3;
        else if (r.winner === 1) this.points[b] += 3;
        else { this.points[a]++; this.points[b]++; }
        this.results.push({ a, b, winner: r.winner, hpLeft: r.hpLeft, log: r.log });
      }
    }
    return this.results;
  }
  /* 最終順位: 勝ち点 → 残りコイン → 席順 */
  standings() {
    const arr = Array.from({ length: this.n }, (_, p) => ({ p, points: this.points[p], coins: this.coins[p] }));
    arr.sort((x, y) => (y.points - x.points) || (y.coins - x.coins) || (x.p - y.p));
    const top = arr[0];
    const winners = arr.filter(x => x.points === top.points && x.coins === top.coins).map(x => x.p);
    return { order: arr, winners };
  }
}

/* ══ CPUブレイン ══ */
class MOBrain {
  constructor(rng) { this.rng = rng || Math.random; }
  /* モンスターの自チームとのシナジー評価 */
  value(spId, ownedIds) {
    const sp = SP_BY_ID[spId];
    let v = sp.hp / 4 + sp.atk * 1.6 + sp.spd * 0.6;
    const sameType = ownedIds.filter(id => SP_BY_ID[id].type === sp.type).length;
    if (sp.ab === 'mure') v += sameType * 3;
    if (ownedIds.some(id => SP_BY_ID[id].ab === 'mure' && SP_BY_ID[id].type === sp.type)) v += 3;
    if (sp.ab === 'ougen' || sp.ab === 'kataki') v += 3;
    if (sp.ab === 'ace' || sp.ab === 'sokko') v += 2;
    return v;
  }
  bid(E, p) {
    const lot = E.currentLot();
    if (!lot || !E.needMore(p)) return 0;
    const remainingNeeds = NEED_WINS - E.wonCount[p];
    const remainingLots = E.lots.length - E.lotIdx;
    const budgetPerNeed = E.coins[p] / Math.max(1, remainingNeeds);
    const v = this.value(lot, E.owned[p]);
    // 価値が高いほど予算を厚く。ロットが尽きそうなら強気に
    let bid = Math.round(budgetPerNeed * (v / 28) * (0.7 + this.rng() * 0.6));
    if (remainingLots <= remainingNeeds + 1) bid = Math.max(bid, Math.ceil(budgetPerNeed * 0.8));
    if (v < 20 && remainingLots > remainingNeeds + 3 && this.rng() < 0.5) bid = 0; // 微妙なら見送り
    return Math.max(0, Math.min(bid, E.coins[p]));
  }
  /* 編成: 5体から3体、貪欲にシナジー最大の組み合わせ+並び(せんじん先頭など) */
  pickTeam(E, p) {
    const ids = E.owned[p];
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < ids.length; i++)
      for (let j = 0; j < ids.length; j++)
        for (let k = 0; k < ids.length; k++) {
          if (i === j || j === k || i === k) continue;
          const team = [ids[i], ids[j], ids[k]];
          let score = 0;
          for (const id of team) score += this.value(id, team.filter(x => x !== id));
          if (SP_BY_ID[team[0]].ab === 'senjin') score += 4;
          if (SP_BY_ID[team[0]].ab === 'tate') score += 2;
          if (SP_BY_ID[team[2]].ab === 'ace') score += 3;
          if (SP_BY_ID[team[2]].ab === 'kataki') score += 3;
          score += this.rng() * 2;
          if (score > bestScore) { bestScore = score; best = team; }
        }
    return best;
  }
}

module.exports = {
  mulberry32, COINS, AUCTION_LOTS, NEED_WINS, TEAM_SIZE, MAX_TURNS,
  TYPES, TYPE_META, ABILITIES, SPECIES, SP_BY_ID,
  typeMult, battle, MOEngine, MOBrain,
};
