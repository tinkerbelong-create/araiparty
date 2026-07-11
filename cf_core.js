/* カウントフルーツ コアロジック
 * 上から降ってくる4種のフルーツ(🍓🍒🍋🍌)を数え、落下後に公開される問題に答えるゲーム。
 * 作問者が「どの問題を出すか」「どのフルーツを何個降らせるか」を決めるのが核。
 * サーバー(cf_server.js)とテストから利用される。ブラウザには送らない。 */
'use strict';

/* ── 乱数(シード付き・再現可能) ── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRUITS = [
  { key: 'ichigo', emoji: '🍓', name: 'イチゴ', color: 'red' },
  { key: 'cherry', emoji: '🍒', name: 'チェリー', color: 'red' },
  { key: 'lemon',  emoji: '🍋', name: 'レモン',  color: 'yellow' },
  { key: 'banana', emoji: '🍌', name: 'バナナ',  color: 'yellow' },
];
const FKEYS = FRUITS.map(f => f.key);
const FBY = Object.fromEntries(FRUITS.map(f => [f.key, f]));
const fl = k => FBY[k].emoji + FBY[k].name; // 表示ラベル

/* ══ 問題テンプレート ══
 * 各問題 = { id, type, params, text, kind: 'input' | 'choice' }
 * 正解は counts({ichigo,cherry,lemon,banana}) から evalAnswer で計算する。 */
function buildTemplates() {
  const T = [];
  // 単体カウント(4)
  for (const k of FKEYS) T.push({ type: 'count', params: { f: k }, text: `${fl(k)}は 何個 落ちてきた?`, kind: 'input' });
  // 色カウント(2)
  T.push({ type: 'color', params: { c: 'red' },    text: '赤いフルーツ(🍓🍒)は 合わせて何個?', kind: 'input' });
  T.push({ type: 'color', params: { c: 'yellow' }, text: '黄色いフルーツ(🍋🍌)は 合わせて何個?', kind: 'input' });
  // 合計(1)
  T.push({ type: 'total', params: {}, text: 'フルーツは 全部で何個 落ちてきた?', kind: 'input' });
  // ペア合計(6)・ペア差(6)・比較(6)
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = FKEYS[i], b = FKEYS[j];
    T.push({ type: 'pairsum',  params: { a, b }, text: `${fl(a)}と${fl(b)}は 合わせて何個?`, kind: 'input' });
    T.push({ type: 'pairdiff', params: { a, b }, text: `${fl(a)}と${fl(b)}の 個数の差は?`, kind: 'input' });
    T.push({ type: 'compare',  params: { a, b }, text: `${fl(a)}と${fl(b)}、多く落ちたのは どっち?`, kind: 'choice' });
  }
  // 最多・最少(2)
  T.push({ type: 'most',  params: {}, text: '一番 多く落ちたフルーツは?', kind: 'choice' });
  T.push({ type: 'least', params: {}, text: '一番 少なく落ちたフルーツは?', kind: 'choice' });
  // 偶数奇数(5)
  T.push({ type: 'parity', params: { f: 'total' }, text: 'フルーツの合計は 偶数? 奇数?', kind: 'choice' });
  for (const k of FKEYS) T.push({ type: 'parity', params: { f: k }, text: `${fl(k)}の個数は 偶数? 奇数?`, kind: 'choice' });
  // 4択数値(3): 正解+ダミー3つから選ぶ
  T.push({ type: 'near', params: { f: 'total' },  text: 'フルーツの合計に 一番近いのは?', kind: 'choice' });
  T.push({ type: 'near', params: { f: 'red' },    text: '赤いフルーツ(🍓🍒)の合計に 一番近いのは?', kind: 'choice' });
  T.push({ type: 'near', params: { f: 'yellow' }, text: '黄色いフルーツ(🍋🍌)の合計に 一番近いのは?', kind: 'choice' });
  return T;
}
const TEMPLATES = buildTemplates();

/* ゲームごとに15問を抽選(公開リスト) */
function generateQuestions(rng, n = 15) {
  const pool = TEMPLATES.map((t, i) => ({ ...t, tid: i }));
  // 単体カウント・合計・色は面白いので優先的に混ぜ、残りはシャッフルから
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, n);
  return picked.map((q, i) => ({ id: i, tid: q.tid, type: q.type, params: q.params, text: q.text, kind: q.kind }));
}

/* ── 集計ヘルパ ── */
function groupValue(fOrGroup, counts) {
  if (fOrGroup === 'total') return FKEYS.reduce((s, k) => s + counts[k], 0);
  if (fOrGroup === 'red' || fOrGroup === 'yellow')
    return FRUITS.filter(f => f.color === fOrGroup).reduce((s, f) => s + counts[f.key], 0);
  return counts[fOrGroup];
}

/* ══ 正解計算 ══
 * input問題  → { kind:'input', correct: 数値 }
 * choice問題 → { kind:'choice', options: [文字列], correctSet: [正解indexの配列] }
 * choiceの選択肢生成に乱数が要るものは rng を使う(サーバーが回答フェーズ開始時に一度だけ呼び、保存する)。 */
function resolveQuestion(q, counts, rng) {
  const g = f => groupValue(f, counts);
  switch (q.type) {
    case 'count':    return { kind: 'input', correct: g(q.params.f) };
    case 'color':    return { kind: 'input', correct: g(q.params.c) };
    case 'total':    return { kind: 'input', correct: g('total') };
    case 'pairsum':  return { kind: 'input', correct: g(q.params.a) + g(q.params.b) };
    case 'pairdiff': return { kind: 'input', correct: Math.abs(g(q.params.a) - g(q.params.b)) };
    case 'compare': {
      const a = g(q.params.a), b = g(q.params.b);
      const options = [`${fl(q.params.a)}のほうが多い`, `${fl(q.params.b)}のほうが多い`, '同じ数'];
      const correctSet = [a > b ? 0 : a < b ? 1 : 2];
      return { kind: 'choice', options, correctSet };
    }
    case 'most': case 'least': {
      const vals = FKEYS.map(k => g(k));
      const target = q.type === 'most' ? Math.max(...vals) : Math.min(...vals);
      const options = FRUITS.map(f => fl(f.key));
      const correctSet = FKEYS.map((k, i) => (g(k) === target ? i : -1)).filter(i => i >= 0);
      return { kind: 'choice', options, correctSet };
    }
    case 'parity': {
      const v = g(q.params.f);
      return { kind: 'choice', options: ['偶数', '奇数'], correctSet: [v % 2] };
    }
    case 'near': {
      const v = g(q.params.f);
      // 正解 + 近いダミー3つ(重複なし・0以上)
      const set = new Set([v]);
      let guard = 0;
      while (set.size < 4 && guard++ < 200) {
        const d = 1 + Math.floor(rng() * Math.max(3, Math.round(v * 0.25) + 2));
        const cand = rng() < 0.5 ? v - d : v + d;
        if (cand >= 0) set.add(cand);
      }
      while (set.size < 4) set.add(v + set.size * 3 + 1); // 保険
      const options = [...set];
      for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
      return { kind: 'choice', options: options.map(String), correctSet: [options.indexOf(v)] };
    }
    default: throw new Error('unknown question type: ' + q.type);
  }
}

/* ══ 採点 ══
 * 選択式: 正解なら+10点 / ハズレはペナルティ −(20÷選択肢数) → 2択:−10, 3択:−7, 4択:−5
 * 入力式: ピッタリ+10点、ずれた分だけ−1(0未満にはならない)
 * answer: input→数値, choice→選択index。null/undefined は時間切れ(0点)。 */
function scoreAnswer(resolved, answer) {
  if (answer === null || answer === undefined) return { points: 0, exact: false };
  if (resolved.kind === 'choice') {
    const ok = resolved.correctSet.includes(Number(answer));
    if (ok) return { points: 10, exact: true };
    return { points: -Math.round(20 / resolved.options.length), exact: false };
  }
  const diff = Math.abs(Number(answer) - resolved.correct);
  if (!Number.isFinite(diff)) return { points: 0, exact: false };
  return { points: Math.max(0, 10 - diff), exact: diff === 0 };
}

/* ══ 落下シーケンス生成 ══
 * alloc({ichigo,..}) から [{f:'ichigo', t:ms, x:0..1, r:回転}] を作る。
 * 両プレイヤーに同じseqを配ることで同じ映像を見せる。 */
function buildDropSeq(alloc, rng) {
  const bag = [];
  for (const k of FKEYS) for (let i = 0; i < (alloc[k] || 0); i++) bag.push(k);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  const total = bag.length;
  // 個数が多いほど間隔を詰める(1個あたり 700ms → 最小180ms)
  const interval = Math.max(180, Math.min(700, Math.round(9000 / Math.max(1, total))));
  let t = 800; // 開始前の間
  const seq = bag.map(f => {
    const item = { f, t, x: 0.06 + rng() * 0.88, r: Math.floor(rng() * 360), fall: 2400 + Math.floor(rng() * 900) };
    t += Math.round(interval * (0.6 + rng() * 0.8));
    return item;
  });
  const duration = (seq.length ? seq[seq.length - 1].t + seq[seq.length - 1].fall : 0) + 900;
  return { seq, duration };
}

/* 偶数奇数の問題で対象フルーツが0個なら、一番多いフルーツから1個移す(合計は不変) */
function fixAllocForQuestion(q, alloc) {
  if (!q || q.type !== 'parity' || !q.params || !FKEYS.includes(q.params.f)) return alloc;
  const f = q.params.f;
  if ((alloc[f] || 0) >= 1) return alloc;
  const donor = FKEYS.filter(k => k !== f).sort((a, b) => (alloc[b] || 0) - (alloc[a] || 0))[0];
  if ((alloc[donor] || 0) > 0) { alloc[donor]--; alloc[f] = (alloc[f] || 0) + 1; }
  return alloc;
}

/* ══ CPUブレイン ══ */
class CFBrain {
  constructor(rng) { this.rng = rng || Math.random; }
  /* 15問から3問選ぶ: 入力式(差で部分点が出にくい難しめ)を好む */
  pickQuestions(questions) {
    const rng = this.rng;
    const scored = questions.map(q => {
      let w = 1;
      if (q.kind === 'input') w += 1.2;                     // 入力式は外しやすい
      if (q.type === 'total' || q.type === 'color') w += 0.8; // 数える対象が多い
      if (q.type === 'pairsum' || q.type === 'pairdiff') w += 0.6;
      if (q.type === 'parity') w -= 0.5;                    // 2択は当てられやすい
      return { id: q.id, w: w + rng() * 1.5 };
    });
    scored.sort((a, b) => b.w - a.w);
    return scored.slice(0, 3).map(s => s.id);
  }
  /* 出題する問題と配分を決める。remaining=残りフルーツ, setupsLeft=残り出題回数(自分) */
  plan(myUnusedQuestions, remaining, setupsLeft) {
    const rng = this.rng;
    const q = myUnusedQuestions[Math.floor(rng() * myUnusedQuestions.length)];
    // 均等割 ±35% を使う(最終回は全部)。後の出題用に最低1個ずつ必ず残す
    const future = Math.max(0, setupsLeft - 1);
    const maxUse = remaining - future;
    let total;
    if (setupsLeft <= 1) total = remaining;
    else total = Math.round((remaining / setupsLeft) * (0.75 + rng() * 0.7));
    total = Math.max(1, Math.min(total, maxUse));
    // 問題に関係するフルーツを厚めにしつつランダム配分
    const weights = {};
    const hot = new Set();
    const p = q.params || {};
    if (p.f && FKEYS.includes(p.f)) hot.add(p.f);
    if (p.a) hot.add(p.a); if (p.b) hot.add(p.b);
    if (p.c) FRUITS.filter(f => f.color === p.c).forEach(f => hot.add(f.key));
    for (const k of FKEYS) weights[k] = 0.4 + rng() * 1.2 + (hot.has(k) ? 0.9 : 0);
    const wsum = FKEYS.reduce((s, k) => s + weights[k], 0);
    const alloc = { ichigo: 0, cherry: 0, lemon: 0, banana: 0 };
    let used = 0;
    for (const k of FKEYS) { alloc[k] = Math.floor(total * weights[k] / wsum); used += alloc[k]; }
    while (used < total) { const k = FKEYS[Math.floor(rng() * 4)]; alloc[k]++; used++; }
    fixAllocForQuestion(q, alloc); // 偶数奇数の対象フルーツが0にならないように
    return { qid: q.id, alloc };
  }
  /* 回答: 総数が多いほど数え間違える */
  answer(question, resolved, counts) {
    const rng = this.rng;
    const total = groupValue('total', counts);
    if (resolved.kind === 'choice') {
      const pCorrect = Math.max(0.45, 0.93 - total / 220);
      if (rng() < pCorrect) return resolved.correctSet[Math.floor(rng() * resolved.correctSet.length)];
      const wrong = resolved.options.map((_, i) => i).filter(i => !resolved.correctSet.includes(i));
      return wrong.length ? wrong[Math.floor(rng() * wrong.length)] : 0;
    }
    // 入力式: 正解±ノイズ(標準偏差 ≈ 総数/16)
    const sd = total / 16;
    const noise = Math.round((rng() + rng() + rng() - 1.5) * sd);
    return Math.max(0, resolved.correct + noise);
  }
}

/* ══ ゲームエンジン(進行状態) ══
 * フェーズ制御はサーバー側。ここでは状態と正解計算・採点だけを持つ。 */
class CFEngine {
  constructor(budget = 75, seed = Date.now()) {
    this.rng = mulberry32(seed & 0xffffffff);
    this.budget0 = budget;
    this.questions = generateQuestions(this.rng, 15);
    this.first = this.rng() < 0.5 ? 0 : 1; // 先攻
    this.picks = [null, null];      // 各プレイヤーが選んだ3問(qid配列)
    this.usedQ = [[], []];          // 出題済みqid
    this.remaining = [budget, budget];
    this.scores = [0, 0];
    this.roundNo = 1;               // 1..3
    this.duelNo = 0;                // 0..5 (各回戦で先攻出題→後攻出題)
    this.log = [];                  // 各デュエルの結果
  }
  /* duelNo(0..5) → {setter, answerer, round} */
  duelInfo(n = this.duelNo) {
    const round = Math.floor(n / 2) + 1;
    const setter = (n % 2 === 0) ? this.first : 1 - this.first;
    return { round, setter, answerer: 1 - setter };
  }
  setupsLeftOf(player) {
    // 自分が出題者になる残り回数(現デュエル含む)
    let left = 0;
    for (let n = this.duelNo; n < 6; n++) if (this.duelInfo(n).setter === player) left++;
    return left;
  }
  validateAlloc(player, alloc) {
    const a = { ichigo: 0, cherry: 0, lemon: 0, banana: 0 };
    let total = 0;
    for (const k of FKEYS) {
      const v = Math.floor(Number(alloc[k]) || 0);
      if (v < 0) throw new Error('個数は0以上にしてください');
      a[k] = v; total += v;
    }
    // 後の出題用に最低1個ずつ残す(所持0で出題不能になるのを防ぐ)
    const future = this.setupsLeftOf(player) - 1;
    const maxUse = this.remaining[player] - future;
    if (total > maxUse) throw new Error(future > 0
      ? `あとの出題${future}回のために最低${future}個残してください(今回使えるのは${maxUse}個まで)`
      : `残りフルーツは${this.remaining[player]}個です`);
    if (total < 1) throw new Error('フルーツを1個以上降らせてください');
    return a;
  }
  /* デュエル確定処理: 出題(qid+alloc) → 落下seq → 正解resolve。answerはサーバーが後で採点 */
  commitSetup(qid, alloc) {
    const { setter } = this.duelInfo();
    const a = this.validateAlloc(setter, alloc);
    const q = this.questions.find(x => x.id === qid);
    if (!q) throw new Error('問題が見つかりません');
    if (!this.picks[setter].includes(qid)) throw new Error('自分が選んだ問題から出題してください');
    if (this.usedQ[setter].includes(qid)) throw new Error('その問題は出題済みです');
    // 偶数奇数の問題は、対象フルーツが0個だと出題できない
    if (q.type === 'parity' && q.params.f !== 'total' && a[q.params.f] < 1)
      throw new Error(`この問題では${FBY[q.params.f].emoji}${FBY[q.params.f].name}を1個以上降らせてください`);
    const total = FKEYS.reduce((s, k) => s + a[k], 0);
    this.remaining[setter] -= total;
    this.usedQ[setter].push(qid);
    const drop = buildDropSeq(a, this.rng);
    const resolved = resolveQuestion(q, a, this.rng);
    this.current = { qid, question: q, alloc: a, total, drop, resolved };
    return this.current;
  }
  /* 回答を採点してデュエルを閉じる。answer=null は時間切れ */
  commitAnswer(answer) {
    const info = this.duelInfo();
    const { points, exact } = scoreAnswer(this.current.resolved, answer);
    this.scores[info.answerer] += points;
    const rec = {
      duelNo: this.duelNo, round: info.round, setter: info.setter, answerer: info.answerer,
      qid: this.current.qid, text: this.current.question.text, kind: this.current.resolved.kind,
      alloc: this.current.alloc, total: this.current.total,
      correct: this.current.resolved.kind === 'input' ? this.current.resolved.correct : this.current.resolved.correctSet,
      options: this.current.resolved.options || null,
      answer: (answer === null || answer === undefined) ? null : Number(answer),
      points, exact,
      scores: this.scores.slice(),
    };
    this.log.push(rec);
    this.current = null;
    this.duelNo++;
    this.roundNo = this.duelNo >= 6 ? 3 : Math.floor(this.duelNo / 2) + 1;
    return rec;
  }
  get finished() { return this.duelNo >= 6; }
  result() {
    const [a, b] = this.scores;
    return { scores: this.scores.slice(), winner: a > b ? 0 : b > a ? 1 : null }; // null=引き分け
  }
}

module.exports = {
  FRUITS, FKEYS, mulberry32,
  generateQuestions, resolveQuestion, scoreAnswer, buildDropSeq, groupValue, fixAllocForQuestion,
  CFBrain, CFEngine,
};
