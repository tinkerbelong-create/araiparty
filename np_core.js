/* ファイブリーグ コアロジック — 純粋な計算のみ。通信に依存しない。
 *
 * ── 本家のルール ──
 * ・答えは5文字。挑戦者が1人1文字ずつ埋める
 * ・全員そろって正解なら【赤】、1人でも間違えていれば【青】のまま
 * ・正解すると次の問題へ。難易度は 1 → 2 → 3 → 4 → 5 と上がっていく
 * ・1人でも間違えたら、そこで終了。そこまでの正解数に応じたポイントを獲得
 * ・5問すべて正解でパーフェクト。ボーナスがつく
 *
 * ── 珍解答 ──
 * オープンしたとき、実際に入力された5文字を並べた「できあがってしまった言葉」を返す。
 * 本家でアナウンサーが読み上げて笑いを誘う、いちばんおいしいところ。 */
'use strict';

const { GENRES, QUESTIONS } = require('./np_questions.js');

const STAGES = 5;                          // 全5問
const STAGE_POINTS = [10, 20, 30, 40, 50]; // 第n問クリアで得られる点(進むほど大きい)
const PERFECT_BONUS = 50;                  // 5問完答のボーナス
const ANSWER_LEN = 5;                      // 答えの文字数

const chars = (s) => Array.from(String(s || ''));

/* ひらがな→カタカナ正規化(判定をやさしく) */
function toKata(s) {
  return chars(s).map(c => {
    const n = c.charCodeAt(0);
    return (n >= 0x3041 && n <= 0x3096) ? String.fromCharCode(n + 0x60) : c;
  }).join('');
}
const normChar = (c) => toKata(c);

/* 難易度(と傾向)で1問選ぶ。used に入っている問題文は避ける */
function pickQuestion(difficulty, genre, used = [], rnd = Math.random) {
  const d = Math.min(5, Math.max(1, Number(difficulty) || 1));
  const fresh = q => !used.includes(q.t);
  const tries = [
    q => q.d === d && q.g === genre && fresh(q),
    q => q.d === d && fresh(q),
    q => q.d === d,
    () => true,
  ];
  for (const f of tries) {
    const pool = QUESTIONS.filter(f);
    if (pool.length) return pool[Math.floor(rnd() * pool.length)];
  }
  return QUESTIONS[0];
}

/* 各マスを突き合わせる。赤=correct / 青=wrong */
function judge(slots, answer) {
  const ans = chars(answer);
  const results = slots.map((s, i) => (s.char && normChar(s.char) === normChar(ans[i])) ? 'correct' : 'wrong');
  return { results, correctAll: results.length > 0 && results.every(r => r === 'correct') };
}

/* ★珍解答: 入力された文字をそのまま並べたもの。空欄は「◯」 */
function assembled(slots) {
  return slots.map(s => s.char || '◯').join('');
}

/* そこまでの正解数から得点を計算する */
function scoreFor(cleared) {
  const n = Math.max(0, Math.min(STAGES, cleared));
  let base = 0;
  for (let i = 0; i < n; i++) base += STAGE_POINTS[i];
  const perfect = n >= STAGES;
  return { base, bonus: perfect ? PERFECT_BONUS : 0, total: base + (perfect ? PERFECT_BONUS : 0), perfect };
}

/* そのステージをクリアしたときに増える点(モニター表示用) */
function pointsOfStage(stage) { return STAGE_POINTS[Math.max(0, Math.min(STAGES - 1, stage - 1))]; }

/* 5マスを人数で割り当てる。人数が5未満なら一部の人が複数マスを担当する */
function assignSlots(members) {
  const slots = [];
  for (let i = 0; i < ANSWER_LEN; i++) {
    const owner = members[i % members.length];
    slots.push({ index: i, playerId: owner.id, playerName: owner.name, char: '', locked: false });
  }
  return slots;
}

module.exports = {
  GENRES, QUESTIONS, STAGES, STAGE_POINTS, PERFECT_BONUS, ANSWER_LEN,
  chars, toKata, normChar, pickQuestion, judge, assembled, scoreFor, pointsOfStage, assignSlots,
};
