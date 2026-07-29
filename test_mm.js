/* マダミス通しテスト — ステップ進行・能力解決・秘匿・採点 */
'use strict';
const assert = require('assert');
const MM = require('./mm_core.js');

let ok = 0, ng = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ✅', n); } catch (e) { ng++; console.log('  ❌', n, '\n     ', e.message); } };

const CH = ['natsuki', 'ryusei', 'kaito'];
const g = () => new MM.Game('cake');
/* 全員完了を押してステップを1つ進める(server の advanceStep 相当) */
const allReady = G => {
  if (G.step === 'main' && G.phaseType === 'ability') G.resolvePhase();
  CH.forEach(c => G.markReady(c));
  return G.nextStep();
};
/* 指定のフェーズ・本編まで進める */
const toPhase = (G, idx) => { while (G.phaseIdx < idx || G.step !== 'main') allReady(G); return G; };
const txt = (G, cid) => (G.lastResults[cid] || []).map(x => x.title + '｜' + x.text).join('\n');

console.log('\n── シナリオ ──');
T('cake がある', () => assert(MM.listScenarios().some(s => s.id === 'cake')));
T('3人固定', () => { const s = MM.loadScenario('cake'); assert(s.players.min === 3 && s.players.max === 3); });

console.log('\n── ★原作準拠: 余計なものが無い ──');
{
  const s = MM.loadScenario('cake');
  T('性格欄が無い', () => s.characters.forEach(c => assert(c.handout.personality === undefined)));
  T('キャッチコピーが無い', () => s.characters.forEach(c => assert(c.catch === undefined)));
  T('場所ごとの調査アクションが無い', () => s.places.forEach(p => assert(p.action === undefined)));
  T('「調べに行く」フェーズが無い(能力フェーズだけ)', () =>
    assert(!s.phases.some(p => p.type === 'investigate')));
  T('水は「使う」能力ではなく、水が出るだけ', () =>
    assert.strictEqual(s.abilityActions.r1.resolve, 'flavor'));
  T('水を人前で披露する仕掛けが無い(使えば能力がバレるだけなので)', () =>
    assert(s.abilityActions.r1.publicText === undefined));
  T('水の結果文に誘導が入っていない', () =>
    assert(!/言い訳|必要はない/.test(s.abilityActions.r1.text)));
  T('★すり抜けの結果に創作の手がかりが無い', () => {
    const ng = /紙ナプキン|甘い匂い|匂いがしない|へこみ跡|黒い異物|電源|ケース|クリーム/;
    s.places.forEach(p => assert(!ng.test(p.touch), p.name + ': ' + p.touch));
  });
  T('★原作にある事実(紙コップ)だけは返す', () =>
    assert(/紙コップ/.test(s.places.find(p=>p.id==='r_ryusei').touch)));
  T('★ルールは原作の基本ルール3項目', () => {
    assert.strictEqual(s.rules.length, 3);
    assert(/嘘をつくのは自由ですが、キャラクターの記憶/.test(s.rules[2]));
  });
  T('★フェーズの説明は原作のゲームフロー文', () => {
    const p = s.phases.find(x=>x.id==='talk1');
    assert(/事件発生から現在までの情報をもとに、自由に話し合いを行います/.test(p.todo));
  });
  T('★紙コップの手がかりがリュウセイのシートにある', () =>
    assert(/紙コップを常備/.test(s.characters.find(c=>c.id==='ryusei').handout.thoughts)));
  T('★飲み物を買わない違和感がカイトのシートにある', () =>
    assert(/飲み物が入ってない/.test(s.characters.find(c=>c.id==='kaito').handout.thoughts)));
  T('★21:30の「のどが渇いた」がナツキとリュウセイ双方に残っている', () => {
    const t = c => s.characters.find(x=>x.id===c).handout.timeline.find(t=>t.time==='21:30').text;
    assert(/のどが渇いた/.test(t('natsuki')) && /のどが渇いた/.test(t('ryusei')));
  });
}

console.log('\n── ★電源のことを明記しない ──');
{
  const G = g();
  const pub = JSON.stringify(G.publicView());
  T('公開情報に「電源」が出てこない', () => assert(!/電源/.test(pub)));
  T('公開情報に冷蔵庫の扉の状態が出てこない', () => assert(!/doors/.test(pub)));
  toPhase(G, 2);
  G.submitMove('natsuki', { abilityId: 'n1', target: { placeId: 'fridge' } });
  CH.slice(1).forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  const t = txt(G, 'natsuki');
  T('すり抜け失敗で「暗い。どうして?」までしか言わない', () => assert(/暗い。どうして\?/.test(t)));
  T('「電源」「コード」という単語を出さない', () => assert(!/電源|コード/.test(t)));
  T('「明るくないと使えない」と答えを教えない', () => assert(!/明るくないと使えない/.test(t)));
  T('失敗なので回数を消費しない', () => assert.strictEqual(G.used.natsuki, 0));
}

console.log('\n── 秘匿性 ──');
{
  const G = g();
  const pub = JSON.stringify(G.publicView());
  T('他人のHOが publicView に無い', () => assert(!pub.includes('ケーキを取る方法を真剣に考えて')));
  T('真相が publicView に無い', () => assert(!pub.includes('偽物のケーキを冷蔵庫に設置')));
  T('場所の中身(touch)が publicView に無い', () => assert(!pub.includes('甘い匂い')));
  T('能力の中身が publicView に無い', () => assert(!pub.includes('壁を手だけすり抜け')));
  T('正解が publicView に無い', () => assert(!pub.includes('"answer"')));
  const priv = JSON.stringify(G.privateView('natsuki'));
  T('自分のHOは privateView にある', () => assert(priv.includes('ケーキを取る方法を真剣に考えて')));
  T('他人のHOは privateView に無い', () => assert(!priv.includes('おれの能力を最大限使う')));
  T('真相は privateView に無い', () => assert(!priv.includes('偽物のケーキを冷蔵庫に設置')));
  T('候補にダミーが混ざる', () => {
    const p = G.privateView('natsuki').abilityPool;
    assert(p.length > 9 && p.some(x => /^x/.test(x.id)));
  });
  T('★ダミーのほうが本物より多い', () => {
    const p = G.privateView('natsuki').abilityPool;
    assert(p.filter(x => /^x/.test(x.id)).length > 9);
  });
  T('★並び順がシャッフルされている(先頭9個が本物にならない)', () => {
    let sortedRuns = 0;
    for (let i = 0; i < 30; i++) {
      const p = g().privateView('natsuki').abilityPool;
      if (p.slice(0, 9).every(x => !/^x/.test(x.id))) sortedRuns++;
    }
    assert(sortedRuns === 0, `${sortedRuns}/30 回、先頭9個が本物だった`);
  });
  T('★ゲームごとに並びが変わる', () => {
    const a = g().privateView('natsuki').abilityPool.map(x => x.id).join(',');
    const b = g().privateView('natsuki').abilityPool.map(x => x.id).join(',');
    assert(a !== b);
  });
  T('★最終フェーズで配る候補もシャッフル済み', () => {
    const G2 = g(); G2.phaseIdx = 6; G2.step = 'main';
    const p = G2.privateView('natsuki');
    assert.deepStrictEqual(p.abilityGuess.pool.map(x=>x.id), p.abilityPool.map(x=>x.id));
  });
}

console.log('\n── ★ステップ進行(全員が完了を押すまで進まない) ──');
{
  const G = g();
  T('最初は「導入・読み込み」の案内から', () => {
    assert.strictEqual(G.phase.id, 'read');
    assert.strictEqual(G.step, 'brief');
  });
  T('1人だけ押しても進まない', () => {
    G.markReady('natsuki');
    assert.strictEqual(G.step, 'brief');
    assert.strictEqual(G.readyCount(), 1);
  });
  T('全員押したら本編へ', () => { allReady(G); assert.strictEqual(G.step, 'main'); });
  T('本編を終えると次フェーズの案内へ(いきなり本編にならない)', () => {
    allReady(G);
    assert.strictEqual(G.phase.id, 'talk1');
    assert.strictEqual(G.step, 'brief');
  });
  T('案内には「次は何をするか」が入っている', () => {
    assert(G.phase.brief && G.phase.todo);
  });
  T('ready は毎ステップでリセットされる', () => assert.strictEqual(G.readyCount(), 0));
}
{
  const G = g();
  const seen = [];
  for (let i = 0; i < 40 && G.step; i++) {
    seen.push(`${G.phase.id}:${G.step}`);
    if (G.step === 'main' && G.phaseType === 'ability') CH.forEach(c => G.submitMove(c, {}));
    if (G.step === 'main' && G.phaseType === 'final') CH.forEach(c => G.submitAnswers(c, { questions:{}, abilities:{} }));
    if (allReady(G) === 'end') { seen.push('ending'); break; }
  }
  T('能力フェーズは 案内→本編→結果 の3段', () => {
    assert(seen.includes('act1:brief') && seen.includes('act1:main') && seen.includes('act1:result'));
  });
  T('話し合いは 案内→本編 の2段', () => {
    assert(seen.includes('talk1:brief') && seen.includes('talk1:main') && !seen.includes('talk1:result'));
  });
  T('最後まで到達する', () => assert(seen[seen.length-1] === 'ending'));
  T('全8フェーズを通る', () => {
    ['read','talk1','act1','talk2','act2','talk3','final'].forEach(p =>
      assert(seen.some(x => x.startsWith(p+':')), p));
  });
}

console.log('\n── ★キャラはランダム配布 ──');
{
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(g().assignRandom(3).join(','));
  T('毎回同じ並びにならない', () => assert(seen.size > 1));
  T('3人に3キャラが重複なく配られる', () => {
    const a = g().assignRandom(3);
    assert.strictEqual(new Set(a).size, 3);
  });
}

console.log('\n── 能力: すり抜け ──');
{
  const G = toPhase(g(), 2);
  G.submitMove('natsuki', { abilityId:'n1', target:{ placeId:'r_ryusei' } });
  CH.slice(1).forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('リュウセイの部屋に手を伸ばすと紙コップの山に当たる', () => assert(/紙コップ/.test(txt(G,'natsuki'))));
  T('回数を消費する', () => assert.strictEqual(G.used.natsuki, 1));
  T('使わなかった人には「動かなかった」', () => assert(/動かなかった/.test(txt(G,'ryusei'))));
}
{
  const G = toPhase(g(), 2);
  G.submitMove('natsuki', { abilityId:'n1', target:{ placeId:'r_kaito' } });
  CH.slice(1).forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('★他の部屋からは何も出てこない(創作を混ぜない)', () => assert(/特にない/.test(txt(G,'natsuki'))));
}

console.log('\n── ★水は使っても公開されない(使えば能力がバレるだけ) ──');
{
  const G = toPhase(g(), 2);
  G.submitMove('ryusei', { abilityId:'r1' });
  G.submitMove('natsuki', {}); G.submitMove('kaito', {});
  G.resolvePhase();
  T('水は本人にだけ結果が届く', () => assert(/のどを潤した/.test(txt(G,'ryusei'))));
  T('水を出したことは公開されない', () => assert(!/水/.test(JSON.stringify(G.publicLog))));
  T('公開されるのは「能力を使った」事実だけ', () =>
    assert(G.publicLog.some(l => /リュウセイが能力を使った/.test(l.text))));
}
{
  const G = toPhase(g(), 2);
  G.submitMove('ryusei', { abilityId:'r2', target:{ objId:'cake' } });
  G.submitMove('natsuki', {}); G.submitMove('kaito', {});
  G.resolvePhase();
  T('偽物を出したことが全員に見える', () => assert(G.publicLog.some(l => /リュウセイが、どこからかケーキを取り出した/.test(l.text))));
}

console.log('\n── 能力: カメラと同化 ──');
{
  const G = toPhase(g(), 2);
  G.submitMove('ryusei',  { abilityId:'r3', target:{ placeId:'r_ryusei' } });
  G.submitMove('natsuki', { abilityId:'n1', target:{ placeId:'r_ryusei' } });
  G.submitMove('kaito', {});
  G.resolvePhase();
  T('カメラは、その場所に能力を向けた人を捉える', () => assert(/ナツキが来ている/.test(txt(G,'ryusei'))));
}
{
  const G = toPhase(g(), 2);
  G.submitMove('natsuki', { abilityId:'n3', target:{ placeId:'kitchen' } });
  G.submitMove('ryusei',  { abilityId:'r3', target:{ placeId:'kitchen' } });
  G.submitMove('kaito', {});
  G.resolvePhase();
  T('同化はその場所に来た人を目撃する', () => assert(/リュウセイ/.test(txt(G,'natsuki'))));
}
{
  const G = toPhase(g(), 2);
  G.submitMove('ryusei',  { abilityId:'r3', target:{ placeId:'fridge' } });
  G.submitMove('natsuki', { abilityId:'n1', target:{ placeId:'fridge' } });
  G.submitMove('kaito', {});
  G.resolvePhase();
  T('暗い冷蔵庫では人物が特定できない', () => assert(/暗くて、誰かまでは分からない/.test(txt(G,'ryusei'))));
}

console.log('\n── 能力: キーワード / コピー / 消す ──');
{
  const G = g();
  T('カイトはHOどおり2つ掴んだ状態で始まる', () => {
    assert.strictEqual(G.known.kaito.length, 2);
    assert(G.known.kaito.some(k => k.abilityId === 'n1'));
    assert(G.known.kaito.some(k => k.abilityId === 'r3'));
  });
  toPhase(G, 2);
  G.submitMove('kaito', { abilityId:'k2', target:{ charId:'natsuki' } });
  G.submitMove('natsuki', {}); G.submitMove('ryusei', {});
  G.resolvePhase();
  T('既知のキーワードは重複して出ない', () => assert(!/「すり抜け」/.test(txt(G,'kaito'))));
  T('残り2つのどちらかが手に入る', () => assert(/「(コピー\(能力\)|同化)」/.test(txt(G,'kaito'))));
}
{
  const G = toPhase(g(), 2);
  T('「消す」は提出が弾かれる', () => assert(!G.submitMove('kaito', { abilityId:'k3' }).ok));
  T('使えない理由が privateView に入っている', () => {
    const a = G.privateView('kaito').abilityActions.k3;
    assert.strictEqual(a.usable, false);
    assert(/来月/.test(a.unusableReason));
  });
}
{
  const G = toPhase(g(), 2);
  G.submitMove('natsuki', { abilityId:'n2', target:{ charId:'kaito', abilityId:'k1' } });
  G.submitMove('ryusei', {}); G.submitMove('kaito', {});
  G.resolvePhase();
  T('言い当てればコピー成功', () => assert.strictEqual(G.copied.natsuki, 'k1'));
  toPhase(G, 4);
  T('コピー能力が選択肢に出る', () => assert(G.privateView('natsuki').character.abilities.some(a=>a.id==='k1'&&a.copied)));
  G.submitMove('natsuki', { abilityId:'k1', target:{ doorId:'fridge' } });
  G.submitMove('ryusei', {}); G.submitMove('kaito', {});
  G.resolvePhase();
  T('コピー能力を実際に使える', () => assert.strictEqual(G.doors.fridge, 'open'));
  T('コピー使用は回数を消費しない', () => assert.strictEqual(G.used.natsuki, 1));
}

console.log('\n── ★誰が能力を使ったかだけ公開 ──');
{
  const G = toPhase(g(), 2);
  G.submitMove('natsuki', { abilityId:'n1', target:{ placeId:'living' } });
  G.submitMove('ryusei', {}); G.submitMove('kaito', {});
  G.resolvePhase();
  const l = G.publicLog.filter(x => /能力を使った/.test(x.text)).pop();
  T('使った人の名前は出る', () => assert(/ナツキが能力を使った/.test(l.text)));
  T('使っていない人の名前は出ない', () => assert(!/リュウセイ|カイト/.test(l.text)));
  T('何の能力かは公開されない', () => assert(!/すり抜け/.test(JSON.stringify(G.publicLog))));
  T('どこを見たかも公開されない', () => assert(!/リビング/.test(JSON.stringify(G.publicLog))));
}

console.log('\n── 使用回数 ──');
{
  const G = toPhase(g(), 2);
  G.used.natsuki = 2;
  T('使い切ったら能力つきで提出できない', () =>
    assert(!G.submitMove('natsuki', { abilityId:'n1', target:{placeId:'living'} }).ok));
  T('「使わない」は提出できる', () => assert(G.submitMove('natsuki', {}).ok));
}

console.log('\n── 採点 ──');
{
  const G = g(); G.phaseIdx = 6; G.step = 'main';
  const perfect = { q_eater:'ryusei', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions:perfect, abilities:{ ryusei:['r1','r2','r3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('ryusei',  { questions:perfect, abilities:{ natsuki:['n1','n2','n3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('kaito',   { questions:perfect, abilities:{ natsuki:['n1','n2','n3'], ryusei:['r1','r2','r3'] } });
  const R = G.score();
  T('ナツキ 5+3+1 = 9', () => assert.strictEqual(R.detail.natsuki.total, 9));
  T('リュウセイ 3+2+2 = 7', () => assert.strictEqual(R.detail.ryusei.total, 7));
  T('カイト 5+3+3 = 11', () => assert.strictEqual(R.detail.kaito.total, 11));
  T('outro に勝者名が入る', () => assert(R.outro.includes(R.winner.name) && !R.outro.includes('{{WINNER}}')));
}
{
  const G = g(); G.phaseIdx = 6; G.step = 'main';
  G.submitAnswers('natsuki', { questions:{ q_eater:'kaito', q_fake:'none', q_taste:'b', q_jewel:'c', q_fail:'c', q_sound1:'b', q_sound2:'b' }, abilities:{} });
  G.submitAnswers('ryusei',  { questions:{ q_eater:'kaito', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' }, abilities:{} });
  G.submitAnswers('kaito',   { questions:{ q_eater:'natsuki', q_fake:'none', q_taste:'c', q_jewel:'d', q_fail:'b', q_sound1:'c', q_sound2:'c' }, abilities:{} });
  const R = G.score();
  T('誰も真相に届かないとリュウセイ完全勝利(18pt)', () => assert.strictEqual(R.detail.ryusei.total, 18));
  T('勝者はリュウセイ', () => assert.strictEqual(R.winner.id, 'ryusei'));
}
{
  const G = g(); G.phaseIdx = 6; G.step = 'main';
  const q = { q_eater:'none', q_fake:'none', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions:q, abilities:{ ryusei:['r1','x1','x2'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('ryusei',  { questions:q, abilities:{ natsuki:['x1','x2','x3'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('kaito',   { questions:q, abilities:{ natsuki:['x1','x2','x3'], ryusei:['x1','x2','x3'] } });
  const R = G.score();
  T('誰にも当てられなければ 3×2 = 6pt', () =>
    assert.strictEqual(R.detail.natsuki.lines.find(y=>/能力がバレない/.test(y.label)).points, 6));
  T('1つバレたら 2×2 = 4pt', () =>
    assert.strictEqual(R.detail.ryusei.lines.find(y=>/能力がバレない/.test(y.label)).points, 4));
}

console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng ? 1 : 0);
