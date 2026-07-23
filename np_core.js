/* ネプリーグ(nepleague) コアロジック — 純粋な計算のみ。通信に依存しない。
 * 答えの文字数ぶんのマスに1文字ずつ入れ、赤(正解)/青(不正解)で判定する。 */
'use strict';

const GENRES = ['一般常識', '生活・雑学', 'エンタメ', '歴史・地理', 'ことば'];

const QUESTIONS = [
  // ── 一般常識 ──
  { genre:'一般常識', difficulty:1, text:'太陽が昇る方角は？', answer:'ヒガシ' },
  { genre:'一般常識', difficulty:1, text:'1年で一番寒い季節は？', answer:'マフユ' },
  { genre:'一般常識', difficulty:2, text:'日本の首都は？', answer:'トウキョウ' },
  { genre:'一般常識', difficulty:2, text:'血液を全身に送る臓器は？', answer:'シンゾウ' },
  { genre:'一般常識', difficulty:3, text:'虹の色の数を表す言葉は？', answer:'ナナイロ' },
  { genre:'一般常識', difficulty:3, text:'空気中に一番多く含まれる気体は？', answer:'チッソ' },
  { genre:'一般常識', difficulty:4, text:'植物が光で栄養を作る働きは？', answer:'コウゴウセイ' },
  { genre:'一般常識', difficulty:5, text:'地球から一番近い恒星は？', answer:'タイヨウ' },
  // ── 生活・雑学 ──
  { genre:'生活・雑学', difficulty:1, text:'寿司に添える緑の辛い薬味は？', answer:'ワサビ' },
  { genre:'生活・雑学', difficulty:1, text:'コーヒーに入れる白い液体は？', answer:'ミルク' },
  { genre:'生活・雑学', difficulty:2, text:'洗濯物を掛けて干す道具は？', answer:'ハンガー' },
  { genre:'生活・雑学', difficulty:2, text:'和食のだしをとる魚を削ったものは？', answer:'カツオブシ' },
  { genre:'生活・雑学', difficulty:3, text:'カレーの定番、赤い漬物は福神◯◯？', answer:'ヅケ' },
  { genre:'生活・雑学', difficulty:3, text:'味の基本「さしすせそ」の「さ」は？', answer:'サトウ' },
  { genre:'生活・雑学', difficulty:4, text:'冷蔵庫で氷を作る場所は？', answer:'レイトウコ' },
  { genre:'生活・雑学', difficulty:5, text:'緑茶をいれるための道具は？', answer:'キュウス' },
  // ── エンタメ ──
  { genre:'エンタメ', difficulty:1, text:'野球でボールを打つ道具は？', answer:'バット' },
  { genre:'エンタメ', difficulty:1, text:'相撲の力士が腰につける布は？', answer:'マワシ' },
  { genre:'エンタメ', difficulty:2, text:'テニスで使う、網の張った道具は？', answer:'ラケット' },
  { genre:'エンタメ', difficulty:2, text:'映画を大画面で観る施設は？', answer:'エイガカン' },
  { genre:'エンタメ', difficulty:3, text:'オーケストラの指揮者が持つ棒は？', answer:'タクト' },
  { genre:'エンタメ', difficulty:3, text:'ボウリングでピンを全部倒すことは？', answer:'ストライク' },
  { genre:'エンタメ', difficulty:4, text:'マラソン発祥とされる国は？', answer:'ギリシャ' },
  { genre:'エンタメ', difficulty:5, text:'トランプで一番強いことが多い札は？', answer:'エース' },
  // ── 歴史・地理 ──
  { genre:'歴史・地理', difficulty:1, text:'富士山がある国は？', answer:'ニホン' },
  { genre:'歴史・地理', difficulty:1, text:'日本で一番大きい島は？', answer:'ホンシュウ' },
  { genre:'歴史・地理', difficulty:2, text:'アメリカの首都は？', answer:'ワシントン' },
  { genre:'歴史・地理', difficulty:2, text:'ピラミッドで有名な国は？', answer:'エジプト' },
  { genre:'歴史・地理', difficulty:3, text:'世界で一番高い山は？', answer:'エベレスト' },
  { genre:'歴史・地理', difficulty:3, text:'京都の旧国名は？（山◯）', answer:'ヤマシロ' },
  { genre:'歴史・地理', difficulty:4, text:'ナイル川が流れる大陸は？', answer:'アフリカ' },
  { genre:'歴史・地理', difficulty:5, text:'オーストラリアの首都は？', answer:'キャンベラ' },
  // ── ことば ──
  { genre:'ことば', difficulty:1, text:'反対語：大きい ⇔ ？', answer:'チイサイ' },
  { genre:'ことば', difficulty:1, text:'「ありがとう」＝漢字で感謝。その読みは？', answer:'カンシャ' },
  { genre:'ことば', difficulty:2, text:'「猫」を英語で言うと？', answer:'キャット' },
  { genre:'ことば', difficulty:2, text:'「朝」を英語で言うと？', answer:'モーニング' },
  { genre:'ことば', difficulty:3, text:'四字熟語「以心◯◯」の◯◯は？', answer:'デンシン' },
  { genre:'ことば', difficulty:3, text:'「油断大敵」の最初の二字の読みは？', answer:'ユダン' },
  { genre:'ことば', difficulty:4, text:'「一期一会」の最初の二字の読みは？', answer:'イチゴ' },
  { genre:'ことば', difficulty:5, text:'「臨機応変」の最後の二字の読みは？', answer:'オウヘン' },
];

const chars = (s) => Array.from(String(s || ''));

/* ひらがな→カタカナ正規化(判定をやさしく) */
function toKata(s) {
  return chars(s).map(c => {
    const n = c.charCodeAt(0);
    return (n >= 0x3041 && n <= 0x3096) ? String.fromCharCode(n + 0x60) : c;
  }).join('');
}
const normChar = (c) => toKata(c);

/* 難易度・傾向・文字数で問題を選ぶ(なければ条件を緩める) */
function pickQuestion(difficulty, genre, length, rnd = Math.random) {
  const tries = [
    q => q.difficulty === difficulty && q.genre === genre && chars(q.answer).length === length,
    q => q.genre === genre && chars(q.answer).length === length,
    q => q.difficulty === difficulty && chars(q.answer).length === length,
    q => chars(q.answer).length === length,
    () => true,
  ];
  for (const f of tries) {
    const pool = QUESTIONS.filter(f);
    if (pool.length) return pool[Math.floor(rnd() * pool.length)];
  }
  return QUESTIONS[0];
}

/* スロット(各マス)の char と 正解を突き合わせる。赤=correct / 青=wrong */
function judge(slots, answer) {
  const ans = chars(answer);
  const results = slots.map((s, i) => (s.char && normChar(s.char) === normChar(ans[i])) ? 'correct' : 'wrong');
  return { results, correctAll: results.length > 0 && results.every(r => r === 'correct') };
}

module.exports = { GENRES, QUESTIONS, chars, toKata, normChar, pickQuestion, judge };
