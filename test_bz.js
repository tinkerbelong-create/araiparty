/* bz_core.js(ドロボウ市場)の検証テスト */
'use strict';
const BZ = require('./bz_core.js');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }

/* ── 1. デッキ構成 ── */
{
  const deck = BZ.buildDeck(BZ.mulberry32(1));
  ok(deck.length === 40, 'デッキ40枚');
  ok(deck.filter(c => c.t === 'coin').length === 22, 'コイン22枚');
  ok(deck.filter(c => c.t === 'gem').length === 12, '宝石12枚');
  ok(deck.filter(c => c.t === 'thief').length === 6, 'ドロボウ6枚');
  ok(new Set(deck.map(c => c.id)).size === 40, 'id重複なし');
  const coinSum = deck.filter(c => c.t === 'coin').reduce((s, c) => s + c.v, 0);
  ok(coinSum === 2*1+3*2+4*3+4*4+3*5+3*6+2*7+8, 'コイン点合計正常');
  ok(deck.filter(c => c.t === 'thief').every(c => c.v <= -3 && c.v >= -5), 'ドロボウは−3〜−5');
  for (const c of BZ.GEM_COLORS) ok(deck.filter(x => x.t === 'gem' && x.c === c).length === 4, `宝石${c}=4枚`);
}

/* ── 2. evalItem(セット完成の価値) ── */
{
  ok(BZ.evalItem({ t: 'coin', v: 6 }, { R: 0, G: 0, B: 0 }) === 6, 'コイン=額面');
  ok(BZ.evalItem({ t: 'thief', v: -4 }, { R: 0, G: 0, B: 0 }) === -4, 'ドロボウ=マイナス');
  ok(BZ.evalItem({ t: 'gem', c: 'R', v: 2 }, { R: 0, G: 1, B: 1 }) === 2 + 7, 'セット完成宝石=9');
  ok(BZ.evalItem({ t: 'gem', c: 'R', v: 2 }, { R: 2, G: 0, B: 0 }) === 2, 'ダブついた色=2');
}

/* ── 3. 解決ロジック: 全ユニーク ── */
{
  const E = new BZ.BZEngine(4, 1);
  E.items = [
    { id: 100, t: 'coin', v: 8 }, { id: 101, t: 'coin', v: 5 },
    { id: 102, t: 'coin', v: 2 }, { id: 103, t: 'thief', v: -4 },
  ];
  const rec = E.resolve([5, 3, 1, 2]); // P0=5(1位), P1=3(2位), P3=2(3位), P2=1(4位)
  ok(rec.gains.length === 4 && rec.clashed.length === 0, '全員取得・ケンカなし');
  const by = p => rec.gains.find(g => g.p === p);
  ok(by(0).item.v === 8, '最高札P0が8点コイン');
  ok(by(1).item.v === 5, '2位P1が5点コイン');
  ok(by(3).item.v === 2, '3位P3が2点コイン');
  ok(by(2).item.t === 'thief' && by(2).points === -4, '最安札P2にドロボウ押し付け');
  ok(E.scores[0] === 8 && E.scores[2] === -4, 'スコア反映(マイナスあり)');
  ok(rec.discarded.length === 0, '流れ品なし');
}

/* ── 4. 解決ロジック: バッティング ── */
{
  const E = new BZ.BZEngine(4, 2);
  E.items = [
    { id: 100, t: 'coin', v: 8 }, { id: 101, t: 'coin', v: 5 },
    { id: 102, t: 'coin', v: 2 }, { id: 103, t: 'thief', v: -4 },
  ];
  const rec = E.resolve([5, 5, 3, 1]); // P0/P1がケンカ
  ok(rec.clashed.sort().join() === '0,1', 'P0,P1がケンカ');
  ok(rec.gains.length === 2, '取得は2人だけ');
  const by = p => rec.gains.find(g => g.p === p);
  ok(by(2).item.v === 8, 'ユニーク最高のP2が8点');
  ok(by(3).item.v === 5, '最安P3も(取得者が減ったので)良品5点を取れる');
  ok(rec.discarded.length === 2 && rec.discarded.some(it => it.t === 'thief'), 'ドロボウ含む2品が流れる(ケンカがドロボウを救う)');
  ok(E.scores[0] === 0 && E.scores[1] === 0, 'ケンカ組は0点のまま');
  // 全員バッティング
  const E2 = new BZ.BZEngine(4, 3);
  E2.items = [{ id: 1, t: 'coin', v: 8 }, { id: 2, t: 'coin', v: 5 }, { id: 3, t: 'coin', v: 2 }, { id: 4, t: 'thief', v: -4 }];
  const rec2 = E2.resolve([2, 2, 2, 2]);
  ok(rec2.gains.length === 0 && rec2.clashed.length === 4 && rec2.discarded.length === 4, '全員ケンカ→全品流れ(ドロボウも回避)');
}

/* ── 5. 宝石セットボーナス ── */
{
  const E = new BZ.BZEngine(2, 4);
  E.gems[0] = { R: 1, G: 1, B: 0 };
  E.items = [{ id: 1, t: 'gem', c: 'B', v: 2 }, { id: 2, t: 'coin', v: 3 }];
  const rec = E.resolve([5, 1]);
  const g0 = rec.gains.find(g => g.p === 0);
  ok(g0.item.t === 'gem' && g0.setDone && g0.points === 2 + 7, 'セット完成で+9(宝石2+ボーナス7)');
  ok(E.sets[0] === 1, 'セット数記録');
  // 自動取得がコイン3よりセット完成宝石(評価9)を選んだことも確認済み
}

/* ── 6. 値札の消費と一巡 ── */
{
  const E = new BZ.BZEngine(3, 5);
  const played = [[], [], []];
  for (let r = 1; r <= 5; r++) {
    const subs = E.tokens.map(t => t[0]); // 各自残り最小を出す
    subs.forEach((t, p) => played[p].push(t));
    E.resolve(subs);
  }
  ok(E.round === 6, '5ラウンド消化');
  ok(E.tokens.every(t => t.length === 5), '5R後に値札一巡(1〜5補充)');
  played.forEach((ts, p) => ok(new Set(ts).size === 5, `P${p}は5枚全部使った`));
  // 不正: 使用済み札
  const E2 = new BZ.BZEngine(2, 6);
  E2.resolve([3, 4]);
  let threw = false;
  try { E2.resolve([3, 2]); } catch (e) { threw = true; }
  ok(threw, '使用済み値札はエラー');
}

/* ── 7. 勝敗判定(タイブレーク) ── */
{
  const E = new BZ.BZEngine(3, 7);
  E.scores = [10, 10, 5];
  E.gems = [{ R: 1, G: 0, B: 0 }, { R: 2, G: 1, B: 0 }, { R: 0, G: 0, B: 0 }];
  E.thieves = [0, 0, 0];
  const res = E.result();
  ok(res.winners.length === 1 && res.winners[0] === 1, '同点は宝石数で決着');
  E.gems[0] = { R: 2, G: 1, B: 0 };
  E.thieves = [1, 0, 0];
  const res2 = E.result();
  ok(res2.winners[0] === 1, '宝石も同数ならドロボウ少ない方');
  E.thieves = [0, 0, 0];
  const res3 = E.result();
  ok(res3.winners.length === 2, '完全同着は引き分け');
}

/* ── 8. 1000ゲーム自動対戦(2〜4人) ── */
{
  const winsBySeat = { 2: [0,0], 3: [0,0,0], 4: [0,0,0,0] };
  for (let g = 0; g < 1000; g++) {
    const n = 2 + (g % 3);
    const E = new BZ.BZEngine(n, g * 613 + 7);
    const brains = Array.from({ length: n }, (_, i) => new BZ.BZBrain(BZ.mulberry32(g * 31 + i)));
    while (!E.finished) {
      const subs = brains.map((b, i) => b.choose(E, i));
      subs.forEach((t, p) => { if (!E.tokens[p].includes(t)) throw new Error('CPUが不正な札'); });
      E.resolve(subs);
    }
    if (E.log.length !== BZ.ROUNDS) throw new Error('ラウンド数不正');
    // 整合: 最終スコア = ログの合計
    for (let p = 0; p < n; p++) {
      const sum = E.log.reduce((s, rec) => {
        const gg = rec.gains.find(x => x.p === p);
        return s + (gg ? gg.points : 0);
      }, 0);
      if (sum !== E.scores[p]) throw new Error('スコア集計不一致');
    }
    const res = E.result();
    res.winners.forEach(w => winsBySeat[n][w]++);
  }
  ok(true, '1000ゲーム完走・スコア整合');
  console.log('席順別勝率(有利不利チェック):');
  for (const n of [2, 3, 4]) console.log(`  ${n}人戦: [${winsBySeat[n].join(', ')}]`);
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
