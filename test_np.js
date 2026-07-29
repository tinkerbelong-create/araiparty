/* ファイブリーグ テスト — 問題集の形式・進行・得点・珍解答 */
'use strict';
const assert = require('assert');
const NP = require('./np_core.js');
const { QUESTIONS, GENRES } = require('./np_questions.js');
let ok=0, ng=0;
const T=(n,f)=>{try{f();ok++;console.log('  ✅',n);}catch(e){ng++;console.log('  ❌',n,'\n     ',e.message);}};
const len=s=>Array.from(s).length;

console.log('\n── 問題集 ──');
T('150問ある', () => assert.strictEqual(QUESTIONS.length, 150));
T('★答えはすべてカタカナ5文字', () => QUESTIONS.forEach(q =>
  assert(len(q.a)===5 && /^[ァ-ヶー]+$/.test(q.a), q.a)));
T('難易度1〜5が各30問', () => [1,2,3,4,5].forEach(d =>
  assert.strictEqual(QUESTIONS.filter(q=>q.d===d).length, 30, '難易度'+d)));
T('5ジャンルに6問ずつ均等', () => [1,2,3,4,5].forEach(d => GENRES.forEach(g =>
  assert.strictEqual(QUESTIONS.filter(q=>q.d===d&&q.g===g).length, 6, d+g))));
T('答えに重複がない', () => {
  const a = QUESTIONS.map(q=>q.a);
  assert.strictEqual(new Set(a).size, a.length);
});
T('問題文がすべて埋まっている', () => QUESTIONS.forEach(q => assert(q.t && q.t.length > 5)));

console.log('\n── 得点(進むほど大きくなる) ──');
T('1問=10 / 2問=30 / 3問=60 / 4問=100', () => {
  assert.strictEqual(NP.scoreFor(1).total, 10);
  assert.strictEqual(NP.scoreFor(2).total, 30);
  assert.strictEqual(NP.scoreFor(3).total, 60);
  assert.strictEqual(NP.scoreFor(4).total, 100);
});
T('★パーフェクトは150＋ボーナス50＝200', () => {
  const s = NP.scoreFor(5);
  assert.strictEqual(s.base, 150);
  assert.strictEqual(s.bonus, 50);
  assert.strictEqual(s.total, 200);
  assert.strictEqual(s.perfect, true);
});
T('0問なら0点', () => assert.strictEqual(NP.scoreFor(0).total, 0));
T('ステージが進むほど1問の価値が上がる', () => {
  for (let i=1;i<5;i++) assert(NP.pointsOfStage(i) < NP.pointsOfStage(i+1));
});

console.log('\n── 出題 ──');
T('難易度どおりの問題が出る', () => {
  for (let d=1;d<=5;d++) assert.strictEqual(NP.pickQuestion(d,'ことば').d, d);
});
T('既出は避けられる', () => {
  const used = QUESTIONS.filter(q=>q.d===2&&q.g==='ことば').map(q=>q.t);
  const q = NP.pickQuestion(2,'ことば',used);
  assert(!used.includes(q.t));
});
T('5問通しても同じ問題が出ない', () => {
  const used=[];
  for (let d=1;d<=5;d++){ const q=NP.pickQuestion(d,'エンタメ',used); assert(!used.includes(q.t)); used.push(q.t); }
});

console.log('\n── マスの割り当て ──');
T('5人なら1人1マス', () => {
  const s = NP.assignSlots([1,2,3,4,5].map(i=>({id:'p'+i,name:'P'+i})));
  assert.strictEqual(s.length, 5);
  assert.strictEqual(new Set(s.map(x=>x.playerId)).size, 5);
});
T('3人でも5マス埋まる(一部が2マス担当)', () => {
  const s = NP.assignSlots(['A','B','C'].map(n=>({id:n,name:n})));
  assert.strictEqual(s.length, 5);
  assert.deepStrictEqual(s.map(x=>x.playerName), ['A','B','C','A','B']);
});

console.log('\n── 判定と珍解答 ──');
{
  const mk = str => Array.from(str).map((c,i)=>({index:i,char:c}));
  T('全員正解なら correctAll', () => {
    const j = NP.judge(mk('カタツムリ'),'カタツムリ');
    assert(j.correctAll && j.results.every(r=>r==='correct'));
  });
  T('1人でも違えば correctAll にならない', () => {
    const j = NP.judge(mk('カタツムソ'),'カタツムリ');
    assert(!j.correctAll);
    assert.deepStrictEqual(j.results, ['correct','correct','correct','correct','wrong']);
  });
  T('ひらがなで入れても正解になる', () => assert(NP.judge(mk('かたつむり'),'カタツムリ').correctAll));
  T('★できあがってしまった言葉が返る(本家の「カァイター」)', () =>
    assert.strictEqual(NP.assembled(mk('カァイター')), 'カァイター'));
  T('空欄は◯で埋まる', () =>
    assert.strictEqual(NP.assembled([{char:'ア'},{char:''},{char:'ウ'},{char:''},{char:'オ'}]), 'ア◯ウ◯オ'));
}

console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng?1:0);
