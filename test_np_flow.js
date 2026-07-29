/* サーバー側の進行を、ソケットを通さず再現して確認する */
'use strict';
const assert=require('assert'); const NP=require('./np_core.js');
let ok=0,ng=0; const T=(n,f)=>{try{f();ok++;console.log('  ✅',n);}catch(e){ng++;console.log('  ❌',n,'\n     ',e.message);}};

/* np_server.js の dealStage / finishRun と同じ手順を再現 */
function run(answersFn){
  const members=[1,2,3,4,5].map(i=>({id:'p'+i,name:'P'+i}));
  const g={stage:0,cleared:0,used:[],genre:'一般常識',finished:false,gained:null,log:[]};
  while(!g.finished){
    g.stage=g.cleared+1;
    const q=NP.pickQuestion(g.stage,g.genre,g.used); g.used.push(q.t);
    const slots=NP.assignSlots(members);
    answersFn(slots,q,g.stage);
    const j=NP.judge(slots,q.a);
    g.log.push({stage:g.stage,d:q.d,ok:j.correctAll,word:NP.assembled(slots),ans:q.a});
    if(j.correctAll){ g.cleared++; if(g.cleared>=NP.STAGES){ g.gained=NP.scoreFor(g.cleared); g.finished=true; } }
    else { g.gained=NP.scoreFor(g.cleared); g.finished=true; }
  }
  return g;
}
const all=(slots,q)=>Array.from(q.a).forEach((c,i)=>slots[i].char=c);

console.log('\n── 5問パーフェクト ──');
{
  const g=run(all);
  T('5問すべて出題される', () => assert.strictEqual(g.log.length,5));
  T('★難易度が1→5と上がる', () => assert.deepStrictEqual(g.log.map(x=>x.d),[1,2,3,4,5]));
  T('同じ問題は出ない', () => assert.strictEqual(new Set(g.used).size,5));
  T('200ポイント獲得', () => assert.strictEqual(g.gained.total,200));
  T('パーフェクト判定', () => assert.strictEqual(g.gained.perfect,true));
}

console.log('\n── 3問目で1人だけ間違える ──');
{
  const g=run((slots,q,stage)=>{ all(slots,q); if(stage===3) slots[2].char='ソ'; });
  T('★そこで終了する(4問目に進まない)', () => assert.strictEqual(g.log.length,3));
  T('クリアは2問', () => assert.strictEqual(g.log.filter(x=>x.ok).length,2));
  T('得点は10+20=30', () => assert.strictEqual(g.gained.total,30));
  T('パーフェクトではない', () => assert.strictEqual(g.gained.perfect,false));
  T('★できあがった言葉が残る', () => {
    const last=g.log[2];
    assert.strictEqual(Array.from(last.word).length,5);
    assert.notStrictEqual(last.word,last.ans);
  });
}

console.log('\n── 1問目で失敗 ──');
{
  const g=run(slots=>slots.forEach(s=>s.char='ア'));
  T('1問で終了', () => assert.strictEqual(g.log.length,1));
  T('0ポイント', () => assert.strictEqual(g.gained.total,0));
  T('珍解答は「アアアアア」', () => assert.strictEqual(g.log[0].word,'アアアアア'));
}

console.log('\n── 得点が進むほど増える ──');
{
  const tot=[1,2,3,4,5].map(n=>NP.scoreFor(n).total);
  T('10 → 30 → 60 → 100 → 200', () => assert.deepStrictEqual(tot,[10,30,60,100,200]));
  T('1問あたりの増分も増えていく', () => {
    const inc=tot.map((v,i)=>v-(tot[i-1]||0));
    for(let i=0;i<inc.length-1;i++) assert(inc[i]<inc[i+1]);
  });
}
console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng?1:0);
