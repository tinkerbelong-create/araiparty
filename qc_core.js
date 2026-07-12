/* クアドルカラー コアロジック
 * 4色の正方形が敷き詰められた盤面から、手持ちの「2×2パターンピース」が
 * ピッタリはまる場所(4マスの境目)を探して置くリアルタイムレース。
 * 最大10人。全員終わるか制限時間で終了。 */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = 4;                 // 4色(0..3)
const BOARD_SIZES = [6, 8];       // 36マス / 64マス
const PIECE_COUNTS = [3, 4, 5];   // 手持ち枚数
const MINUTES = [3, 4, 5];        // 制限時間(分)
const MAX_PLAYERS = 10;

/* ── 盤面生成: size×size を4色で埋める(4色すべて使う) ── */
function genBoard(size, rng) {
  let board;
  do {
    board = Array.from({ length: size }, () =>
      Array.from({ length: size }, () => Math.floor(rng() * COLORS)));
  } while (new Set(board.flat()).size < COLORS);
  return board;
}

/* 2×2パターン取得(アンカー=左上マス) */
function patternAt(board, r, c) {
  return [board[r][c], board[r][c + 1], board[r + 1][c], board[r + 1][c + 1]];
}
function samePattern(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

/* 2×2パターンの時計回り90°回転: [左上,右上,左下,右下] → [左下,左上,右下,右上] */
function rot90(p) { return [p[2], p[0], p[3], p[1]]; }
function rotations(p) {
  const r1 = rot90(p), r2 = rot90(r1), r3 = rot90(r2);
  return [p, r1, r2, r3];
}
/* 回転を同一視してパターンが等しいか */
function rotEquiv(a, b) { return rotations(a).some(r => samePattern(r, b)); }

/* 指定位置にピースがピッタリはまるか(回転あり: どの向きでもOK) */
function matches(board, r, c, pattern) {
  const size = board.length;
  if (r < 0 || c < 0 || r > size - 2 || c > size - 2) return false;
  return rotEquiv(pattern, patternAt(board, r, c));
}

/* ── ピース生成: 盤面上に必ず存在する2×2パターンをn個(アンカー重複なし) ──
 * パターン自体の重複もなるべく避ける(似たピースだらけだと混乱するため) */
function genPieces(board, n, rng) {
  const size = board.length;
  const anchors = [];
  for (let r = 0; r <= size - 2; r++) for (let c = 0; c <= size - 2; c++) anchors.push([r, c]);
  for (let i = anchors.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
  }
  const pieces = [];
  const spin = pat => { // 表示用にランダム回転をかける(回転ありルールなので正解は変わらない)
    let t = pat.slice();
    const k = Math.floor(rng() * 4);
    for (let i = 0; i < k; i++) t = rot90(t);
    return t;
  };
  for (const [r, c] of anchors) {
    const pat = patternAt(board, r, c);
    // 回転して同じになるパターンは紛らわしいので避ける
    if (!pieces.some(p => rotEquiv(p.pattern, pat))) {
      pieces.push({ pattern: spin(pat), src: [r, c], placed: false, placedAt: null });
      if (pieces.length === n) return pieces;
    }
  }
  // パターンの種類が足りない場合は重複を許して埋める(小盤面での保険)
  for (const [r, c] of anchors) {
    if (pieces.length === n) break;
    pieces.push({ pattern: spin(patternAt(board, r, c)), src: [r, c], placed: false, placedAt: null });
  }
  return pieces;
}

/* ══ エンジン ══ */
class QCEngine {
  constructor(playerCount, opts = {}, seed = Date.now()) {
    if (playerCount < 1 || playerCount > MAX_PLAYERS) throw new Error(`1〜${MAX_PLAYERS}人用です`);
    this.n = playerCount;
    this.size = BOARD_SIZES.includes(opts.size) ? opts.size : 6;
    this.pieceCount = PIECE_COUNTS.includes(opts.pieces) ? opts.pieces : 3;
    this.minutes = MINUTES.includes(opts.minutes) ? opts.minutes : 3;
    this.rng = mulberry32(seed & 0xffffffff);
    this.board = genBoard(this.size, this.rng);
    this.hands = Array.from({ length: playerCount }, () => genPieces(this.board, this.pieceCount, this.rng));
    this.finished = [];   // 完了順の player idx
    this.finishMs = {};   // p -> 経過ms
    this.misses = Array.from({ length: playerCount }, () => 0);
    this.startAt = null;  // サーバーが開始時刻をセット
  }
  remaining(p) { return this.hands[p].filter(x => !x.placed).length; }
  isFinished(p) { return this.remaining(p) === 0; }
  get allFinished() { return this.finished.length === this.n; }

  /* 配置を試みる。成功: {ok:true, pieceIdx, finished, rank} / 失敗: {ok:false} */
  place(p, pieceIdx, r, c, nowMs) {
    const hand = this.hands[p];
    const piece = hand[pieceIdx];
    if (!piece || piece.placed) return { ok: false, error: 'そのピースは配置済みです' };
    if (!matches(this.board, r, c, piece.pattern)) {
      this.misses[p]++;
      return { ok: false, error: 'そこにはハマらない!', miss: true };
    }
    piece.placed = true;
    piece.placedAt = [r, c];
    let rank = null;
    if (this.isFinished(p) && !this.finished.includes(p)) {
      this.finished.push(p);
      this.finishMs[p] = nowMs;
      rank = this.finished.length;
    }
    return { ok: true, finished: rank !== null, rank };
  }

  /* 結果: 完了者は完了順、未完了者は残り枚数少ない順(同数はお手つき少ない順) */
  result() {
    const unfinished = [];
    for (let p = 0; p < this.n; p++) if (!this.finished.includes(p)) unfinished.push(p);
    unfinished.sort((a, b) =>
      (this.remaining(a) - this.remaining(b)) || (this.misses[a] - this.misses[b]) || 0);
    const order = [...this.finished, ...unfinished];
    return {
      order,
      ranks: order.map((p, i) => ({
        p, rank: i + 1,
        finished: this.finished.includes(p),
        timeMs: this.finishMs[p] ?? null,
        remaining: this.remaining(p),
        misses: this.misses[p],
      })),
    };
  }
}

/* CPU/自動用: 未配置ピースがはまる場所を探す(必ず見つかる) */
QCEngine.prototype.findSpot = function (p, pieceIdx) {
  const piece = this.hands[p][pieceIdx];
  if (!piece || piece.placed) return null;
  for (let r = 0; r <= this.size - 2; r++)
    for (let c = 0; c <= this.size - 2; c++)
      if (matches(this.board, r, c, piece.pattern)) return [r, c];
  return null;
};

module.exports = {
  mulberry32, COLORS, BOARD_SIZES, PIECE_COUNTS, MINUTES, MAX_PLAYERS,
  genBoard, genPieces, patternAt, samePattern, rot90, rotations, rotEquiv, matches, QCEngine,
};
