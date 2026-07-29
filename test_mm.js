/* マダミス通しテスト — 進行・行動解決・能力の役割・採点・秘匿性を検証 */
'use strict';
const assert = require('assert');
const MM = require('./mm_core.js');

let ok = 0, ng = 0;
const T = (name, fn) => { try { fn(); ok++; console.log('  ✅', name); } catch (e) { ng++; console.log('  ❌', name, '\n     ', e.message); } };

const g = () => { const x = new MM.Game('cake'); x.assign = { natsuki:0, ryusei:1, kaito:2 }; return x; };
const ACT = (G, moves) => { G.phaseIdx = G.phaseIdx < 0 ? 2 : G.phaseIdx; Object.entries(moves).forEach(([c,m]) => G.submitMove(c,m)); return G.resolvePhase(); };
const txt = (r, cid) => (r[cid]||[]).map(x => x.title + '｜' + x.text).join('\n');

console.log('\n── シナリオ読み込み ──');
T('cake がある', () => assert(MM.listScenarios().some(s => s.id === 'cake')));

console.log('\n── 秘匿性 ──');
{
  const G = g();
  const pub = JSON.stringify(G.publicView());
  T('他人のHO本文が publicView に無い', () => assert(!pub.includes('ケーキを取る方法を真剣に考えて')));
  T('真相が publicView に無い', () => assert(!pub.includes('偽物のケーキを冷蔵庫に設置')));
  T('場所の手がかりが publicView に無い', () => assert(!pub.includes('コンセントから抜けて')));
  T('能力の中身が publicView に無い', () => assert(!pub.includes('壁を手だけすり抜け')));
  T('正解が publicView に無い', () => assert(!pub.includes('"answer"')));
  G.phaseIdx = 6;
  const priv = JSON.stringify(G.privateView('natsuki'));
  T('自分のHOは privateView にある', () => assert(priv.includes('ケーキを取る方法を真剣に考えて')));
  T('他人のHOは privateView に無い', () => assert(!priv.includes('おれの能力を最大限使う')));
  T('真相は privateView に無い', () => assert(!priv.includes('偽物のケーキを冷蔵庫に設置')));
  T('最終設問の正解は privateView に無い', () =>
    G.privateView('natsuki').finalQuestions.forEach(q => assert(q.answer === undefined)));
  T('コピー候補にはダミーも混ざる(実在9個だけを見せない)', () => {
    const p = G.privateView('natsuki').abilityPool;
    assert(p.length > 9 && p.some(x => /^x/.test(x.id)));
  });
}

console.log('\n── 基本: 全員が「1か所を調べる」 ──');
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, {
    natsuki:{ placeId:'r_ryusei' }, ryusei:{ placeId:'r_kaito' }, kaito:{ placeId:'living' },
  });
  T('能力を使わなくても調査できる', () => assert(/紙コップが異様に多い/.test(txt(r,'natsuki'))));
  T('決定打(甘い匂いの紙ナプキン)に到達できる', () => assert(/甘い匂い/.test(txt(r,'natsuki'))));
  T('カイトの部屋: 匂いのしない皿', () => assert(/匂いがしない/.test(txt(r,'ryusei'))));
  T('リビング: 破片のない宝石の跡', () => assert(/破片/.test(txt(r,'kaito'))));
  T('調査だけなら能力回数は減らない', () => assert.strictEqual(G.used.natsuki, 0));
}

console.log('\n── ドア閉め(カイト)の役割: 他人の調査を封じる ──');
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { kaito:{ placeId:'living', abilityId:'k1', target:{doorId:'r_kaito'} }, natsuki:{ placeId:'kitchen' }, ryusei:{ placeId:'dining' } });
  T('カイトが自室のドアを閉められる', () => assert.strictEqual(G.doors.r_kaito, 'closed'));
  T('閉めたことは全員に伝わる', () => assert(G.publicLog.some(l => /カイトの部屋のドアが閉まっている/.test(l.text))));
  G.phaseIdx = 4;
  const r = ACT(G, { natsuki:{ placeId:'r_kaito' }, ryusei:{ placeId:'r_kaito' }, kaito:{ placeId:'toilet' } });
  T('閉まった部屋は調べられない', () => assert(/中に入れなかった/.test(txt(r,'natsuki'))));
  T('決定的証拠(匂いのしない皿)が守られる', () => assert(!/匂いがしない/.test(txt(r,'ryusei'))));
}

console.log('\n── すり抜け(ナツキ)の役割: 閉ざされた場所への対抗手段 ──');
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { kaito:{ placeId:'living', abilityId:'k1', target:{doorId:'r_kaito'} }, natsuki:{ placeId:'kitchen' }, ryusei:{ placeId:'dining' } });
  G.phaseIdx = 4;
  const r = ACT(G, { natsuki:{ placeId:'kitchen', abilityId:'n1', target:{placeId:'r_kaito'} }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('ドアが閉まっていても手だけは届く', () => assert(/匂いがしない/.test(txt(r,'natsuki'))));
  T('すり抜けは能力回数を消費する', () => assert.strictEqual(G.used.natsuki, 1));
}

console.log('\n── 明るさ: ナツキのミッション④「取れなかった原因」 ──');
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { natsuki:{ placeId:'dining', abilityId:'n1', target:{placeId:'fridge'} }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('暗い冷蔵庫にはすり抜けられない', () => assert(/暗い/.test(txt(r,'natsuki'))));
  T('失敗した能力は回数を消費しない', () => assert.strictEqual(G.used.natsuki, 0));
  T('「そういうことだったのか」と原因に気づける', () => assert(/そういうことだったのか/.test(txt(r,'natsuki'))));
}
{
  // 電源を挿し直す → 冷蔵庫の扉を開ける → すり抜けられる
  const G = g(); G.phaseIdx = 2;
  const r1 = ACT(G, { natsuki:{ placeId:'kitchen', extra:'action' }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('キッチンで電源コードを挿し直せる', () => assert(G.fridgePower === true));
  T('挿したことは全員に伝わる', () => assert(G.publicLog.some(l => /電源が入っている/.test(l.text))));
  T('キッチンの手がかりも同時に得られる', () => assert(/電源コードが、コンセントから抜けて/.test(txt(r1,'natsuki'))));
  G.phaseIdx = 4;
  const r2 = ACT(G, { ryusei:{ placeId:'fridge' }, natsuki:{ placeId:'dining', abilityId:'n1', target:{placeId:'fridge'} }, kaito:{ placeId:'toilet' } });
  T('誰かが冷蔵庫を開ければ庫内が明るくなり、すり抜けが通る', () => assert(/クリームの跡/.test(txt(r2,'natsuki'))));
}

console.log('\n── カメラ(リュウセイ)の役割: 行かない場所の人の動きを掴む ──');
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { ryusei:{ placeId:'toilet' }, natsuki:{ placeId:'r_ryusei' }, kaito:{ placeId:'living' } });
  T('開始時から冷蔵庫のカメラが生きている(21:40に仕込んだもの)', () => assert(/カメラの映像/.test(txt(r,'ryusei'))));
  T('冷蔵庫に誰も来なければ「誰も来なかった」', () => assert(/誰も来なかった/.test(txt(r,'ryusei'))));
}
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { ryusei:{ placeId:'toilet', abilityId:'r3', target:{placeId:'r_ryusei'} }, natsuki:{ placeId:'r_ryusei' }, kaito:{ placeId:'living' } });
  T('自室にカメラを仕込むと、来訪者を掴める', () => assert(/ナツキが来ている/.test(txt(r,'ryusei'))));
}
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { ryusei:{ placeId:'toilet' }, natsuki:{ placeId:'fridge' }, kaito:{ placeId:'living' } });
  T('暗い冷蔵庫では人物が特定できない', () => assert(/暗くて、誰かまでは分からない/.test(txt(r,'ryusei'))));
  T('明るくないので名前は出ない', () => assert(!/ナツキが来ている/.test(txt(r,'ryusei'))));
}
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { natsuki:{ placeId:'fridge' }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('冷蔵庫を調べるとリュウセイのカメラが見つかる(犯人のリスク)', () => assert(/黒い異物/.test(txt(r,'natsuki'))));
}

console.log('\n── 水(リュウセイ)の役割: 証拠隠滅 ──');
{
  const G = g(); G.phaseIdx = 2;
  const r1 = ACT(G, { ryusei:{ placeId:'r_ryusei', abilityId:'r1' }, natsuki:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('自室の手がかりを洗い流せる', () => assert(/もう誰にも見つからない/.test(txt(r1,'ryusei'))));
  G.phaseIdx = 4;
  const r2 = ACT(G, { natsuki:{ placeId:'r_ryusei' }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('以後そこを調べても決定打が出ない', () => assert(!/甘い匂い/.test(txt(r2,'natsuki'))));
  T('代わりに「濡れている」だけが残る', () => assert(/濡れている/.test(txt(r2,'natsuki'))));
}

console.log('\n── 偽物(リュウセイ)の役割: 他人の調査結果を汚染する ──');
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { ryusei:{ placeId:'toilet', abilityId:'r2', target:{objId:'napkin', placeId:'r_kaito'} }, natsuki:{ placeId:'living' }, kaito:{ placeId:'living' } });
  G.phaseIdx = 4;
  const r = ACT(G, { natsuki:{ placeId:'r_kaito' }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('調べた人には偽の証拠が混ざって見える', () => assert(/丸めた紙ナプキン/.test(txt(r,'natsuki'))));
  T('置いた本人の目には二重に映らない', () => {
    const G2 = g(); G2.phaseIdx = 2;
    const r2 = ACT(G2, { ryusei:{ placeId:'living', abilityId:'r2', target:{objId:'jewel', placeId:'living'} }, natsuki:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
    assert(!/そして——/.test(txt(r2,'ryusei')));
  });
}

console.log('\n── キーワード(カイト)の役割 ──');
{
  const G = g();
  T('HOに書かれた既知キーワードが最初から入っている', () => {
    assert.strictEqual(G.known.kaito.length, 2);
    assert(G.known.kaito.some(k => k.abilityId === 'n1')); // すり抜け
    assert(G.known.kaito.some(k => k.abilityId === 'r3')); // カメラ
  });
  G.phaseIdx = 2;
  const r = ACT(G, { kaito:{ placeId:'toilet', abilityId:'k2', target:{charId:'natsuki'} }, natsuki:{ placeId:'toilet' }, ryusei:{ placeId:'toilet' } });
  T('既知のものは重複して出ない', () => assert(!/「すり抜け」/.test(txt(r,'kaito'))));
  T('残り2つのどちらかが手に入る', () => assert(/「(コピー\(能力\)|同化)」/.test(txt(r,'kaito'))));
}
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { kaito:{ placeId:'toilet', abilityId:'k2', target:{charId:'natsuki'} }, natsuki:{ placeId:'toilet' }, ryusei:{ placeId:'toilet' } });
  G.phaseIdx = 4;
  ACT(G, { kaito:{ placeId:'toilet', abilityId:'k2', target:{charId:'natsuki'} }, natsuki:{ placeId:'toilet' }, ryusei:{ placeId:'toilet' } });
  T('2回使えばナツキの能力を全部掴める', () => assert.strictEqual(G.known.kaito.filter(k=>k.char==='natsuki').length, 3));
}

console.log('\n── 消す(カイト)は月1回制限で使えない ──');
{
  const G = g(); G.phaseIdx = 2;
  const r = G.submitMove('kaito', { placeId:'toilet', abilityId:'k3' });
  T('そもそも提出が弾かれる', () => assert(!r.ok));
  T('privateView で「使えない」と分かる', () => assert.strictEqual(G.privateView('kaito').abilityActions.k3.usable, false));
}

console.log('\n── コピー(ナツキ) ──');
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { natsuki:{ placeId:'toilet', abilityId:'n2', target:{charId:'kaito', abilityId:'k1'} }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('言い当てればコピー成功', () => assert.strictEqual(G.copied.natsuki, 'k1'));
  G.phaseIdx = 4;
  T('コピー能力が選択肢に出る', () => assert(G.privateView('natsuki').character.abilities.some(a=>a.id==='k1'&&a.copied)));
  ACT(G, { natsuki:{ placeId:'toilet', abilityId:'k1', target:{doorId:'r_kaito'} }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('コピー能力を実際に使える', () => assert.strictEqual(G.doors.r_kaito, 'closed'));
  T('コピー使用は回数を消費しない(n2の1回のみ)', () => assert.strictEqual(G.used.natsuki, 1));
}
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { natsuki:{ placeId:'toilet', abilityId:'n2', target:{charId:'kaito', abilityId:'r1'} }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('外れたら失敗し、回数だけ減る(賭けとして成立)', () => {
    assert(/何も起きなかった/.test(txt(r,'natsuki')));
    assert.strictEqual(G.used.natsuki, 1);
  });
}

console.log('\n── 同化(ナツキ)の役割: 目撃者になる ──');
{
  const G = g(); G.phaseIdx = 2;
  const r = ACT(G, { natsuki:{ placeId:'kitchen', abilityId:'n3' }, ryusei:{ placeId:'kitchen' }, kaito:{ placeId:'living' } });
  T('同じ場所に来た人を目撃できる', () => assert(/リュウセイ/.test(txt(r,'natsuki'))));
  T('来なかった人は映らない', () => assert(!/カイト/.test(txt(r,'natsuki'))));
  T('同化した場所の手がかりも得られる', () => assert(/電源コード/.test(txt(r,'natsuki'))));
}

console.log('\n── 使用回数と公開情報 ──');
{
  const G = g(); G.phaseIdx = 2;
  ACT(G, { natsuki:{ placeId:'toilet', abilityId:'n3' }, ryusei:{ placeId:'toilet' }, kaito:{ placeId:'toilet' } });
  T('能力を使った人は全員に伝わる', () => assert(G.publicLog.some(l => /ナツキが能力を使った/.test(l.text))));
  T('使っていない人は名前が出ない', () => {
    const l = G.publicLog.filter(x => /能力を使った/.test(x.text)).pop();
    assert(!/リュウセイ/.test(l.text));
  });
  G.phaseIdx = 4;
  G.used.natsuki = 2; // 2回使い切った状態
  T('使い切ったら能力つきの行動は提出できない', () =>
    assert(!G.submitMove('natsuki', { placeId:'toilet', abilityId:'n1', target:{placeId:'living'} }).ok));
  T('使い切っても調査だけはできる', () => assert(G.submitMove('natsuki', { placeId:'toilet' }).ok));
}
{
  const G = g(); G.phaseIdx = 2;
  T('場所を選ばないと提出できない', () => assert(!G.submitMove('natsuki', { abilityId:'n3' }).ok));
}

console.log('\n── 採点 ──');
{
  const G = g(); G.phaseIdx = 6;
  const perfect = { q_eater:'ryusei', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions:perfect, abilities:{ ryusei:['r1','r2','r3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('ryusei',  { questions:perfect, abilities:{ natsuki:['n1','n2','n3'], kaito:['k1','k2','k3'] } });
  G.submitAnswers('kaito',   { questions:perfect, abilities:{ natsuki:['n1','n2','n3'], ryusei:['r1','r2','r3'] } });
  const R = G.score();
  T('ナツキ 5+3+1 = 9', () => assert.strictEqual(R.detail.natsuki.total, 9));
  T('リュウセイ 3+2+2 = 7(指摘されて5pt無し)', () => assert.strictEqual(R.detail.ryusei.total, 7));
  T('カイト 5+3+3 = 11', () => assert.strictEqual(R.detail.kaito.total, 11));
  T('勝者が決まり outro に名前が入る', () => assert(R.outro.includes(R.winner.name) && !R.outro.includes('{{WINNER}}')));
}
{
  const G = g(); G.phaseIdx = 6;
  G.submitAnswers('natsuki', { questions:{ q_eater:'kaito', q_fake:'none', q_taste:'b', q_jewel:'c', q_fail:'c', q_sound1:'b', q_sound2:'b' }, abilities:{} });
  G.submitAnswers('ryusei',  { questions:{ q_eater:'kaito', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' }, abilities:{} });
  G.submitAnswers('kaito',   { questions:{ q_eater:'natsuki', q_fake:'none', q_taste:'c', q_jewel:'d', q_fail:'b', q_sound1:'c', q_sound2:'c' }, abilities:{} });
  const R = G.score();
  T('誰も真相に届かないとリュウセイ完全勝利(18pt)', () => assert.strictEqual(R.detail.ryusei.total, 18));
  T('勝者はリュウセイ', () => assert.strictEqual(R.winner.id, 'ryusei'));
}
{
  const G = g(); G.phaseIdx = 6;
  const q = { q_eater:'none', q_fake:'none', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  G.submitAnswers('natsuki', { questions:q, abilities:{ ryusei:['r1','x1','x2'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('ryusei',  { questions:q, abilities:{ natsuki:['x1','x2','x3'], kaito:['x3','x4','x5'] } });
  G.submitAnswers('kaito',   { questions:q, abilities:{ natsuki:['x1','x2','x3'], ryusei:['x1','x2','x3'] } });
  const R = G.score();
  T('誰にも当てられなければ 3能力×2 = 6pt', () =>
    assert.strictEqual(R.detail.natsuki.lines.find(y=>/能力がバレない/.test(y.label)).points, 6));
  T('1つバレたら 2能力×2 = 4pt', () =>
    assert.strictEqual(R.detail.ryusei.lines.find(y=>/能力がバレない/.test(y.label)).points, 4));
  T('答え合わせに exposed が入る', () => {
    const r = R.abilityReveal.find(c=>c.id==='ryusei');
    assert.strictEqual(r.abilities.find(a=>a.keyword==='水').exposed, true);
    assert.strictEqual(r.abilities.find(a=>a.keyword==='カメラ').exposed, false);
  });
}

console.log('\n── フェーズ進行 ──');
{
  const G = g(); const seen = [];
  while (G.advance()) seen.push(G.phase.type);
  T('read→discuss→行動→discuss→行動→discuss→final→ending', () =>
    assert.deepStrictEqual(seen, ['read','discuss','ability','discuss','ability','discuss','final','ending']));
}

console.log(`\n結果: ${ok} 成功 / ${ng} 失敗\n`);
process.exit(ng ? 1 : 0);
