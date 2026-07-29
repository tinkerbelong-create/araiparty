/* 『海の上でいちばん偉い人』テスト — 命令・船長権限・証言カード・採点・秘匿 */
'use strict';
const assert = require('assert');
const MM = require('./mm_core.js');

let ok = 0, ng = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ✅', n); } catch (e) { ng++; console.log('  ❌', n, '\n     ', e.message); } };

const CH = ['toomi', 'kaburagi', 'shizu', 'mei'];
const g = () => new MM.Game('umi');
const allReady = G => {
  if (G.step === 'main' && G.phaseType === 'ability') G.resolvePhase();
  CH.forEach(c => G.markReady(c));
  return G.nextStep();
};
const toPhase = (G, id) => { while (G.phase.id !== id || G.step !== 'main') allReady(G); return G; };
const txt = (G, cid) => (G.lastResults[cid] || []).map(x => x.title + '｜' + x.text).join('\n');
const pubText = G => JSON.stringify(G.publicLog);

console.log('\n── シナリオ ──');
T('umi が一覧に出る', () => assert(MM.listScenarios().some(s => s.id === 'umi')));
T('4人固定・約60分', () => {
  const s = MM.loadScenario('umi');
  assert.strictEqual(s.players.min, 4);
  assert.strictEqual(s.players.max, 4);
  assert(/60/.test(s.duration));
});
T('「はじめに」フェーズがある(初心者向け)', () => {
  const s = MM.loadScenario('umi');
  assert.strictEqual(s.phases[0].type, 'intro');
  assert(s.intro && s.intro.length > 100);
});

console.log('\n── 秘匿性 ──');
{
  const G = g();
  const pub = JSON.stringify(G.publicView());
  T('真相が publicView に無い', () => assert(!pub.includes('胸が動いていた')));
  T('他人のHOが publicView に無い', () => assert(!pub.includes('二十二年前、わたしは娘を産んで')));
  T('手札の中身が publicView に無い', () => assert(!pub.includes('総トン数24トン、沿海区域を航行中。この条件')));
  T('正解が publicView に無い', () => assert(!pub.includes('"answer"')));
  const p = G.privateView('shizu');
  const s = JSON.stringify(p);
  T('自分のHOは privateView にある', () => assert(s.includes('二十二年前、わたしは娘を産んで')));
  T('他人のHOは privateView に無い', () => assert(!s.includes('胸が動いていた')));
  T('自分の手札だけ privateView にある', () => {
    assert.strictEqual(p.cards.length, 3);
    assert(p.cards.every(c => /^s/.test(c.id)));
  });
  T('遠見だけが命令の選択肢を持つ', () => {
    assert(G.privateView('toomi').canOrder);
    assert(!G.privateView('shizu').canOrder);
  });
  T('鏑木だけが船長権限を持つ', () => {
    assert(G.privateView('kaburagi').authority);
    assert(!G.privateView('mei').authority);
  });
}

console.log('\n── ★命令 ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'shizu', orderId:'q_push:none' } });
  CH.slice(1).forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('命令が登録される', () => assert.strictEqual(G.orders.length, 1));
  T('命令された本人にだけ内容が届く', () => {
    assert(/誰も突き飛ばしていない/.test(txt(G,'shizu')));
    assert(!/誰も突き飛ばしていない/.test(txt(G,'mei')));
  });
  T('「誰が誰に命じたか」は全員に公開', () => assert(/遠見 康一郎が静に何かを命じた/.test(pubText(G))));
  T('命令の中身は公開されない', () => assert(!/突き飛ばしていない/.test(pubText(G))));
  T('privateView に自分宛の命令が入る', () => {
    const o = G.privateView('shizu').myOrders;
    assert.strictEqual(o.length, 1);
    assert(/誰も突き飛ばしていない/.test(o[0].answerLabel));
  });
  T('他人には自分宛の命令として見えない', () => assert.strictEqual(G.privateView('mei').myOrders.length, 0));
}

console.log('\n── ★船長権限 ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'shizu', orderId:'q_push:none' } });
  G.submitMove('kaburagi', { abilityId:'k_auth' });
  G.submitMove('shizu', {}); G.submitMove('mei', {});
  G.resolvePhase();
  T('権限を宣言できる', () => assert.strictEqual(G.authorityDeclared, true));
  T('同じフェーズなら命令はそもそも通らない(権限が先に解決)', () => {
    assert.strictEqual(G.orders.length, 0);
    assert(/もう、命令は通らない/.test(txt(G,'toomi')));
  });
  T('宣言は全員に見える', () => assert(/船長権限を宣言した/.test(pubText(G))));
  T('条文が読み上げられる', () => assert(/船員法第七条/.test(pubText(G))));
  T('★代償として自分の証言が強制公開される', () => {
    assert(G.playedCards.kaburagi.includes('k3'));
    assert(/運んだのはわたしだ/.test(pubText(G)));
  });
  T('宣言後は命令できない', () => {
    G.step = 'main'; G.phaseIdx = 5; // act2
    G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'mei', orderId:'q_kill:toomi' } });
    CH.slice(1).forEach(c => G.submitMove(c, {}));
    G.resolvePhase();
    assert(/もう、命令は通らない/.test(txt(G,'toomi')));
    assert.strictEqual(G.orders.filter(o=>!o.void).length, 0);
  });
}

{
  // 先に命令が通ってから、あとで権限が宣言されるケース
  const G = toPhase(g(), 'act1');
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'shizu', orderId:'q_push:toomi' } });
  ['kaburagi','shizu','mei'].forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('先に命令が成立している', () => assert.strictEqual(G.privateView('shizu').myOrders[0].void, false));
  G.phaseIdx = 5; G.step = 'main';
  G.submitMove('kaburagi', { abilityId:'k_auth' });
  ['toomi','shizu','mei'].forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('★あとから権限を宣言すると、既存の命令が無効になる', () => {
    const o = G.privateView('shizu').myOrders;
    assert(o.length === 1 && o[0].void === true);
  });
  T('無効化されたことは静の画面に伝わる', () =>
    assert.strictEqual(G.privateView('shizu').authorityDeclared, true));
}

console.log('\n── 証言カード ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('kaburagi', { abilityId:'k_card', target:{ cardId:'k1' } });
  G.submitMove('toomi', {}); G.submitMove('shizu', {}); G.submitMove('mei', {});
  G.resolvePhase();
  T('出した証言は全員に見える', () => assert(/船員法第7条/.test(pubText(G))));
  T('出したカードが記録される', () => assert(G.playedCards.kaburagi.includes('k1')));
  T('出していないカードは公開されない', () => assert(!/総トン数24トン、沿海区域を航行中。この条件/.test(pubText(G))));
  T('privateView で出したかどうかが分かる', () => {
    const c = G.privateView('kaburagi').cards;
    assert(c.find(x=>x.id==='k1').played === true);
    assert(c.find(x=>x.id==='k2').played === false);
  });
}

console.log('\n── 問いかけ・思い出す ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('shizu', { abilityId:'s_ask', target:{ charId:'kaburagi', questionId:'a2' } });
  G.submitMove('mei', { abilityId:'m_watch' });
  G.submitMove('toomi', {}); G.submitMove('kaburagi', {});
  G.resolvePhase();
  T('問いかけは全員に聞こえる', () => assert(/お金を受け取っていませんか/.test(pubText(G))));
  T('問われた本人に通知が届く', () => assert(/問いかけられた/.test(txt(G,'kaburagi'))));
  T('芽衣は1回目で「人を運んでいた」と思い出す', () => assert(/人が、人を抱えて運んでいた/.test(txt(G,'mei'))));
  T('思い出した内容は本人だけ', () => assert(!/人を抱えて運んで/.test(pubText(G))));
  G.phaseIdx = 5; G.step = 'main';
  G.submitMove('mei', { abilityId:'m_watch' });
  ['toomi','kaburagi','shizu'].forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  T('2回目でさらに細部を思い出す', () => assert(/男の背格好/.test(txt(G,'mei'))));
}

console.log('\n── ★採点: 真相に全員が到達した場合 ──');
{
  const G = g(); G.phaseIdx = 7; G.step = 'main'; // final
  const truth = { q_where:'toomi', q_push:'shizu', q_kill:'kaburagi', q_witness:'legatee',
                  q_heir:'shizu', q_mei:'daughter', q_valid:'invalid', q_why:'protect', q_illness:'dying' };
  CH.forEach(c => G.submitAnswers(c, { questions: truth, abilities:{}, note:'' }));
  const R = G.score();
  T('遠見: 静がバレたので8pt無し、病気もバレて0pt', () => assert.strictEqual(R.detail.toomi.total, 0));
  T('鏑木: q_push正解6 ／ 自分がバレて5pt無し ／ 権限未宣言0 = 6', () => assert.strictEqual(R.detail.kaburagi.total, 6));
  T('静: 自分がバレて0 ／ q_witness正解5 = 5', () => assert.strictEqual(R.detail.shizu.total, 5));
  T('芽衣: q_kill正解6 ＋ q_mei正解5 = 11', () => assert.strictEqual(R.detail.mei.total, 11));
  T('真相を暴いた芽衣が1位', () => assert.strictEqual(R.winner.id, 'mei'));
  T('エンディングに勝者が入る', () => assert(R.outro.includes(R.winner.name) && !R.outro.includes('{{WINNER}}')));
  T('能力当てのセクションは出ない', () => assert.strictEqual(R.hasAbilityGuess, false));
}

console.log('\n── ★採点: 命令が通り、誰も真相に届かない場合 ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'shizu', orderId:'q_push:toomi' } });
  ['kaburagi','shizu','mei'].forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  G.phaseIdx = 5; G.step = 'main';
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'mei', orderId:'q_kill:toomi' } });
  ['kaburagi','shizu','mei'].forEach(c => G.submitMove(c, {}));
  G.resolvePhase();
  G.phaseIdx = 7; G.step = 'main';
  const wrong = { q_where:'kurose', q_push:'toomi', q_kill:'toomi', q_witness:'trust',
                  q_heir:'nephew', q_mei:'nothing', q_valid:'valid', q_why:'self', q_illness:'fine' };
  CH.forEach(c => G.submitAnswers(c, { questions: wrong, abilities:{}, note:'' }));
  const R = G.score();
  T('遠見: 静を守り抜き8 ＋ 命令2件成立4 ＋ 病気を隠し3 = 15', () => assert.strictEqual(R.detail.toomi.total, 15));
  T('静: 自分がバレず6 ＋ 命令に従い2 = 8', () => assert.strictEqual(R.detail.shizu.total, 8));
  T('芽衣: 命令に従い2 のみ', () => assert.strictEqual(R.detail.mei.total, 2));
  T('鏑木: 自分がバレず5 のみ', () => assert.strictEqual(R.detail.kaburagi.total, 5));
  T('隠し通した遠見が1位', () => assert.strictEqual(R.winner.id, 'toomi'));
  T('内訳に命令の成立数が出る', () =>
    assert(/2\/2 件が守られた/.test(R.detail.toomi.lines.find(l=>/命令に従わせる/.test(l.label)).note)));
}

console.log('\n── ★採点: 権限で命令が無効化された場合 ──');
{
  const G = toPhase(g(), 'act1');
  G.submitMove('toomi', { abilityId:'o_order', target:{ charId:'shizu', orderId:'q_push:toomi' } });
  G.submitMove('kaburagi', { abilityId:'k_auth' });
  G.submitMove('shizu', {}); G.submitMove('mei', {});
  G.resolvePhase();
  G.phaseIdx = 7; G.step = 'main';
  const truth = { q_where:'toomi', q_push:'shizu', q_kill:'kaburagi', q_witness:'legatee',
                  q_heir:'shizu', q_mei:'daughter', q_valid:'invalid', q_why:'protect', q_illness:'dying' };
  CH.forEach(c => G.submitAnswers(c, { questions: truth, abilities:{}, note:'' }));
  const R = G.score();
  T('無効化された命令では遠見に点が入らない', () =>
    assert.strictEqual(R.detail.toomi.lines.find(l=>/命令に従わせる/.test(l.label)).points, 0));
  T('内訳に「無効化された」と出る', () =>
    assert(/無効化された/.test(R.detail.toomi.lines.find(l=>/命令に従わせる/.test(l.label)).note)));
  T('鏑木は権限宣言で3pt(だが自分の罪もバレて5pt無し)', () => {
    const l = R.detail.kaburagi.lines.find(x=>/船長権限/.test(x.label));
    assert.strictEqual(l.points, 3);
    assert.strictEqual(R.detail.kaburagi.total, 9); // 6 + 0 + 3
  });
  T('★権限は「解放するが自分も差し出す」構造になっている', () => {
    assert(G.playedCards.kaburagi.includes('k3')); // 運んだのは自分だと公開済み
  });
}

console.log('\n── ステップ進行 ──');
{
  const G = g();
  const seen = [];
  for (let i = 0; i < 60; i++) {
    seen.push(`${G.phase.id}:${G.step}`);
    if (G.step === 'main' && G.phaseType === 'ability') CH.forEach(c => G.submitMove(c, {}));
    if (G.step === 'main' && G.phaseType === 'final') CH.forEach(c => G.submitAnswers(c, { questions:{}, abilities:{} }));
    if (allReady(G) === 'end') { seen.push('ending'); break; }
  }
  T('「はじめに」から始まる', () => assert.strictEqual(seen[0], 'intro:brief'));
  T('全9フェーズを通る', () =>
    ['intro','read','talk1','act1','talk2','act2','talk3','final'].forEach(p =>
      assert(seen.some(x => x.startsWith(p + ':')), p)));
  T('行動フェーズは 案内→本編→結果 の3段', () =>
    assert(seen.includes('act1:brief') && seen.includes('act1:main') && seen.includes('act1:result')));
  T('最後まで到達する', () => assert.strictEqual(seen[seen.length-1], 'ending'));
  T('1人だけ押しても進まない', () => {
    const G2 = g();
    G2.markReady('toomi');
    assert.strictEqual(G2.step, 'brief');
  });
}

console.log('\n── 既存の『ケーキ』が壊れていないか ──');
{
  const C = new MM.Game('cake');
  T('cake も読み込める', () => assert.strictEqual(C.sc.players.max, 3));
  T('cake には命令の仕組みが無い', () => assert(!C.privateView('natsuki').canOrder));
  T('cake の能力当てプールは健在', () => assert(C.privateView('natsuki').abilityPool.length > 9));
}

console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng ? 1 : 0);
