/* マダミス通しテスト — 進行・能力解決・採点・秘匿性を検証 */
'use strict';
const assert = require('assert');
const MM = require('./mm_core.js');

let ok = 0, ng = 0;
const T = (name, fn) => { try { fn(); ok++; console.log('  ✅', name); } catch (e) { ng++; console.log('  ❌', name, '\n     ', e.message); } };

console.log('\n── シナリオ読み込み ──');
const list = MM.listScenarios();
T('シナリオが1件以上ある', () => assert(list.length >= 1));
T('cake がある', () => assert(list.some(s => s.id === 'cake')));

const g = () => {
  const x = new MM.Game('cake');
  x.assign = { natsuki: 0, ryusei: 1, kaito: 2 };
  return x;
};

console.log('\n── 秘匿性(publicView に漏れがないこと) ──');
{
  const G = g();
  const pub = JSON.stringify(G.publicView());
  T('他人のHO本文が publicView に無い', () => assert(!pub.includes('ケーキを取る方法を真剣に考えて')));
  T('真相タイムラインが publicView に無い', () => assert(!pub.includes('偽物のケーキを冷蔵庫に設置')));
  T('場所の手がかりが publicView に無い', () => assert(!pub.includes('電源コードが、コンセントから抜けて')));
  T('能力の中身が publicView に無い', () => assert(!pub.includes('壁を手だけすり抜け')));
  T('正解が publicView に無い', () => assert(!pub.includes('"answer"')));
}
{
  const G = g();
  G.phaseIdx = 6; // final
  const priv = JSON.stringify(G.privateView('natsuki'));
  T('自分のHOは privateView にある', () => assert(priv.includes('ケーキを取る方法を真剣に考えて')));
  T('他人のHOは privateView に無い', () => assert(!priv.includes('おれの能力を最大限使う')));
  T('真相は privateView に無い', () => assert(!priv.includes('偽物のケーキを冷蔵庫に設置')));
  T('最終設問の正解は privateView に無い', () => {
    const p = G.privateView('natsuki');
    p.finalQuestions.forEach(q => assert(q.answer === undefined));
  });
}

console.log('\n── 能力解決 ──');
{
  const G = g();
  G.phaseIdx = 2; // act1
  G.submitMove('natsuki', { abilityId: 'n1', target: { placeId: 'fridge' } });
  G.submitMove('ryusei',  { abilityId: 'r3', target: { placeId: 'fridge' } });
  G.submitMove('kaito',   { abilityId: 'k2', target: { charId: 'natsuki' } });
  T('全員行動済み', () => assert(G.allMoved()));
  const r = G.resolvePhase();
  T('ナツキ: 暗い冷蔵庫にはすり抜けられない', () => assert(/暗い/.test(r.natsuki[0].text)));
  T('失敗時は使用回数が戻る', () => assert.strictEqual(G.used.natsuki, 0));
  T('リュウセイ: カメラで誰か来たのを検知', () => assert(/動いている|来ている/.test(r.ryusei[0].text)));
  T('リュウセイ: 暗いので人物は特定できない', () => assert(!/ナツキ/.test(r.ryusei[0].text)));
  T('カイト: キーワードを1つ入手', () => assert(/「(すり抜け|コピー\(能力\)|同化)」/.test(r.kaito[0].text)));
  T('カイトの取得キーワードが記録される', () => assert.strictEqual(G.known.kaito.length, 1));
}
{
  const G = g();
  G.phaseIdx = 2;
  G.submitMove('kaito',  { abilityId: 'k1', target: { doorId: 'fridge' } });
  G.submitMove('natsuki',{ abilityId: 'n3', target: { placeId: 'r_ryusei' } });
  G.submitMove('ryusei', { abilityId: 'r2', target: { objId: 'jewel', placeId: 'r_ryusei' } });
  const r = G.resolvePhase();
  T('カイト: 扉を開けても電源が無いので暗いまま', () => assert(/電源が入っていない/.test(r.kaito[0].text)));
  T('ナツキ: 同化でリュウセイの部屋の手がかりを得る', () => assert(/紙コップが異様に多い/.test(r.natsuki[0].text)));
  T('ナツキ: 同じ場所に来たリュウセイを検知', () => assert(/リュウセイ/.test(r.natsuki[0].text)));
  T('ナツキ: 置かれた偽物も見える', () => assert(/宝石/.test(r.natsuki[0].text)));
  T('偽物を置いた本人には二重表示されない', () => assert(!/さらに——/.test(r.ryusei[0].text)));
}
{
  const G = g();
  G.phaseIdx = 2;
  G.submitMove('natsuki', { abilityId: 'n2', target: { charId: 'kaito', abilityId: 'k1' } });
  G.resolvePhase();
  T('コピー成功で copied にセット', () => assert.strictEqual(G.copied.natsuki, 'k1'));
  G.phaseIdx = 4;
  T('コピー能力は privateView の能力一覧に出る', () => {
    const p = G.privateView('natsuki');
    assert(p.character.abilities.some(a => a.id === 'k1' && a.copied));
  });
  const r2 = G.submitMove('natsuki', { abilityId: 'k1', target: { doorId: 'genkan' } });
  T('コピー能力を使える', () => assert(r2.ok));
  G.resolvePhase();
  T('コピー使用は通常の使用回数を消費しない', () => assert.strictEqual(G.used.natsuki, 1)); // n2 の1回のみ
}
{
  const G = g();
  G.phaseIdx = 2;
  G.submitMove('kaito', { abilityId: 'k3', target: {} });
  const r = G.resolvePhase();
  T('カイトの「消す」は月1回制限で使えない', () => assert(/今月の分はもう使ってしまった/.test(r.kaito[0].text)));
  T('使えなかったので回数は減らない', () => assert.strictEqual(G.used.kaito, 0));
}
{
  const G = g();
  G.phaseIdx = 2;
  G.submitMove('natsuki', { abilityId: 'n1', target: { placeId: 'r_kaito' } });
  G.resolvePhase();
  G.phaseIdx = 4;
  G.submitMove('natsuki', { abilityId: 'n3', target: { placeId: 'kitchen' } });
  G.resolvePhase();
  T('使用回数の上限は2回', () => {
    G.phaseIdx = 5;
    const r = G.submitMove('natsuki', { abilityId: 'n1', target: { placeId: 'living' } });
    assert(!r.ok);
  });
  T('ログが2件たまっている', () => assert.strictEqual(G.log.natsuki.length, 2));
  T('カイトの部屋: 匂いがしない手がかり', () => assert(/匂いがしない/.test(G.log.natsuki[0].text)));
  T('キッチン: 電源コードの手がかり', () => assert(/電源コード/.test(G.log.natsuki[1].text)));
}

console.log('\n── 採点 ──');
{
  // 全員が完璧に真相を当てたケース
  const G = g();
  G.phaseIdx = 6;
  const perfect = { q_eater:'ryusei', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions: perfect, abilities: { ryusei:['r1','r2','r3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('ryusei',  { questions: perfect, abilities: { natsuki:['n1','n2','n3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('kaito',   { questions: perfect, abilities: { natsuki:['n1','n2','n3'], ryusei:['r1','r2','r3'] } });
  const R = G.score();
  const d = R.detail;
  T('ナツキ: 5+3+1+0 = 9', () => assert.strictEqual(d.natsuki.total, 9));
  T('リュウセイ: 指摘されたので5pt無し / 3+2+2 = 7', () => assert.strictEqual(d.ryusei.total, 7));
  T('カイト: 誰にも指摘されず5 +3 +能力当て(6正解→3pt) = 11', () => assert.strictEqual(d.kaito.total, 11));
  T('全員バレたので能力秘匿は0', () => {
    Object.values(d).forEach(x => {
      const l = x.lines.find(y => /能力がバレない/.test(y.label));
      assert.strictEqual(l.points, 0);
    });
  });
  T('勝者が決まる', () => assert.strictEqual(R.winner.id, 'kaito'));
  T('outro に勝者名が入る', () => assert(R.outro.includes('カイト') && !R.outro.includes('{{WINNER}}')));
}
{
  // 誰も真相に届かなかったケース(リュウセイ完全勝利)
  const G = g();
  G.phaseIdx = 6;
  G.submitAnswers('natsuki', { questions:{ q_eater:'kaito', q_fake:'none', q_taste:'b', q_jewel:'c', q_fail:'c', q_sound1:'b', q_sound2:'b' }, abilities:{} });
  G.submitAnswers('ryusei',  { questions:{ q_eater:'kaito', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' }, abilities:{} });
  G.submitAnswers('kaito',   { questions:{ q_eater:'natsuki', q_fake:'none', q_taste:'c', q_jewel:'d', q_fail:'b', q_sound1:'c', q_sound2:'c' }, abilities:{} });
  const R = G.score();
  T('リュウセイ: ばれず5 +偽物3 +音2+2 +能力3つ秘匿6 = 18', () => assert.strictEqual(R.detail.ryusei.total, 18));
  T('カイトは2人に指摘されたので0 +能力秘匿6 = 6', () => assert.strictEqual(R.detail.kaito.total, 6));
  T('ナツキは全外しでも能力秘匿6', () => assert.strictEqual(R.detail.natsuki.total, 6));
  T('勝者はリュウセイ', () => assert.strictEqual(R.winner.id, 'ryusei'));
}
{
  // 能力秘匿の部分判定
  const G = g();
  G.phaseIdx = 6;
  const q = { q_eater:'none', q_fake:'none', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions:q, abilities:{ ryusei:['r1','x1','x2'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('ryusei',  { questions:q, abilities:{ natsuki:['x1','x2','x3'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('kaito',   { questions:q, abilities:{ natsuki:['x1','x2','x3'], ryusei:['x1','x2','x3'] } });
  const R = G.score();
  T('ナツキ: 誰にも当てられず 3能力×2 = 6pt', () => {
    const l = R.detail.natsuki.lines.find(y => /能力がバレない/.test(y.label));
    assert.strictEqual(l.points, 6);
  });
  T('リュウセイ: r1だけバレて 2能力×2 = 4pt', () => {
    const l = R.detail.ryusei.lines.find(y => /能力がバレない/.test(y.label));
    assert.strictEqual(l.points, 4);
  });
  T('カイト: 能力当ては0正解 → 0pt', () => {
    const l = R.detail.kaito.lines.find(y => /相手の能力を当てる/.test(y.label));
    assert.strictEqual(l.points, 0);
  });
  T('答え合わせに exposed が入る', () => {
    const r = R.abilityReveal.find(c => c.id === 'ryusei');
    assert.strictEqual(r.abilities.find(a => a.keyword === '水').exposed, true);
    assert.strictEqual(r.abilities.find(a => a.keyword === 'カメラ').exposed, false);
  });
}

console.log('\n── フェーズ進行 ──');
{
  const G = g();
  const seen = [];
  while (G.advance()) seen.push(G.phase.type);
  T('read→discuss→ability→…→final→ending の順に進む', () =>
    assert.deepStrictEqual(seen, ['read','discuss','ability','discuss','ability','discuss','final','ending']));
  T('最後まで行くと advance が false', () => assert.strictEqual(G.advance(), false));
}

console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng ? 1 : 0);
