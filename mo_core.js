/* モンオク! コアロジック v2
 *  - オークション(所持上限なし・最低3体は保証) → 個人ショップ(アイテム7種) → 手動トーナメント
 *  - 初期2体は非公開。落札したモンスターは公開
 *  - レア度: SR(強い) / R(ふつう) / N(弱いがコンボパーツ)
 *  - トーナメントは毎試合、全所持モンスターから3体+出撃順を選び直せる
 *  - タイプ相性: 火>草>雷>水>火(有利1.5倍 / 不利0.75倍) */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COINS = 60;
const AUCTION_LOTS = 15;
const MIN_OWNED = 3;       // 最低これだけは持っていないと戦えない(強制入札で保証)
const TEAM_SIZE = 3;
const MAX_TURNS = 60;

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

const ABILITIES = {
  mure:      { name: 'むれ',       text: '出撃した同タイプの味方1体につき自分の攻撃+3' },
  ougen:     { name: 'おうえん',   text: '生きている間、チーム全員の攻撃+2' },
  engun:     { name: 'えんぐん',   text: '生きている間、同タイプの味方(自分以外)の攻撃+3' },
  gisei:     { name: 'ぎせい',     text: '自分が倒れたとき、次に出る味方の攻撃+4' },
  senjin:    { name: 'せんじん',   text: '先頭で出撃すると攻撃+4' },
  kataki:    { name: 'かたきうち', text: '味方が倒れるたび自分の攻撃+5' },
  tate:      { name: 'おおだて',   text: '登場後、最初に受けるダメージを半分にする' },
  doku:      { name: 'どくばり',   text: '攻撃した相手を毒にする(毎ターン3ダメージ)' },
  saisei:    { name: 'さいせい',   text: '毎ターン終了時にHP+4' },
  toushi:    { name: 'とうし',     text: '行動するたび攻撃+1(最大+6)' },
  sokko:     { name: 'そっこう',   text: '登場して最初の攻撃はダメージ2倍' },
  ace:       { name: 'エース',     text: '自分が最後の1体だと攻撃+6・すばやさ+4' },
  typeboost: { name: 'ぞくせい',   text: 'タイプ相性で有利なとき、さらにダメージ+4' },
  oukyuu:    { name: 'おうきゅう', text: '自分が倒れたとき、次に出る味方のHP+8' },
};

/* ══ 図鑑24種(SR6/R8/N10)。Nは弱いがコンボの起点になる ══ */
const SPECIES = [
  // ─ SR: 強い。エースとして立てる ─
  { id: 'kazanoh',    name: 'カザンオー',   type: 'fire',  emoji: '🌋', rare: 'SR', hp: 44, atk: 11, spd: 7,  ab: 'kataki' },
  { id: 'hinokagura', name: 'ヒノカグラ',   type: 'fire',  emoji: '🎏', rare: 'SR', hp: 34, atk: 12, spd: 11, ab: 'typeboost' },
  { id: 'umiryu',     name: 'ウミリュウ',   type: 'water', emoji: '🐉', rare: 'SR', hp: 40, atk: 10, spd: 10, ab: 'toushi' },
  { id: 'shinjuhime', name: 'シンジュヒメ', type: 'water', emoji: '🦪', rare: 'SR', hp: 38, atk: 9,  spd: 9,  ab: 'ougen' },
  { id: 'morinonushi',name: 'モリノヌシ',   type: 'grass', emoji: '🌲', rare: 'SR', hp: 46, atk: 9,  spd: 6,  ab: 'saisei' },
  { id: 'raijinoh',   name: 'ライジンオー', type: 'elec',  emoji: '🌩️', rare: 'SR', hp: 36, atk: 12, spd: 12, ab: 'ace' },
  // ─ R: ふつう ─
  { id: 'meraboo',    name: 'メラボー',     type: 'fire',  emoji: '🔥', rare: 'R', hp: 30, atk: 10, spd: 9,  ab: 'sokko' },
  { id: 'hidaneko',   name: 'ヒダネコ',     type: 'fire',  emoji: '😼', rare: 'R', hp: 26, atk: 9,  spd: 13, ab: 'senjin' },
  { id: 'namiuo',     name: 'ナミウオ',     type: 'water', emoji: '🐟', rare: 'R', hp: 28, atk: 9,  spd: 11, ab: 'toushi' },
  { id: 'shiomaneki', name: 'シオマネキング', type: 'water', emoji: '🦀', rare: 'R', hp: 34, atk: 9, spd: 6,  ab: 'mure' },
  { id: 'happanin',   name: 'ハッパニン',   type: 'grass', emoji: '🍃', rare: 'R', hp: 28, atk: 9,  spd: 12, ab: 'doku' },
  { id: 'tsururisu',  name: 'ツルリス',     type: 'grass', emoji: '🐿️', rare: 'R', hp: 26, atk: 9,  spd: 13, ab: 'mure' },
  { id: 'inazumao',   name: 'イナズマオー', type: 'elec',  emoji: '⚡', rare: 'R', hp: 28, atk: 10, spd: 11, ab: 'typeboost' },
  { id: 'gorogoron',  name: 'ゴロゴロン',   type: 'elec',  emoji: '☁️', rare: 'R', hp: 36, atk: 8,  spd: 6,  ab: 'kataki' },
  // ─ N: 弱い。でもコンボパーツ(えんぐん/ぎせい/おうきゅう/おおだて…) ─
  { id: 'taimatsun',  name: 'タイマッツン', type: 'fire',  emoji: '🕯️', rare: 'N', hp: 26, atk: 6, spd: 8,  ab: 'engun' },
  { id: 'hidamari',   name: 'ヒダマリ',     type: 'fire',  emoji: '🐣', rare: 'N', hp: 24, atk: 6, spd: 9,  ab: 'gisei' },
  { id: 'awagame',    name: 'アワガメ',     type: 'water', emoji: '🐢', rare: 'N', hp: 34, atk: 5, spd: 4,  ab: 'tate' },
  { id: 'yukidaruman',name: 'ユキダルマン', type: 'water', emoji: '☃️', rare: 'N', hp: 28, atk: 6, spd: 7,  ab: 'oukyuu' },
  { id: 'kinokoro',   name: 'キノコロ',     type: 'grass', emoji: '🍄', rare: 'N', hp: 26, atk: 6, spd: 9,  ab: 'ougen' },
  { id: 'morigon',    name: 'モリゴン',     type: 'grass', emoji: '🌳', rare: 'N', hp: 32, atk: 6, spd: 6,  ab: 'gisei' },
  { id: 'togebouzu',  name: 'トゲボウズ',   type: 'grass', emoji: '🌵', rare: 'N', hp: 26, atk: 6, spd: 8,  ab: 'doku' },
  { id: 'birimushi',  name: 'ビリムシ',     type: 'elec',  emoji: '🐛', rare: 'N', hp: 22, atk: 7, spd: 13, ab: 'engun' },
  { id: 'chikudenchu',name: 'チクデンチュウ', type: 'elec', emoji: '🔋', rare: 'N', hp: 26, atk: 6, spd: 9, ab: 'gisei' },
  { id: 'pikahane',   name: 'ピカバネ',     type: 'elec',  emoji: '🪶', rare: 'N', hp: 24, atk: 6, spd: 12, ab: 'sokko' },
];
const SP_BY_ID = Object.fromEntries(SPECIES.map(s => [s.id, s]));

/* ══ アイテム7種(個人ショップで購入。強いほど高い。各1個まで) ══ */
const ITEMS = [
  { id: 'yakusou',  name: 'やくそう',           price: 4,  emoji: '🌿', text: '毎試合、先頭のHP+6' },
  { id: 'omamori',  name: 'かいがらのおまもり', price: 6,  emoji: '🐚', text: '毎試合、先頭が最初に受けるダメージ−3' },
  { id: 'spice',    name: 'スピードスパイス',   price: 9,  emoji: '🌶️', text: '毎試合、先頭のすばやさ+3' },
  { id: 'wrist',    name: 'パワーリスト',       price: 12, emoji: '💪', text: '毎試合、先頭の攻撃+2' },
  { id: 'booster',  name: 'タイプブースター',   price: 16, emoji: '🔮', text: '毎試合、相性有利のダメージさらに+3(全員)' },
  { id: 'megahon',  name: 'おうえんメガホン',   price: 20, emoji: '📣', text: '毎試合、チーム全員の攻撃+1' },
  { id: 'medal',    name: 'でんせつのメダル',   price: 28, emoji: '🏅', text: '毎試合、チーム全員の攻撃+2・HP+4' },
];
const ITEM_BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));

/* ══ バトル(決定論・アイテム対応) ══ */
function makeFighter(spId, pos, items) {
  const sp = SP_BY_ID[spId];
  let hp = sp.hp, atk = 0;
  if (items.includes('medal')) hp += 4;
  if (pos === 0 && items.includes('yakusou')) hp += 6;
  return {
    sp, pos,
    hp, maxHp: hp,
    atkBonus: atk,
    turns: 0, attacked: false,
    shielded: sp.ab === 'tate',
    itemShield: pos === 0 && items.includes('omamori'), // 先頭の初回被弾−3
    poisoned: false,
  };
}
function effAtk(f, team, items) {
  let a = f.sp.atk + f.atkBonus;
  a += team.filter(x => x.hp > 0 && x.sp.ab === 'ougen').length * 2;
  a += team.filter(x => x !== f && x.hp > 0 && x.sp.ab === 'engun' && x.sp.type === f.sp.type).length * 3;
  if (f.sp.ab === 'mure') a += 3 * team.filter(x => x !== f && x.sp.type === f.sp.type).length;
  if (f.sp.ab === 'senjin' && f.pos === 0) a += 4;
  if (f.sp.ab === 'ace' && team.filter(x => x.hp > 0).length === 1) a += 6;
  if (items.includes('megahon')) a += 1;
  if (items.includes('medal')) a += 2;
  if (f.pos === 0 && items.includes('wrist')) a += 2;
  return a;
}
function effSpd(f, team, items) {
  let s = f.sp.spd;
  if (f.sp.ab === 'ace' && team.filter(x => x.hp > 0).length === 1) s += 4;
  if (f.pos === 0 && items.includes('spice')) s += 3;
  return s;
}
function battle(teamAIds, teamBIds, itemsA = [], itemsB = []) {
  const items = [itemsA, itemsB];
  const teams = [
    teamAIds.map((id, i) => makeFighter(id, i, itemsA)),
    teamBIds.map((id, i) => makeFighter(id, i, itemsB)),
  ];
  const act = [0, 0];
  const log = [{ t: 'start', a: teamAIds, b: teamBIds, items: [itemsA, itemsB] }];
  const alive = side => teams[side].some(f => f.hp > 0);
  const active = side => teams[side][act[side]];

  function onFaint(side) {
    const f = active(side);
    log.push({ t: 'faint', side, name: f.sp.name });
    teams[side].forEach(x => { if (x.hp > 0 && x.sp.ab === 'kataki') { x.atkBonus += 5; log.push({ t: 'ab', side, name: x.sp.name, ab: 'kataki' }); } });
    let nx = act[side] + 1;
    while (nx < TEAM_SIZE && teams[side][nx].hp <= 0) nx++;
    if (nx < TEAM_SIZE) {
      if (f.sp.ab === 'oukyuu') {
        teams[side][nx].hp = Math.min(teams[side][nx].maxHp, teams[side][nx].hp + 8);
        log.push({ t: 'ab', side, name: f.sp.name, ab: 'oukyuu' });
      }
      if (f.sp.ab === 'gisei') {
        teams[side][nx].atkBonus += 4;
        log.push({ t: 'ab', side, name: f.sp.name, ab: 'gisei' });
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
    let dmg = Math.round(effAtk(A, teams[atkSide], items[atkSide]) * mult);
    if (mult > 1) {
      if (A.sp.ab === 'typeboost') dmg += 4;
      if (items[atkSide].includes('booster')) dmg += 3;
    }
    if (A.sp.ab === 'sokko' && !A.attacked) dmg *= 2;
    A.attacked = true;
    if (D.shielded) { dmg = Math.ceil(dmg / 2); D.shielded = false; log.push({ t: 'ab', side: defSide, name: D.sp.name, ab: 'tate' }); }
    if (D.itemShield) { dmg = Math.max(1, dmg - 3); D.itemShield = false; log.push({ t: 'item', side: defSide, name: D.sp.name, item: 'omamori' }); }
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
    const s0 = effSpd(active(0), teams[0], itemsA), s1 = effSpd(active(1), teams[1], itemsB);
    const first = s0 > s1 ? 0 : s1 > s0 ? 1 : (active(0).hp >= active(1).hp ? 0 : 1);
    attack(first);
    if (alive(0) && alive(1)) attack(1 - first);
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
  else if (turn >= MAX_TURNS) winner = hpLeft[0] > hpLeft[1] ? 0 : hpLeft[1] > hpLeft[0] ? 1 : 0; // 完全同値はA(先攻表記側)
  log.push({ t: 'end', winner, hpLeft });
  return { winner, log, hpLeft };
}

/* ══ 対話型バトル(トーナメント本番用) ══
 * 毎ターン両者が同時に行動を選ぶ:
 *  - {t:'attack'}            … 出撃中のモンスターで攻撃
 *  - {t:'switch', to:idx}    … ベンチの生存モンスターと交代(交代したターンは攻撃できない)
 *  - {t:'send', to:idx}      … 倒れたあとの送り出し(replaceフェーズ)
 * 交代が先に解決 → すばやさ順に攻撃 → ターン終了処理(毒/さいせい)。
 * 倒れたら持ち主が次を選ぶ(残り1体なら自動)。 */
const BT_MAX_TURNS = 40;
class BattleState {
  constructor(teamAIds, teamBIds, itemsA = [], itemsB = []) {
    this.items = [itemsA, itemsB];
    this.teams = [
      teamAIds.map((id, i) => makeFighter(id, i, itemsA)),
      teamBIds.map((id, i) => makeFighter(id, i, itemsB)),
    ];
    this.act = [0, 0];
    this.phase = 'choice';            // choice | replace | done
    this.waitingReplace = [false, false];
    this.pendingEnter = [{ hp: 0, atk: 0 }, { hp: 0, atk: 0 }]; // おうきゅう/ぎせい の持ち越し
    this.turn = 0;
    this.winner = null;
    this.log = [{ t: 'start', a: teamAIds, b: teamBIds, items: [itemsA, itemsB] }];
  }
  active(side) { return this.teams[side][this.act[side]]; }
  aliveIdx(side) { return this.teams[side].map((f, i) => f.hp > 0 ? i : -1).filter(i => i >= 0); }
  aliveCount(side) { return this.aliveIdx(side).length; }
  benchIdx(side) { return this.aliveIdx(side).filter(i => i !== this.act[side]); }
  get finished() { return this.phase === 'done'; }
  hpLeft() {
    return this.teams.map(team =>
      team.reduce((s, f) => s + Math.max(0, f.hp), 0) / team.reduce((s, f) => s + f.maxHp, 0));
  }
  /* いま side に求められている行動 */
  needsAction(side) {
    if (this.phase === 'choice') return true;
    if (this.phase === 'replace') return this.waitingReplace[side];
    return false;
  }
  legalActions(side) {
    if (this.phase === 'replace' && this.waitingReplace[side])
      return { send: this.aliveIdx(side) };
    if (this.phase === 'choice')
      return { attack: true, switch: this.benchIdx(side) };
    return {};
  }
  validate(side, action) {
    const legal = this.legalActions(side);
    if (action && action.t === 'attack' && legal.attack) return true;
    if (action && action.t === 'switch' && legal.switch && legal.switch.includes(Number(action.to))) return true;
    if (action && action.t === 'send' && legal.send && legal.send.includes(Number(action.to))) return true;
    return false;
  }
  _enter(side, idx, ev) {
    this.act[side] = idx;
    const f = this.teams[side][idx];
    const pend = this.pendingEnter[side];
    if (pend.hp > 0) { f.hp = Math.min(f.maxHp, f.hp + pend.hp); }
    if (pend.atk > 0) { f.atkBonus += pend.atk; }
    this.pendingEnter[side] = { hp: 0, atk: 0 };
    ev.push({ t: 'enter', side, name: f.sp.name });
  }
  _onFaint(side, ev) {
    const f = this.active(side);
    ev.push({ t: 'faint', side, name: f.sp.name });
    this.teams[side].forEach(x => { if (x.hp > 0 && x.sp.ab === 'kataki') { x.atkBonus += 5; ev.push({ t: 'ab', side, name: x.sp.name, ab: 'kataki' }); } });
    if (f.sp.ab === 'oukyuu') { this.pendingEnter[side].hp += 8; ev.push({ t: 'ab', side, name: f.sp.name, ab: 'oukyuu' }); }
    if (f.sp.ab === 'gisei') { this.pendingEnter[side].atk += 4; ev.push({ t: 'ab', side, name: f.sp.name, ab: 'gisei' }); }
    const alive = this.aliveIdx(side);
    if (alive.length === 0) {
      this.winner = 1 - side;
      this.phase = 'done';
      ev.push({ t: 'end', winner: this.winner, hpLeft: this.hpLeft() });
    } else if (alive.length === 1) {
      this._enter(side, alive[0], ev); // 残り1体は自動で出す
    } else {
      this.waitingReplace[side] = true; // 持ち主が選ぶ
    }
  }
  _attack(atkSide, ev) {
    const defSide = 1 - atkSide;
    const A = this.active(atkSide), D = this.active(defSide);
    if (A.hp <= 0 || D.hp <= 0 || this.phase === 'done') return;
    const mult = typeMult(A.sp.type, D.sp.type);
    let dmg = Math.round(effAtk(A, this.teams[atkSide], this.items[atkSide]) * mult);
    if (mult > 1) {
      if (A.sp.ab === 'typeboost') dmg += 4;
      if (this.items[atkSide].includes('booster')) dmg += 3;
    }
    if (A.sp.ab === 'sokko' && !A.attacked) dmg *= 2;
    A.attacked = true;
    if (D.shielded) { dmg = Math.ceil(dmg / 2); D.shielded = false; ev.push({ t: 'ab', side: defSide, name: D.sp.name, ab: 'tate' }); }
    if (D.itemShield) { dmg = Math.max(1, dmg - 3); D.itemShield = false; ev.push({ t: 'item', side: defSide, name: D.sp.name, item: 'omamori' }); }
    dmg = Math.max(1, dmg);
    D.hp -= dmg;
    if (A.sp.ab === 'doku' && !D.poisoned && D.hp > 0) { D.poisoned = true; ev.push({ t: 'ab', side: atkSide, name: A.sp.name, ab: 'doku' }); }
    ev.push({ t: 'hit', side: atkSide, name: A.sp.name, target: D.sp.name, dmg, mult, hp: Math.max(0, D.hp) });
    A.turns++;
    if (A.sp.ab === 'toushi') A.atkBonus = Math.min(6, A.atkBonus + 1);
    if (D.hp <= 0) this._onFaint(defSide, ev);
  }
  /* 両者の行動を受けて1ターン進める(choiceフェーズ) */
  stepChoice(actionA, actionB) {
    if (this.phase !== 'choice') throw new Error('行動フェーズではありません');
    const acts = [actionA, actionB];
    for (const side of [0, 1]) if (!this.validate(side, acts[side])) acts[side] = { t: 'attack' }; // 不正は攻撃扱い
    this.turn++;
    const ev = [{ t: 'turn', n: this.turn }];
    const switched = [false, false];
    for (const side of [0, 1]) {
      if (acts[side].t === 'switch') {
        switched[side] = true;
        ev.push({ t: 'switch', side, from: this.active(side).sp.name });
        this._enter(side, Number(acts[side].to), ev);
      }
    }
    // 攻撃(交代した側は攻撃しない)。すばやさ順、同速は現HP多い方
    const attackers = [0, 1].filter(s => !switched[s] && acts[s].t === 'attack');
    attackers.sort((x, y) => {
      const sx = effSpd(this.active(x), this.teams[x], this.items[x]);
      const sy = effSpd(this.active(y), this.teams[y], this.items[y]);
      return (sy - sx) || (this.active(y).hp - this.active(x).hp) || (x - y);
    });
    for (const s of attackers) {
      if (this.phase === 'done') break;
      if (this.waitingReplace[0] || this.waitingReplace[1]) break; // 送り出し待ちなら攻撃は流れる
      this._attack(s, ev);
    }
    // ターン終了処理(送り出し待ち・決着済みならスキップ)
    if (this.phase !== 'done' && !this.waitingReplace[0] && !this.waitingReplace[1]) {
      for (const side of [0, 1]) {
        if (this.phase === 'done') break;
        const f = this.active(side);
        if (f.hp > 0 && f.poisoned) {
          f.hp -= 3;
          ev.push({ t: 'poison', side, name: f.sp.name, hp: Math.max(0, f.hp) });
          if (f.hp <= 0) { this._onFaint(side, ev); continue; }
        }
        if (this.phase !== 'done' && f.hp > 0 && f.sp.ab === 'saisei') {
          const heal = Math.min(4, f.maxHp - f.hp);
          if (heal > 0) { f.hp += heal; ev.push({ t: 'heal', side, name: f.sp.name, hp: f.hp }); }
        }
      }
    }
    // ターン上限
    if (this.phase !== 'done' && this.turn >= BT_MAX_TURNS) {
      const hl = this.hpLeft();
      this.winner = hl[0] >= hl[1] ? 0 : 1;
      this.phase = 'done';
      ev.push({ t: 'end', winner: this.winner, hpLeft: hl, timeup: true });
    }
    if (this.phase !== 'done') this.phase = (this.waitingReplace[0] || this.waitingReplace[1]) ? 'replace' : 'choice';
    this.log.push(...ev);
    return ev;
  }
  /* 送り出し(replaceフェーズ)。sends: {side: action} 相当の配列(null可) */
  stepReplace(sendA, sendB) {
    if (this.phase !== 'replace') throw new Error('送り出しフェーズではありません');
    const ev = [];
    const sends = [sendA, sendB];
    for (const side of [0, 1]) {
      if (!this.waitingReplace[side]) continue;
      let a = sends[side];
      if (!this.validate(side, a)) a = { t: 'send', to: this.aliveIdx(side)[0] }; // 不正/未提出は先頭
      this.waitingReplace[side] = false;
      this._enter(side, Number(a.to), ev);
    }
    this.phase = 'choice';
    this.log.push(...ev);
    return ev;
  }
  /* クライアント配信用スナップショット(両チーム公開: バトルで見えるのは自然) */
  snapshot() {
    return {
      phase: this.phase,
      turn: this.turn,
      act: this.act.slice(),
      waitingReplace: this.waitingReplace.slice(),
      winner: this.winner,
      teams: this.teams.map(team => team.map(f => ({
        id: f.sp.id, hp: Math.max(0, f.hp), maxHp: f.maxHp,
        poisoned: f.poisoned, atkBonus: f.atkBonus,
      }))),
      items: this.items,
    };
  }
}

/* ══ エンジン ══ */
class MOEngine {
  constructor(playerCount, seed = Date.now()) {
    if (playerCount < 2 || playerCount > 4) throw new Error('2〜4人用です');
    this.n = playerCount;
    this.rng = mulberry32(seed & 0xffffffff);
    let pool = SPECIES.map(s => s.id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const need = playerCount * 2 + AUCTION_LOTS;
    while (pool.length < need) {
      let extra = SPECIES.map(s => s.id);
      for (let i = extra.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [extra[i], extra[j]] = [extra[j], extra[i]]; }
      pool = pool.concat(extra);
    }
    this.starters = Array.from({ length: playerCount }, (_, p) => [pool[p * 2], pool[p * 2 + 1]]); // 非公開!
    this.wonMons = Array.from({ length: playerCount }, () => []);  // 落札分(公開)
    this.lots = pool.slice(playerCount * 2, playerCount * 2 + AUCTION_LOTS);
    this.lotIdx = 0;
    this.coins = Array.from({ length: playerCount }, () => COINS);
    this.items = Array.from({ length: playerCount }, () => []);
    this.auctionLog = [];
    // トーナメント
    this.matches = null;     // [{a,b,round,winner,result}]
    this.matchIdx = 0;
    this.places = Array.from({ length: playerCount }, () => null);
  }
  owned(p) { return this.starters[p].concat(this.wonMons[p]); }
  ownedCount(p) { return 2 + this.wonMons[p].length; }
  needMore(p) { return this.ownedCount(p) < MIN_OWNED; }
  get auctionDone() { return this.lotIdx >= this.lots.length; }
  currentLot() { return this.auctionDone ? null : this.lots[this.lotIdx]; }
  get mustBid() {
    const remainingLots = this.lots.length - this.lotIdx;
    const needTotal = Array.from({ length: this.n }, (_, p) => Math.max(0, MIN_OWNED - this.ownedCount(p))).reduce((a, b) => a + b, 0);
    return needTotal > 0 && remainingLots <= needTotal + 1;
  }
  resolveBids(bids) {
    if (this.auctionDone) throw new Error('オークションは終了しています');
    const lot = this.currentLot();
    const must = this.mustBid;
    const eff = bids.map((b, p) => {
      let v = Math.max(0, Math.min(Math.floor(Number(b) || 0), this.coins[p]));
      if (must && !this.needMore(p)) v = 0;                       // 足りない人を優先
      if (must && this.needMore(p) && v === 0) v = Math.min(1, this.coins[p]); // パス禁止
      return v;
    });
    let winner = null, price = 0;
    const top = Math.max(...eff);
    if (top > 0) {
      const cands = eff.map((v, p) => ({ v, p })).filter(x => x.v === top)
        .sort((a, b) => (this.ownedCount(a.p) - this.ownedCount(b.p)) || (this.coins[b.p] - this.coins[a.p]) || (a.p - b.p));
      winner = cands[0].p;
      price = top;
      this.coins[winner] -= price;
      this.wonMons[winner].push(lot);
    }
    const rec = { lotIdx: this.lotIdx, lot, bids: eff, winner, price, coins: this.coins.slice() };
    this.auctionLog.push(rec);
    this.lotIdx++;
    return rec;
  }
  /* ── ショップ(個人購入・各アイテム1個まで) ── */
  buyItem(p, itemId) {
    const it = ITEM_BY_ID[itemId];
    if (!it) throw new Error('そのアイテムはありません');
    if (this.items[p].includes(itemId)) throw new Error('もう持っています');
    if (this.coins[p] < it.price) throw new Error(`コインが足りません(${it.price}必要)`);
    this.coins[p] -= it.price;
    this.items[p].push(itemId);
    return it;
  }
  /* ── トーナメント ── */
  seedBracket() {
    const seats = Array.from({ length: this.n }, (_, p) => p);
    for (let i = seats.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [seats[i], seats[j]] = [seats[j], seats[i]]; }
    this.matches = [];
    if (this.n === 2) {
      this.matches.push({ round: '決勝', a: seats[0], b: seats[1], winner: null, result: null });
    } else if (this.n === 3) {
      this.matches.push({ round: '準決勝', a: seats[0], b: seats[1], winner: null, result: null });
      this.matches.push({ round: '決勝', a: null, b: seats[2], winner: null, result: null }); // aは準決勝の勝者
    } else {
      this.matches.push({ round: '準決勝1', a: seats[0], b: seats[1], winner: null, result: null });
      this.matches.push({ round: '準決勝2', a: seats[2], b: seats[3], winner: null, result: null });
      this.matches.push({ round: '決勝', a: null, b: null, winner: null, result: null });
    }
    this.matchIdx = 0;
  }
  currentMatch() {
    if (!this.matches || this.matchIdx >= this.matches.length) return null;
    return this.matches[this.matchIdx];
  }
  /* チーム(3体+順)の妥当性: 所持から重複なく */
  validateTeam(p, ids) {
    if (!Array.isArray(ids) || ids.length !== TEAM_SIZE) throw new Error('3体えらんでください');
    const pool = this.owned(p).slice();
    for (const id of ids) {
      const i = pool.indexOf(id);
      if (i < 0) throw new Error('もっていないモンスターです');
      pool.splice(i, 1);
    }
    return ids.slice();
  }
  /* 試合結果の確定(winnerSide: 0=m.a側の勝ち)。対話型バトルの終了時にサーバーが呼ぶ */
  reportMatch(winnerSide, meta = {}) {
    const m = this.currentMatch();
    if (!m) throw new Error('試合がありません');
    m.winner = winnerSide === 0 ? m.a : m.b;
    m.loser = winnerSide === 0 ? m.b : m.a;
    m.result = meta;
    if (m.round.startsWith('準決勝')) this.places[m.loser] = 3;
    if (m.round === '決勝') { this.places[m.loser] = 2; this.places[m.winner] = 1; }
    if (this.n === 3 && this.matchIdx === 0) this.matches[1].a = m.winner;
    if (this.n === 4) {
      if (this.matchIdx === 0) this.matches[2].a = m.winner;
      if (this.matchIdx === 1) this.matches[2].b = m.winner;
    }
    this.matchIdx++;
    return m;
  }
  /* 互換: 自動バトルで1試合進める(テスト・シミュレーション用) */
  playCurrentMatch(teamA, teamB) {
    const m = this.currentMatch();
    if (!m) throw new Error('試合がありません');
    const r = battle(teamA, teamB, this.items[m.a], this.items[m.b]);
    const rec = this.reportMatch(r.winner, { hpLeft: r.hpLeft, log: r.log, teams: [teamA, teamB] });
    return rec;
  }
  get tournamentDone() { return this.matches && this.matchIdx >= this.matches.length; }
  /* 最終順位: 優勝1位 → 準優勝2位 → 準決敗退3位(同順はコイン多い順で表示) */
  standings() {
    const arr = Array.from({ length: this.n }, (_, p) => ({ p, place: this.places[p] ?? 9, coins: this.coins[p], items: this.items[p] }));
    arr.sort((x, y) => (x.place - y.place) || (y.coins - x.coins) || (x.p - y.p));
    return { order: arr, winners: arr.filter(x => x.place === 1).map(x => x.p) };
  }
}

/* ══ CPUブレイン ══ */
class MOBrain {
  constructor(rng) { this.rng = rng || Math.random; }
  value(spId, ownedIds) {
    const sp = SP_BY_ID[spId];
    let v = sp.hp / 4 + sp.atk * 1.6 + sp.spd * 0.6;
    if (sp.rare === 'SR') v += 5;
    const sameType = ownedIds.filter(id => SP_BY_ID[id].type === sp.type).length;
    if (sp.ab === 'mure' || sp.ab === 'engun') v += sameType * 2.5;
    if (ownedIds.some(id => (SP_BY_ID[id].ab === 'mure' || SP_BY_ID[id].ab === 'engun') && SP_BY_ID[id].type === sp.type)) v += 3;
    if (sp.ab === 'ougen' || sp.ab === 'kataki') v += 3;
    if (sp.ab === 'ace' || sp.ab === 'sokko') v += 2;
    return v;
  }
  bid(E, p) {
    const lot = E.currentLot();
    if (!lot) return 0;
    const v = this.value(lot, E.owned(p));
    const wantMore = E.ownedCount(p) < 5 + Math.floor(this.rng() * 2); // 5〜6体を目安に集める
    if (E.needMore(p)) {
      const remainingLots = E.lots.length - E.lotIdx;
      let bid2 = Math.round((E.coins[p] / Math.max(1, remainingLots > 5 ? 4 : 2)) * (0.6 + this.rng() * 0.8));
      if (E.mustBid) bid2 = Math.max(1, bid2);
      return Math.max(1, Math.min(bid2, E.coins[p]));
    }
    if (!wantMore) return 0;
    let bid = Math.round((v - 18) * (1.1 + this.rng()));
    if (v < 20 && this.rng() < 0.6) bid = 0;
    // アイテム用に少し残す
    bid = Math.min(bid, Math.max(0, E.coins[p] - 8));
    return Math.max(0, bid);
  }
  shop(E, p) {
    // 高い順に買えるものを1〜2個(コインを少し残す判断もある)
    const bought = [];
    const sorted = ITEMS.slice().sort((a, b) => b.price - a.price);
    for (const it of sorted) {
      if (bought.length >= 2) break;
      if (E.items[p].includes(it.id)) continue;
      if (E.coins[p] >= it.price && this.rng() < 0.8) {
        try { E.buyItem(p, it.id); bought.push(it.id); } catch (e) {}
      }
    }
    return bought;
  }
  /* 対話型バトルの行動選択 */
  act(bs, side) {
    const rng = this.rng;
    const me = bs.active(side), op = bs.active(1 - side);
    const mult = typeMult(me.sp.type, op.sp.type);
    const bench = bs.benchIdx(side);
    // 相性不利で、ベンチに有利なやつがいれば交代を検討
    if (mult < 1 && bench.length && rng() < 0.65) {
      const better = bench.filter(i => typeMult(bs.teams[side][i].sp.type, op.sp.type) > 1);
      if (better.length) return { t: 'switch', to: better[0] };
      const neutral = bench.filter(i => typeMult(bs.teams[side][i].sp.type, op.sp.type) === 1);
      if (neutral.length && rng() < 0.4) return { t: 'switch', to: neutral[0] };
    }
    // 瀕死で粘っても無駄なら交代(たまに)
    if (me.hp <= 6 && bench.length && rng() < 0.3) return { t: 'switch', to: bench[0] };
    return { t: 'attack' };
  }
  send(bs, side) {
    const op = bs.active(1 - side);
    const alive = bs.aliveIdx(side);
    let best = alive[0], bestScore = -Infinity;
    for (const i of alive) {
      const f = bs.teams[side][i];
      const score = typeMult(f.sp.type, op.sp.type) * 10 + f.sp.atk + f.hp / 10 + this.rng();
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return { t: 'send', to: best };
  }
  pickTeam(E, p) {
    const ids = E.owned(p);
    let best = null, bestScore = -Infinity;
    const idxs = ids.map((_, i) => i);
    for (const i of idxs) for (const j of idxs) for (const k of idxs) {
      if (i === j || j === k || i === k) continue;
      const team = [ids[i], ids[j], ids[k]];
      let score = 0;
      for (const id of team) score += this.value(id, team.filter(x => x !== id));
      if (SP_BY_ID[team[0]].ab === 'senjin') score += 4;
      if (SP_BY_ID[team[0]].ab === 'tate') score += 2;
      if (SP_BY_ID[team[2]].ab === 'ace') score += 3;
      if (SP_BY_ID[team[2]].ab === 'kataki') score += 3;
      if (SP_BY_ID[team[0]].ab === 'engun' || SP_BY_ID[team[0]].ab === 'gisei') score -= 2; // 支援は後ろ寄りに
      score += this.rng() * 2;
      if (score > bestScore) { bestScore = score; best = team; }
    }
    return best;
  }
}

module.exports = {
  mulberry32, COINS, AUCTION_LOTS, MIN_OWNED, TEAM_SIZE, MAX_TURNS, BT_MAX_TURNS,
  TYPES, TYPE_META, ABILITIES, SPECIES, SP_BY_ID, ITEMS, ITEM_BY_ID,
  typeMult, battle, BattleState, MOEngine, MOBrain,
};
