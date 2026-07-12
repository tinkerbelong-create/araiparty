/* qc_core.js(クアドルカラー)の検証テスト */
'use strict';
const QC = require('./qc_core.js');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }

/* ── 1. 盤面生成 ── */
for (let s = 0; s < 100; s++) {
  for (const size of QC.BOARD_SIZES) {
    const b = QC.genBoard(size, QC.mulberry32(s * 10 + size));
    ok(b.length === size && b.every(row => row.length === size), `盤面${size}×${size}`);
    ok(new Set(b.flat()).size === QC.COLORS, '4色すべて使われる');
    ok(b.flat().every(c => c >= 0 && c < 4), '色コード0..3');
  }
}

/* ── 2. 回転 ── */
{
  const p = [0, 1, 2, 3]; // 左上0 右上1 左下2 右下3
  ok(JSON.stringify(QC.rot90(p)) === JSON.stringify([2, 0, 3, 1]), '90°回転');
  ok(JSON.stringify(QC.rot90(QC.rot90(QC.rot90(QC.rot90(p))))) === JSON.stringify(p), '4回転で元に戻る');
  ok(QC.rotations(p).length === 4, '回転4種');
  ok(QC.rotEquiv([0, 1, 2, 3], [2, 0, 3, 1]), '回転同一視');
  ok(!QC.rotEquiv([0, 1, 2, 3], [1, 0, 2, 3]), '違うパターンは不一致');
  ok(QC.rotEquiv([1, 1, 1, 1], [1, 1, 1, 1]), '単色は自明に一致');
}

/* ── 3. matches(回転あり) ── */
{
  const board = [
    [0, 1, 0],
    [2, 3, 1],
    [0, 1, 2],
  ];
  ok(QC.matches(board, 0, 0, [0, 1, 2, 3]), 'そのままはまる');
  ok(QC.matches(board, 0, 0, [2, 0, 3, 1]), '回転してはまる');
  ok(QC.matches(board, 0, 0, [3, 2, 1, 0]), '180°回転してはまる');
  ok(!QC.matches(board, 0, 0, [0, 1, 3, 2]), 'はまらないパターン');
  ok(!QC.matches(board, 2, 2, [0, 1, 2, 3]), '範囲外はfalse');
  ok(!QC.matches(board, -1, 0, [0, 1, 2, 3]), '負座標はfalse');
}

/* ── 4. ピース生成(必ず解ける・回転重複なし) ── */
for (let s = 0; s < 50; s++) {
  const size = QC.BOARD_SIZES[s % 2];
  const n = QC.PIECE_COUNTS[s % 3];
  const rng = QC.mulberry32(s * 7 + 1);
  const board = QC.genBoard(size, rng);
  const pieces = QC.genPieces(board, n, rng);
  ok(pieces.length === n, `ピース${n}枚生成`);
  // 全ピースが盤面のどこかにはまる(回転あり)
  const solvable = pieces.every(pc => {
    for (let r = 0; r <= size - 2; r++)
      for (let c = 0; c <= size - 2; c++)
        if (QC.matches(board, r, c, pc.pattern)) return true;
    return false;
  });
  ok(solvable, '全ピースが必ず解ける');
}

/* ── 5. エンジン: 配置・お手つき・抜け順 ── */
{
  const E = new QC.QCEngine(3, { size: 6, pieces: 3, minutes: 3 }, 42);
  ok(E.hands.length === 3 && E.hands[0].length === 3, '3人×3枚');
  // P0が1枚目を正しい場所に
  const spot = E.findSpot(0, 0);
  ok(spot !== null, 'findSpotが見つける');
  const r1 = E.place(0, 0, spot[0], spot[1], 1000);
  ok(r1.ok && !r1.finished, '1枚目OK・まだ抜けない');
  ok(E.remaining(0) === 2, '残り2枚');
  // 同じピースはもう置けない
  ok(E.place(0, 0, spot[0], spot[1], 1100).ok === false, '配置済みは拒否');
  // お手つき: はまらない場所(全パターン走査して不一致の場所を探す)
  let missSpot = null;
  outer: for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) {
    if (!QC.matches(E.board, r, c, E.hands[0][1].pattern)) { missSpot = [r, c]; break outer; }
  }
  if (missSpot) {
    const rm = E.place(0, 1, missSpot[0], missSpot[1], 1200);
    ok(!rm.ok && rm.miss, 'お手つき判定');
    ok(E.misses[0] === 1, 'お手つきカウント');
  }
  // P1が全部はめて1位抜け
  for (let i = 0; i < 3; i++) {
    const sp = E.findSpot(1, i);
    const rr = E.place(1, i, sp[0], sp[1], 2000 + i);
    if (i === 2) { ok(rr.finished && rr.rank === 1, 'P1が1位で抜け'); }
  }
  ok(E.finished.includes(1), '抜けリストに入る');
  ok(E.finishMs[1] === 2002, '抜けタイム記録');
  // P0も残りをはめて2位
  for (let i = 0; i < 3; i++) {
    if (E.hands[0][i].placed) continue;
    const sp = E.findSpot(0, i);
    E.place(0, i, sp[0], sp[1], 3000 + i);
  }
  ok(E.finished.indexOf(0) === 1, 'P0は2位');
  ok(!E.allFinished, 'P2が残っている');
  // 結果: P2は未完で3位
  const res = E.result();
  ok(res.ranks[0].p === 1 && res.ranks[1].p === 0, '完了者は抜け順');
  ok(res.ranks[2].p === 2 && !res.ranks[2].finished && res.ranks[2].remaining === 3, '未完は最後・残り枚数つき');
}

/* ── 6. 未完同士の順位(残り枚数→お手つき) ── */
{
  const E = new QC.QCEngine(3, { size: 8, pieces: 5, minutes: 5 }, 7);
  // P1: 2枚はめる / P2: 1枚 / P0: 1枚+お手つき2回
  const sp = (p, i) => E.findSpot(p, i);
  let s1 = sp(1, 0); E.place(1, 0, s1[0], s1[1], 100);
  s1 = sp(1, 1); E.place(1, 1, s1[0], s1[1], 200);
  let s2 = sp(2, 0); E.place(2, 0, s2[0], s2[1], 300);
  let s0 = sp(0, 0); E.place(0, 0, s0[0], s0[1], 400);
  E.misses[0] = 2;
  const res = E.result();
  ok(res.ranks[0].p === 1, '残り少ないP1が上位');
  ok(res.ranks[1].p === 2 && res.ranks[2].p === 0, '残り同数はお手つき少ない順');
}

/* ── 7. 10人フルシミュレーション ── */
{
  let games = 0;
  for (let g = 0; g < 200; g++) {
    const n = 1 + (g % 10);
    const opts = { size: QC.BOARD_SIZES[g % 2], pieces: QC.PIECE_COUNTS[g % 3], minutes: QC.MINUTES[g % 3] };
    const E = new QC.QCEngine(n, opts, g * 131 + 17);
    // 全員ランダム順で解く
    const order = [];
    for (let p = 0; p < n; p++) for (let i = 0; i < E.pieceCount; i++) order.push([p, i]);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let t = 0;
    for (const [p, i] of order) {
      const sp = E.findSpot(p, i);
      if (!sp) throw new Error('解けないピースがある');
      const r = E.place(p, i, sp[0], sp[1], ++t);
      if (!r.ok) throw new Error('正解がokにならない');
    }
    if (!E.allFinished) throw new Error('全員完了にならない');
    const res = E.result();
    if (res.ranks.length !== n) throw new Error('順位数不正');
    // 抜け順=finishMs昇順
    for (let i = 1; i < E.finished.length; i++)
      if (E.finishMs[E.finished[i-1]] > E.finishMs[E.finished[i]]) throw new Error('抜け順が時間順でない');
    games++;
  }
  ok(games === 200, '200ゲーム(1〜10人×全設定)完走');
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
