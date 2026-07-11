/* cf_core.js の検証テスト */
'use strict';
const path = './cf_core.js';
const CF = require(path);
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }

/* ── 1. 問題生成 ── */
for (let s = 0; s < 200; s++) {
  const qs = CF.generateQuestions(CF.mulberry32(s), 15);
  ok(qs.length === 15, `15問生成 seed=${s}`);
  ok(new Set(qs.map(q => q.tid)).size === 15, `重複なし seed=${s}`);
  ok(qs.every(q => q.kind === 'input' || q.kind === 'choice'), `kind正常 seed=${s}`);
}

/* ── 2. 正解計算 ── */
const counts = { ichigo: 3, cherry: 7, lemon: 0, banana: 10 };
const rng = CF.mulberry32(42);
function resolveType(type, params) {
  return CF.resolveQuestion({ type, params, kind: 'x' }, counts, rng);
}
ok(resolveType('count', { f: 'banana' }).correct === 10, 'バナナ=10');
ok(resolveType('color', { c: 'red' }).correct === 10, '赤=10');
ok(resolveType('color', { c: 'yellow' }).correct === 10, '黄=10');
ok(resolveType('total', {}).correct === 20, '合計=20');
ok(resolveType('pairsum', { a: 'ichigo', b: 'cherry' }).correct === 10, 'ペア合計');
ok(resolveType('pairdiff', { a: 'ichigo', b: 'banana' }).correct === 7, 'ペア差abs');
const cmp = resolveType('compare', { a: 'ichigo', b: 'cherry' });
ok(cmp.correctSet[0] === 1, '比較: チェリーが多い');
const cmpEq = CF.resolveQuestion({ type: 'compare', params: { a: 'lemon', b: 'lemon' } }, counts, rng);
ok(cmpEq.correctSet[0] === 2, '比較: 同数');
const most = resolveType('most', {});
ok(most.correctSet.length === 1 && most.options[most.correctSet[0]].includes('バナナ'), '最多=バナナ');
const least = resolveType('least', {});
ok(least.options[least.correctSet[0]].includes('レモン'), '最少=レモン');
ok(resolveType('parity', { f: 'cherry' }).correctSet[0] === 1, 'チェリー7=奇数');
ok(resolveType('parity', { f: 'total' }).correctSet[0] === 0, '合計20=偶数');
for (let i = 0; i < 100; i++) {
  const near = CF.resolveQuestion({ type: 'near', params: { f: 'total' } }, counts, CF.mulberry32(i));
  ok(near.options.length === 4, 'near: 4択');
  ok(new Set(near.options).size === 4, 'near: 重複なし');
  ok(near.options[near.correctSet[0]] === '20', 'near: 正解含む');
  ok(near.options.every(o => Number(o) >= 0), 'near: 0以上');
}
/* 最多タイ: 複数正解 */
const tie = CF.resolveQuestion({ type: 'most', params: {} }, { ichigo: 5, cherry: 5, lemon: 1, banana: 0 }, rng);
ok(tie.correctSet.length === 2, '最多タイで複数正解');

/* ── 3. 採点(正解+10 / 2択−10 / 3択−7 / 4択−5 / 入力式は10−ずれ) ── */
ok(CF.scoreAnswer({ kind: 'input', correct: 10 }, 10).points === 10, 'ピッタリ+10pt');
ok(CF.scoreAnswer({ kind: 'input', correct: 10 }, 12).points === 8, 'ずれ2→8pt');
ok(CF.scoreAnswer({ kind: 'input', correct: 10 }, 30).points === 0, '大外れ0pt(マイナスにはならない)');
ok(CF.scoreAnswer({ kind: 'input', correct: 10 }, null).points === 0, '時間切れ0pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [1], options: ['a','b'] }, 1).points === 10, '2択正解+10pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [1], options: ['a','b'] }, 0).points === -10, '2択ハズレ−10pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [2], options: ['a','b','c'] }, 2).points === 10, '3択正解+10pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [2], options: ['a','b','c'] }, 0).points === -7, '3択ハズレ−7pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [0], options: ['a','b','c','d'] }, 0).points === 10, '4択正解+10pt');
ok(CF.scoreAnswer({ kind: 'choice', correctSet: [0], options: ['a','b','c','d'] }, 3).points === -5, '4択ハズレ−5pt');

/* ── 4. 落下シーケンス ── */
const drop = CF.buildDropSeq({ ichigo: 5, cherry: 3, lemon: 0, banana: 2 }, CF.mulberry32(7));
ok(drop.seq.length === 10, 'seq総数=配分計');
ok(drop.seq.filter(i => i.f === 'ichigo').length === 5, 'イチゴ5個');
ok(drop.seq.filter(i => i.f === 'lemon').length === 0, 'レモン0個');
ok(drop.seq.every((it, i) => i === 0 || it.t >= drop.seq[i - 1].t), '時刻昇順');
ok(drop.duration > drop.seq[drop.seq.length - 1].t, 'duration > 最終落下開始');
const big = CF.buildDropSeq({ ichigo: 75, cherry: 0, lemon: 0, banana: 0 }, CF.mulberry32(8));
ok(big.duration < 40000, `75個でも40秒以内 (${Math.round(big.duration / 1000)}s)`);

/* ── 5. fixAllocForQuestion(偶奇問題の対象フルーツ0を回避) ── */
{
  const a = { ichigo: 5, cherry: 0, lemon: 3, banana: 0 };
  CF.fixAllocForQuestion({ type: 'parity', params: { f: 'cherry' } }, a);
  ok(a.cherry === 1 && a.ichigo === 4, '最多フルーツから1個移動');
  ok(a.ichigo + a.cherry + a.lemon + a.banana === 8, '合計は不変');
  const b = { ichigo: 5, cherry: 2, lemon: 0, banana: 0 };
  CF.fixAllocForQuestion({ type: 'parity', params: { f: 'cherry' } }, b);
  ok(b.cherry === 2 && b.ichigo === 5, '既に1個以上なら変更なし');
  const c = { ichigo: 5, cherry: 0, lemon: 0, banana: 0 };
  CF.fixAllocForQuestion({ type: 'parity', params: { f: 'total' } }, c);
  ok(c.ichigo === 5, '合計の偶奇問題は対象外');
}

/* ── 6. エンジン整合性 ── */
for (let seed = 0; seed < 50; seed++) {
  const E = new CF.CFEngine(75, seed);
  ok(E.remaining[0] === 75 && E.remaining[1] === 75, '初期予算');
  ok(E.first === 0 || E.first === 1, '先攻決定');
  const brains = [new CF.CFBrain(CF.mulberry32(seed * 2 + 1)), new CF.CFBrain(CF.mulberry32(seed * 3 + 2))];
  E.picks[0] = brains[0].pickQuestions(E.questions);
  E.picks[1] = brains[1].pickQuestions(E.questions);
  ok(E.picks[0].length === 3 && new Set(E.picks[0]).size === 3, 'CPU選択3問');
  const order = [];
  for (let n = 0; n < 6; n++) order.push(E.duelInfo(n));
  ok(order[0].setter === E.first && order[1].setter === 1 - E.first, 'R1 交互出題');
  ok(order[4].round === 3 && order[5].round === 3, 'R3の位置');
  while (!E.finished) {
    const { setter, answerer } = E.duelInfo();
    const unused = E.picks[setter].filter(id => !E.usedQ[setter].includes(id)).map(id => E.questions.find(q => q.id === id));
    const plan = brains[setter].plan(unused, E.remaining[setter], E.setupsLeftOf(setter));
    const before = E.remaining[setter];
    const futureAfter = E.setupsLeftOf(setter) - 1;
    const cur = E.commitSetup(plan.qid, plan.alloc);
    ok(E.remaining[setter] === before - cur.total, '予算減算');
    ok(E.remaining[setter] >= futureAfter, '後の出題分(最低1個ずつ)が残っている');
    const ans = brains[answerer].answer(cur.question, cur.resolved, cur.alloc);
    const rec = E.commitAnswer(ans);
    ok(rec.points >= -10 && rec.points <= 10, 'ポイント範囲−10..10');
  }
  ok(E.log.length === 6, '6デュエル完了');
  ok(E.usedQ[0].length === 3 && E.usedQ[1].length === 3, '各自3問出題');
  const res = E.result();
  ok(res.scores[0] === E.log.filter(r => r.answerer === 0).reduce((s, r) => s + r.points, 0), 'スコア集計一致');
}

/* ── 7. バリデーション ── */
{
  const E = new CF.CFEngine(75, 1);
  const setter = E.duelInfo().setter;
  E.picks = [[0, 1, 2], [0, 1, 2]];
  let threw = false;
  try { E.commitSetup(0, { ichigo: 80, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = true; }
  ok(threw, '予算超過はエラー');
  threw = false;
  try { E.commitSetup(0, { ichigo: 0, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = true; }
  ok(threw, '0個はエラー');
  // 温存ルール: 出題残り3回(現含む)なら 75−2=73個まで
  threw = false;
  try { E.commitSetup(0, { ichigo: 74, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = true; }
  ok(threw, '74個(残し不足)はエラー');
  threw = false;
  try { E.commitSetup(14, { ichigo: 5, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = true; }
  ok(threw, '未選択問題の出題はエラー');
  // 出題済み再出題チェック(偶奇問題を避けるため通常問題を選ぶ)
  const safeId = [0, 1, 2].find(id => E.questions[id].type !== 'parity');
  if (safeId !== undefined) {
    E.commitSetup(safeId, { ichigo: 5, cherry: 5, lemon: 5, banana: 5 });
    E.commitAnswer(3);
    while (E.duelInfo().setter !== setter) {
      const sId = E.picks[E.duelInfo().setter].find(id => !E.usedQ[E.duelInfo().setter].includes(id) && E.questions[id].type !== 'parity');
      const al = { ichigo: 1, cherry: 1, lemon: 1, banana: 1 };
      CF.fixAllocForQuestion(E.questions[sId !== undefined ? sId : E.picks[E.duelInfo().setter][0]], al);
      E.commitSetup(sId !== undefined ? sId : E.picks[E.duelInfo().setter][0], al);
      E.commitAnswer(0);
    }
    threw = false;
    try { E.commitSetup(safeId, { ichigo: 1, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = true; }
    ok(threw, '出題済み問題の再出題はエラー');
  }
}
/* 偶数奇数問題: 対象フルーツ0はエラー */
{
  const E = new CF.CFEngine(75, 2);
  E.questions[0] = { id: 0, tid: 999, type: 'parity', params: { f: 'banana' }, text: 'テスト偶奇', kind: 'choice' };
  E.picks = [[0, 1, 2], [0, 1, 2]];
  let threw = false;
  try { E.commitSetup(0, { ichigo: 10, cherry: 0, lemon: 0, banana: 0 }); } catch (e) { threw = /バナナ/.test(e.message); }
  ok(threw, '偶奇問題でバナナ0はエラー(メッセージにフルーツ名)');
  const cur = E.commitSetup(0, { ichigo: 9, cherry: 0, lemon: 0, banana: 1 });
  ok(cur.total === 10, '偶奇問題でバナナ1なら出題できる');
}

/* ── 8. 1000ゲーム自動対戦(クラッシュ・不変条件) ── */
let draws = 0, wins = [0, 0], negScores = 0;
for (let g = 0; g < 1000; g++) {
  const E = new CF.CFEngine(15 + (g % 5) * 60, g * 977 + 13);
  const brains = [new CF.CFBrain(CF.mulberry32(g + 1)), new CF.CFBrain(CF.mulberry32(g + 99991))];
  E.picks[0] = brains[0].pickQuestions(E.questions);
  E.picks[1] = brains[1].pickQuestions(E.questions);
  while (!E.finished) {
    const { setter, answerer } = E.duelInfo();
    const unused = E.picks[setter].filter(id => !E.usedQ[setter].includes(id)).map(id => E.questions.find(q => q.id === id));
    const plan = brains[setter].plan(unused, E.remaining[setter], E.setupsLeftOf(setter));
    const cur = E.commitSetup(plan.qid, plan.alloc); // 温存/偶奇ルール違反ならここでthrowされ即失敗する
    if (cur.total < 1) throw new Error('CPUが0個配分');
    E.commitAnswer(brains[answerer].answer(cur.question, cur.resolved, cur.alloc));
  }
  if (E.remaining[0] < 0 || E.remaining[1] < 0) throw new Error('予算が負');
  const r = E.result();
  if (r.scores[0] < 0 || r.scores[1] < 0) negScores++;
  if (r.winner === null) draws++; else wins[r.winner]++;
}
ok(true, '1000ゲーム完走(CPUは温存・偶奇ルールに常に適合)');
console.log(`\n自動対戦1000ゲーム: P0勝ち${wins[0]} / P1勝ち${wins[1]} / 引き分け${draws} / マイナススコア発生${negScores}ゲーム`);
console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
