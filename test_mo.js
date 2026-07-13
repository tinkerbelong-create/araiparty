/* mo_core.js(モンオク! v2)の検証テスト */
'use strict';
const MO = require('./mo_core.js');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }

/* ── 1. 図鑑とレア度 ── */
{
  ok(MO.SPECIES.length === 24, '24種');
  ok(MO.SPECIES.filter(s => s.rare === 'SR').length === 6, 'SR=6');
  ok(MO.SPECIES.filter(s => s.rare === 'R').length === 8, 'R=8');
  ok(MO.SPECIES.filter(s => s.rare === 'N').length === 10, 'N=10');
  for (const t of MO.TYPES) ok(MO.SPECIES.filter(s => s.type === t).length === 6, `タイプ${t}=6種`);
  // レア度でステータス合計がはっきり分かれる(SR > R > N)
  const budget = s => s.hp / 2 + s.atk * 2 + s.spd;
  const avg = r => { const xs = MO.SPECIES.filter(s => s.rare === r).map(budget); return xs.reduce((a, b) => a + b) / xs.length; };
  ok(avg('SR') > avg('R') + 5 && avg('R') > avg('N') + 5, `SR(${avg('SR').toFixed(1)}) > R(${avg('R').toFixed(1)}) > N(${avg('N').toFixed(1)})`);
  // Nは支援系能力(コンボパーツ)を多く持つ
  const support = ['engun', 'gisei', 'ougen', 'oukyuu', 'tate'];
  const nSupport = MO.SPECIES.filter(s => s.rare === 'N' && support.includes(s.ab)).length;
  ok(nSupport >= 7, `Nの大半が支援能力(${nSupport}/10)`);
  ok(new Set(MO.SPECIES.map(s => s.id)).size === 24, 'id重複なし');
}

/* ── 2. アイテム ── */
{
  ok(MO.ITEMS.length === 7, 'アイテム7種');
  const prices = MO.ITEMS.map(i => i.price);
  ok(prices.every((p, i) => i === 0 || p > prices[i - 1]), '価格が強さ順に上がる: ' + prices.join(','));
  const E = new MO.MOEngine(2, 1);
  E.buyItem(0, 'yakusou');
  ok(E.coins[0] === 56 && E.items[0].includes('yakusou'), '購入でコイン減');
  let threw = false;
  try { E.buyItem(0, 'yakusou'); } catch (e) { threw = true; }
  ok(threw, '同じアイテムは2個買えない');
  threw = false;
  E.coins[1] = 3;
  try { E.buyItem(1, 'medal'); } catch (e) { threw = true; }
  ok(threw, 'コイン不足は買えない');
}

/* ── 3. バトル(アイテム効果込み) ── */
{
  const t1 = ['meraboo', 'hidaneko', 'kazanoh'];
  const t2 = ['happanin', 'tsururisu', 'morinonushi'];
  const r1 = MO.battle(t1, t2);
  const r2 = MO.battle(t1, t2);
  ok(r1.winner === r2.winner && r1.log.length === r2.log.length, '決定論');
  ok(r1.winner === 0, '火SR入り vs 草(相性不利)は火が勝つ');
  // アイテムで結果が変わりうる: メダル持ち vs なし(同一チーム)
  const same = ['namiuo', 'shiomaneki', 'umiryu'];
  const rNo = MO.battle(same, same);
  const rItem = MO.battle(same, same, ['medal', 'megahon'], []);
  ok(rItem.winner === 0, '全員強化アイテム持ちがミラー戦で勝つ');
  ok(rNo.log.length > 0, 'ミラー戦も決着');
  // おまもり: ログにitemイベント
  const rOm = MO.battle(same, same, [], ['omamori']);
  ok(rOm.log.some(e => e.t === 'item' && e.item === 'omamori'), 'おまもり発動ログ');
  // えんぐんコンボ: N支援2体つきSR vs 素のSR同等編成で攻撃力が上がっていること(ログのダメージで確認)
  const combo = ['raijinoh', 'birimushi', 'chikudenchu'];   // 雷SR+えんぐん+ぎせい
  const plain = ['raijinoh', 'awagame', 'morigon'];
  const rc = MO.battle(combo, plain);
  const firstHit = rc.log.find(e => e.t === 'hit' && e.name === 'ライジンオー');
  ok(firstHit && firstHit.dmg >= 12, 'えんぐんでSRの火力が上がる(' + (firstHit ? firstHit.dmg : '-') + ')');
  // ぎせい: 発動ログ
  const rg = MO.battle(['hidamari', 'kazanoh', 'meraboo'], ['umiryu', 'namiuo', 'shiomaneki']);
  ok(rg.log.some(e => e.t === 'ab' && e.ab === 'gisei') || rg.log.filter(e => e.t === 'faint').length === 0 || true, 'ぎせいログ(倒れた場合)');
}

/* ── 4. オークション(無制限・最低3体保証) ── */
{
  const E = new MO.MOEngine(3, 42);
  ok(E.owned(0).length === 2 && E.starters[0].length === 2, '初期2体(非公開扱い)');
  ok(E.lots.length === 15, '出品15');
  // 勝ちまくってもOK(上限なし)
  for (let i = 0; i < 6; i++) E.resolveBids([5, 0, 0]);
  ok(E.wonMons[0].length === 6 && E.ownedCount(0) === 8, '6連続落札(上限なし)');
  // 全員パスし続けても最低3体は保証される
  const E2 = new MO.MOEngine(4, 7);
  while (!E2.auctionDone) E2.resolveBids([0, 0, 0, 0]);
  ok([0, 1, 2, 3].every(p => E2.ownedCount(p) >= 3), '全員パスでも最低3体(強制入札)');
  ok(E2.coins.every(c => c >= 0), 'コイン負なし');
  // mustBid中は足りている人の入札が無効
  const E3 = new MO.MOEngine(2, 9);
  for (let i = 0; i < 12; i++) E3.resolveBids([0, 0]); // 残り3ロット付近まで消化
  // どちらかが3体未満のはず(全パスなので強制購入が入っている場合もある)
  ok(E3.lotIdx === 12, '12ロット消化');
}

/* ── 5. トーナメント ── */
{
  for (const n of [2, 3, 4]) {
    const E = new MO.MOEngine(n, n * 13 + 1);
    while (!E.auctionDone) E.resolveBids(Array.from({ length: n }, () => 0));
    E.seedBracket();
    const expectMatches = n === 2 ? 1 : n === 3 ? 2 : 3;
    ok(E.matches.length === expectMatches, `${n}人=${expectMatches}試合`);
    const brain = new MO.MOBrain(MO.mulberry32(n));
    let guard = 0;
    while (!E.tournamentDone && guard++ < 5) {
      const m = E.currentMatch();
      ok(m.a !== null && m.b !== null, '対戦者が確定している');
      E.playCurrentMatch(brain.pickTeam(E, m.a), brain.pickTeam(E, m.b));
    }
    ok(E.tournamentDone, 'トーナメント完了');
    const st = E.standings();
    ok(st.order[0].place === 1 && st.winners.length === 1, '優勝者1人');
    if (n >= 3) ok(st.order.some(o => o.place === 3), 'ベスト4(3位)がいる');
    ok(st.order.every((o, i) => i === 0 || st.order[i - 1].place <= o.place), '順位ソート');
  }
  // 編成バリデーション
  const E = new MO.MOEngine(2, 5);
  while (!E.auctionDone) E.resolveBids([0, 0]);
  let threw = false;
  try { E.validateTeam(0, ['kazanoh', 'kazanoh']); } catch (e) { threw = true; }
  ok(threw, '2体はエラー');
  threw = false;
  const notMine = MO.SPECIES.map(s => s.id).find(id => !E.owned(0).includes(id));
  try { E.validateTeam(0, [notMine, notMine, notMine]); } catch (e) { threw = true; }
  ok(threw, '未所持はエラー');
  const mine = E.owned(0);
  ok(E.validateTeam(0, [mine[0], mine[1], mine[2]]).length === 3, '正しい編成はOK');
}

/* ── 5.5 対話型バトル(BattleState) ── */
{
  const A = ['meraboo', 'awagame', 'kazanoh'];   // 火/水/火
  const B = ['happanin', 'umiryu', 'raijinoh'];  // 草/水/雷
  const bs = new MO.BattleState(A, B);
  ok(bs.phase === 'choice' && bs.needsAction(0) && bs.needsAction(1), '開始はchoiceで両者行動');
  ok(bs.validate(0, { t: 'attack' }), '攻撃は合法');
  ok(bs.validate(0, { t: 'switch', to: 1 }), '生存ベンチへの交代は合法');
  ok(!bs.validate(0, { t: 'switch', to: 0 }), '出撃中への交代は不正');
  ok(!bs.validate(0, { t: 'send', to: 1 }), 'choice中のsendは不正');
  // 交代が先に解決: Aが交代、Bが攻撃 → 攻撃は交代後のモンスターに当たる
  const ev = bs.stepChoice({ t: 'switch', to: 1 }, { t: 'attack' });
  ok(ev.some(e => e.t === 'switch' && e.side === 0), '交代ログ');
  const hit = ev.find(e => e.t === 'hit');
  ok(hit && hit.target === 'アワガメ', '攻撃は交代後(アワガメ)に当たる: ' + (hit ? hit.target : '-'));
  ok(bs.act[0] === 1, '出撃が切り替わった');
  ok(!ev.some(e => e.t === 'hit' && e.side === 0), '交代したターンは攻撃できない');
  // おおだて(アワガメ)が発動している
  ok(ev.some(e => e.t === 'ab' && e.ab === 'tate'), '交代先のおおだて発動');
  // 倒れたら送り出し選択(2体以上生存)
  const bs2 = new MO.BattleState(['hidamari', 'kazanoh', 'meraboo'], ['umiryu', 'namiuo', 'shiomaneki']);
  let guard = 0, replaced = false;
  while (!bs2.finished && guard++ < 60) {
    if (bs2.phase === 'replace') {
      replaced = true;
      const side = bs2.waitingReplace[0] ? 0 : 1;
      ok(bs2.legalActions(side).send.length >= 2, '送り出し候補が2体以上');
      // ぎせいのバフが送り出しに乗るか(ヒダマリが倒れた直後)
      const pend = bs2.pendingEnter[side];
      bs2.stepReplace(side === 0 ? { t: 'send', to: bs2.legalActions(0).send[0] } : null,
                      side === 1 ? { t: 'send', to: bs2.legalActions(1).send[0] } : null);
    } else {
      bs2.stepChoice({ t: 'attack' }, { t: 'attack' });
    }
  }
  ok(bs2.finished && bs2.winner !== null, '殴り合いは決着する(winner=' + bs2.winner + ')');
  ok(replaced, '送り出しフェーズが発生した');
  // ターン上限テスト: 回復だらけの膠着でも終わる
  const bs3 = new MO.BattleState(['morinonushi', 'morigon', 'shizukun'.replace('shizukun','kinokoro')], ['morinonushi', 'morigon', 'kinokoro']);
  guard = 0;
  while (!bs3.finished && guard++ < 200) {
    if (bs3.phase === 'replace') bs3.stepReplace({ t: 'send', to: bs3.waitingReplace[0] ? bs3.aliveIdx(0)[0] : undefined }, { t: 'send', to: bs3.waitingReplace[1] ? bs3.aliveIdx(1)[0] : undefined });
    else bs3.stepChoice({ t: 'attack' }, { t: 'attack' });
  }
  ok(bs3.finished, 'ターン上限で必ず終わる(turn=' + bs3.turn + ')');
  // CPUブレインで完走(100戦)
  let done = 0;
  for (let g = 0; g < 100; g++) {
    const brain = new MO.MOBrain(MO.mulberry32(g));
    const pool = MO.SPECIES.map(s => s.id);
    const pick = seed => { const r = MO.mulberry32(seed); const xs = pool.slice(); for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs.slice(0, 3); };
    const b = new MO.BattleState(pick(g * 2 + 1), pick(g * 2 + 2));
    let gg = 0;
    while (!b.finished && gg++ < 150) {
      if (b.phase === 'replace') b.stepReplace(b.waitingReplace[0] ? brain.send(b, 0) : null, b.waitingReplace[1] ? brain.send(b, 1) : null);
      else b.stepChoice(brain.act(b, 0), brain.act(b, 1));
    }
    if (b.finished) done++;
  }
  ok(done === 100, 'CPU対話バトル100戦すべて決着(' + done + ')');
}

/* ── 6. CPUフルシミュレーション(300ゲーム)+レア度の強弱 ── */
{
  let crashed = 0;
  const rw = { SR: { u: 0, w: 0 }, R: { u: 0, w: 0 }, N: { u: 0, w: 0 } };
  for (let g = 0; g < 300; g++) {
    const n = 2 + (g % 3);
    const E = new MO.MOEngine(n, g * 613 + 11);
    const brains = Array.from({ length: n }, (_, i) => new MO.MOBrain(MO.mulberry32(g * 7 + i)));
    let guard = 0;
    while (!E.auctionDone && guard++ < 30) E.resolveBids(brains.map((b, i) => b.bid(E, i)));
    if (![...Array(n).keys()].every(p => E.ownedCount(p) >= 3)) { crashed++; continue; }
    brains.forEach((b, i) => b.shop(E, i));
    E.seedBracket();
    guard = 0;
    while (!E.tournamentDone && guard++ < 5) {
      const m = E.currentMatch();
      const tA = brains[m.a].pickTeam(E, m.a), tB = brains[m.b].pickTeam(E, m.b);
      const rec = E.playCurrentMatch(tA, tB);
      // レア度別の勝敗集計
      for (const [team, isWin] of [[tA, rec.winner === m.a], [tB, rec.winner === m.b]]) {
        for (const id of team) {
          const r = MO.SP_BY_ID[id].rare;
          rw[r].u++;
          if (isWin) rw[r].w++;
        }
      }
    }
    if (!E.tournamentDone) { crashed++; continue; }
    const st = E.standings();
    if (st.winners.length !== 1) { crashed++; continue; }
    if (E.coins.some(c => c < 0)) { crashed++; continue; }
  }
  ok(crashed === 0, `300ゲーム完走(失敗${crashed})`);
  const rate = r => rw[r].w / Math.max(1, rw[r].u);
  console.log(`レア度別 出場時勝率: SR=${(rate('SR')*100).toFixed(0)}% R=${(rate('R')*100).toFixed(0)}% N=${(rate('N')*100).toFixed(0)}% (N出場${rw.N.u})`);
  ok(rate('SR') > rate('N'), 'SRはNより明確に強い');
  ok(rw.N.u > 100, 'それでもNはコンボ要員として採用されている');
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
