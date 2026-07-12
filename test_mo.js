/* mo_core.js(モンオク!)の検証テスト */
'use strict';
const MO = require('./mo_core.js');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }

/* ── 1. 図鑑 ── */
{
  ok(MO.SPECIES.length === 20, '20種');
  for (const t of MO.TYPES) ok(MO.SPECIES.filter(s => s.type === t).length === 5, `タイプ${t}=5種`);
  ok(MO.SPECIES.every(s => s.hp >= 20 && s.hp <= 50 && s.atk >= 5 && s.atk <= 12 && s.spd >= 3 && s.spd <= 15), 'ステータス範囲');
  ok(MO.SPECIES.every(s => MO.ABILITIES[s.ab]), '能力が全部定義済み');
  ok(new Set(MO.SPECIES.map(s => s.id)).size === 20, 'id重複なし');
}

/* ── 2. タイプ相性(火>草>雷>水>火) ── */
{
  ok(MO.typeMult('fire', 'grass') === 1.5, '火>草');
  ok(MO.typeMult('grass', 'elec') === 1.5, '草>雷');
  ok(MO.typeMult('elec', 'water') === 1.5, '雷>水');
  ok(MO.typeMult('water', 'fire') === 1.5, '水>火');
  ok(MO.typeMult('grass', 'fire') === 0.75, '草<火');
  ok(MO.typeMult('fire', 'elec') === 1, '火=雷(等倍)');
  ok(MO.typeMult('fire', 'fire') === 1, '同タイプ等倍');
}

/* ── 3. バトル基礎 ── */
{
  // 決定論: 同じ入力なら同じ結果
  const r1 = MO.battle(['meraboo', 'awagame', 'happanin'], ['birimushi', 'morigon', 'hidaneko']);
  const r2 = MO.battle(['meraboo', 'awagame', 'happanin'], ['birimushi', 'morigon', 'hidaneko']);
  ok(r1.winner === r2.winner && r1.log.length === r2.log.length, '決定論(同入力=同結果)');
  ok(r1.log[0].t === 'start' && r1.log[r1.log.length - 1].t === 'end', 'ログにstart/end');
  // 相性有利チーム(火3体 vs 草3体)は火が勝つはず
  const fire3 = ['meraboo', 'hidaneko', 'kazagon'];
  const grass3 = ['happanin', 'kinokoro', 'tsururisu'];
  ok(MO.battle(fire3, grass3).winner === 0, '火3 vs 草3 は火の勝ち');
  ok(MO.battle(grass3, fire3).winner === 1, '順序を替えても火が勝つ');
  // ターン上限内で必ず終わる
  const r3 = MO.battle(['awagame', 'morigon', 'yukidaruman'], ['awagame', 'morigon', 'yukidaruman']);
  ok(r3.log.filter(e => e.t === 'turn').length <= MO.MAX_TURNS, 'ターン上限');
  // 能力ログが出る(そっこう2倍: メラボーの初撃 > 素の攻撃)
  const r4 = MO.battle(['meraboo', 'meraboo', 'meraboo'], ['gorogoron', 'gorogoron', 'gorogoron']);
  const firstHit = r4.log.find(e => e.t === 'hit' && e.name === 'メラボー');
  ok(firstHit.dmg >= 20, 'そっこう: 初撃が2倍(' + firstHit.dmg + ')');
  // おおだて: アワガメが最初に受けるダメージは半減されている
  const r5 = MO.battle(['awagame', 'shizukun', 'namiuo'], ['meraboo', 'hidaneko', 'kazagon']);
  ok(r5.log.some(e => e.t === 'ab' && e.ab === 'tate'), 'おおだて発動ログ');
  // どくばり: 毒ダメージログ
  const r6 = MO.battle(['happanin', 'morigon', 'kinokoro'], ['awagame', 'shizukun', 'yukidaruman']);
  ok(r6.log.some(e => e.t === 'poison'), '毒ダメージログ');
  ok(r6.log.some(e => e.t === 'heal'), 'さいせい回復ログ');
}

/* ── 4. オークション ── */
{
  const E = new MO.MOEngine(3, 42);
  ok(E.owned.every(o => o.length === 2), '初期2体×3人');
  ok(E.lots.length === 15, '出品15体');
  ok(E.coins.every(c => c === 60), 'コイン60');
  // 入札解決: 最高額が落札しコインが減る
  const lot0 = E.currentLot();
  const r = E.resolveBids([10, 25, 5]);
  ok(r.winner === 1 && r.price === 25, '最高額P1が25で落札');
  ok(E.coins[1] === 35 && E.owned[1].length === 3 && E.owned[1].includes(lot0), 'コイン減算+入手');
  ok(E.wonCount[1] === 1, '落札カウント');
  // コイン超過はクランプ
  const r2 = E.resolveBids([100, 0, 0]);
  ok(r2.winner === 0 && r2.price === 60, '所持コイン(60)にクランプ');
  // 全員パス → 流れる
  const r3 = E.resolveBids([0, 0, 0]);
  ok(r3.winner === null, '全員パスで流れる');
  // 同額タイブレーク: 落札数が少ない方
  const r4 = E.resolveBids([0, 20, 20]);
  ok(r4.winner === 2, '同額は落札数が少ない方(P2)');
  // 3体そろったら自動的に不参加
  const E2 = new MO.MOEngine(2, 7);
  E2.resolveBids([5, 0]); E2.resolveBids([5, 0]); E2.resolveBids([5, 0]);
  ok(!E2.needMore(0), 'P0は3体で満了');
  const r5 = E2.resolveBids([50, 3]);
  ok(r5.winner === 1 && r5.price === 3, '満了者の入札は無効');
}

/* ── 5. mustBid(パス禁止)とオークション完了保証 ── */
{
  for (let seed = 0; seed < 100; seed++) {
    const n = 2 + (seed % 3);
    const E = new MO.MOEngine(n, seed * 31 + 5);
    let guard = 0;
    while (!E.auctionDone && guard++ < 30) {
      E.resolveBids(Array.from({ length: n }, () => 0)); // 全員パスし続ける
    }
    ok(E.owned.every(o => o.length === 5), `全員パスでも強制入札で5体そろう(seed=${seed})`);
    ok(E.coins.every(c => c >= 0), 'コインが負にならない');
  }
}

/* ── 6. 編成バリデーション ── */
{
  const E = new MO.MOEngine(2, 9);
  while (!E.auctionDone) E.resolveBids([1, 1]);
  const my = E.owned[0];
  let threw = false;
  try { E.setTeam(0, [my[0], my[1]]); } catch (e) { threw = true; }
  ok(threw, '2体はエラー');
  threw = false;
  try { E.setTeam(0, ['meraboo', 'meraboo', 'meraboo'].filter(id => !my.includes(id)).length ? ['xxx', 'yyy', 'zzz'] : ['xxx', 'yyy', 'zzz']); } catch (e) { threw = true; }
  ok(threw, '持っていないモンスターはエラー');
  E.setTeam(0, [my[0], my[1], my[2]]);
  E.setTeam(1, [E.owned[1][0], E.owned[1][1], E.owned[1][2]]);
  ok(E.allTeamsSet, '編成完了');
  E.runBattles();
  ok(E.results.length === 1, '2人戦は1試合');
  const st = E.standings();
  ok(st.order.length === 2 && st.winners.length >= 1, '順位が出る');
  ok(E.points[st.order[0].p] >= E.points[st.order[1].p], '勝ち点順');
}

/* ── 7. CPUフルシミュレーション(500ゲーム) ── */
{
  let crashed = 0;
  const winrate = {}; // 種族別の使用/勝利(バランス確認)
  MO.SPECIES.forEach(s => winrate[s.id] = { use: 0, win: 0 });
  for (let g = 0; g < 500; g++) {
    const n = 2 + (g % 3);
    const E = new MO.MOEngine(n, g * 977 + 3);
    const brains = Array.from({ length: n }, (_, i) => new MO.MOBrain(MO.mulberry32(g * 7 + i)));
    let guard = 0;
    while (!E.auctionDone && guard++ < 40) {
      E.resolveBids(brains.map((b, i) => b.bid(E, i)));
    }
    if (!E.owned.every(o => o.length === 5)) { crashed++; continue; }
    for (let p = 0; p < n; p++) E.setTeam(p, brains[p].pickTeam(E, p));
    E.runBattles();
    const st = E.standings();
    if (st.order.length !== n) { crashed++; continue; }
    // 種族勝率集計
    for (const r of E.results) {
      for (const [side, pl] of [[0, r.a], [1, r.b]]) {
        for (const id of E.teams[pl]) {
          winrate[id].use++;
          if (r.winner === side) winrate[id].win++;
        }
      }
    }
  }
  ok(crashed === 0, `500ゲーム完走(失敗${crashed})`);
  // バランス: 十分使われた種族の勝率が15%〜85%に収まる
  let unbalanced = [];
  console.log('種族別勝率(参考):');
  for (const s of MO.SPECIES) {
    const w = winrate[s.id];
    if (w.use < 30) continue;
    const rate = w.win / w.use;
    console.log(`  ${s.name}: ${(rate * 100).toFixed(0)}% (${w.use}戦)`);
    if (rate < 0.15 || rate > 0.85) unbalanced.push(`${s.name}=${(rate * 100).toFixed(0)}%`);
  }
  ok(unbalanced.length === 0, 'バランス: 極端な種族なし ' + unbalanced.join(','));
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
