/* マーダーミステリー共通エンジン (core)
 * シナリオJSONを読み込み、フェーズ進行・能力解決・採点を行う。
 * 秘匿情報(他人のHO・真相・能力の中身)は一切ここから外に出さない。
 * server側は必ず publicView() / privateView() 経由でクライアントへ配信すること。
 *
 * ── 進行の考え方(初心者向け) ──
 * 各フェーズは brief(案内) → main(本編) → result(結果) の3ステップ。
 * ステップは「全員が完了を押す」ことでしか進まない。ホストが勝手に進めることはない。
 *
 * ── 行動の考え方 ──
 * 原作どおり「能力を使うか、使わないか」だけ。共通の調査アクションは無い。
 * 能力の対象に場所を選んだ人は、その場所に動いたものとして扱う(同化・カメラが検知する)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCENARIO_DIR = path.join(__dirname, 'scenarios');

/* ── シナリオ読み込み ── */
const cache = new Map();
function loadScenario(id) {
  if (cache.has(id)) return cache.get(id);
  const data = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, `${id}.json`), 'utf8'));
  cache.set(id, data);
  return data;
}
function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs.readdirSync(SCENARIO_DIR).filter(f => f.endsWith('.json')).map(f => {
    const s = loadScenario(f.replace(/\.json$/, ''));
    return {
      id: s.id, title: s.title, subtitle: s.subtitle || '',
      players: s.players, duration: s.duration, icon: s.icon || '🕯', theme: s.theme || null,
    };
  });
}

const STEPS = { BRIEF: 'brief', MAIN: 'main', RESULT: 'result' };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── ゲーム本体 ── */
class Game {
  constructor(scenarioId) {
    this.sc = loadScenario(scenarioId);
    this.scenarioId = scenarioId;
    this.phaseIdx = 0;
    this.step = STEPS.BRIEF;
    this.ready = new Set();             // このステップで完了を押した charId
    this.assign = {};                   // charId -> seatIdx(ランダム配布)

    this.fridgePower = !!(this.sc.world && this.sc.world.fridgePower);
    this.doors = {};
    (this.sc.abilityActions?.k1?.doors || []).forEach(d => { this.doors[d.id] = 'open'; });
    this.doors.fridge = 'closed';       // ナツキが22:00に勢いよく閉めたまま

    this.used = {};
    this.copied = {};
    this.known = {};
    this.cams = [];                     // {placeId, byChar}
    this.playedCards = {};              // charId -> [cardId] 出した証言
    this.orders = [];                   // {by, target, questionId, answerId, void}
    this.authorityDeclared = false;     // 船長権限が宣言されたか
    this.recalled = {};                 // charId -> 何回思い出したか
    this.log = {};                      // charId -> [{phase,title,text}] 本人だけの記録
    this.moves = {};                    // phaseIdx -> {charId: move}
    this.lastResults = {};              // charId -> [{title,text}] 直近フェーズの結果
    this.publicLog = [];                // 全員に見える出来事
    this.answers = {};
    this.result = null;

    this.sc.characters.forEach(c => {
      this.used[c.id] = 0; this.known[c.id] = []; this.log[c.id] = []; this.copied[c.id] = null;
      this.playedCards[c.id] = []; this.recalled[c.id] = 0;
    });
    Object.entries(this.sc.initialKnown || {}).forEach(([cid, arr]) =>
      arr.forEach(k => this.known[cid].push({ char: k.char, abilityId: k.abilityId })));

    // ★能力当ての候補は毎ゲームその場でシャッフルする。
    //   JSONの並び順(本物→ダミー)のまま出すと、先頭が本物だと分かってしまう。
    this.pool = shuffle((this.sc.abilityGuess && this.sc.abilityGuess.pool) || []);
  }

  /* キャラをランダムに配る */
  assignRandom(seatCount) {
    const ids = this.sc.characters.map(c => c.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const out = [];
    for (let i = 0; i < seatCount; i++) { this.assign[ids[i]] = i; out.push(ids[i]); }
    return out; // seatIdx -> charId
  }

  get phase() { return this.sc.phases[this.phaseIdx]; }
  get phaseType() { return this.phase.type; }
  get isLast() { return this.phaseIdx >= this.sc.phases.length - 1; }
  char(id) { return this.sc.characters.find(c => c.id === id); }
  ability(cid, aid) { return this.char(cid)?.abilities.find(a => a.id === aid); }
  place(id) { return (this.sc.places || []).find(p => p.id === id); }
  maxUses() { return 2; }

  /* すり抜け先が明るいか。冷蔵庫だけ電源＋扉に依存する(理由はプレイヤーに明かさない) */
  isLit(placeId) {
    const p = this.place(placeId);
    if (!p || !p.dark) return true;
    return this.fridgePower && this.doors.fridge === 'open';
  }

  /* ── ステップ進行: 全員が完了を押したときだけ進む ── */
  markReady(charId) {
    this.ready.add(charId);
    return this.ready.size >= this.sc.characters.length;
  }
  readyCount() { return this.ready.size; }
  /* 次のステップへ。戻り値 'next' = 次のフェーズへ / 'ok' / 'end' */
  nextStep() {
    this.ready.clear();
    if (this.step === STEPS.BRIEF) { this.step = STEPS.MAIN; return 'ok'; }
    if (this.step === STEPS.MAIN) {
      if (this.phaseType === 'ability') { this.step = STEPS.RESULT; return 'ok'; }
      if (this.phaseType === 'final') { this.score(); }
      return this.gotoNextPhase();
    }
    return this.gotoNextPhase(); // RESULT
  }
  gotoNextPhase() {
    if (this.isLast) return 'end';
    this.phaseIdx++;
    this.step = this.phaseType === 'ending' ? STEPS.MAIN : STEPS.BRIEF;
    if (this.phaseType === 'ending') { if (!this.result) this.score(); return 'end'; }
    return 'next';
  }

  /* ── 能力の提出 ── */
  submitMove(charId, move) {
    if (this.phaseType !== 'ability' || this.step !== STEPS.MAIN) return { ok: false, msg: '今は能力を使えません' };
    const bucket = (this.moves[this.phaseIdx] ||= {});
    if (bucket[charId]) return { ok: false, msg: 'もう決定しています' };
    move = move || {};
    if (move.abilityId) {
      const isCopy = this.copied[charId] === move.abilityId;
      if (!isCopy) {
        const own = this.ability(charId, move.abilityId);
        if (!own) return { ok: false, msg: 'その能力は持っていません' };
        if (own.usableInGame === false) return { ok: false, msg: 'その能力は今は使えません' };
        if (this.used[charId] >= this.maxUses()) return { ok: false, msg: '能力の使用回数(2回)を使い切っています' };
      }
    }
    bucket[charId] = move;
    return { ok: true };
  }
  allMoved() {
    const b = this.moves[this.phaseIdx] || {};
    return this.sc.characters.every(c => !!b[c.id]);
  }
  movedCount() { return Object.keys(this.moves[this.phaseIdx] || {}).length; }

  /* ── 同時解決 ──
   * ①ドア → ②偽物/水(その場で全員に見える) → ③カメラ設置
   * → ④すり抜け → ⑤同化・カメラ報告 → ⑥キーワード/コピー */
  resolvePhase() {
    if (this.resolved && this.resolved[this.phaseIdx]) return this.lastResults; // 二重解決の防止
    (this.resolved ||= {})[this.phaseIdx] = true;
    const bucket = this.moves[this.phaseIdx] || {};
    const phaseName = this.phase.title;
    const out = {};
    const push = (cid, title, text) => { (out[cid] ||= []).push({ title, text }); };
    const A = id => this.sc.abilityActions[id];
    const entries = Object.entries(bucket);
    const of = r => entries.filter(([, m]) => m.abilityId && A(m.abilityId) && A(m.abilityId).resolve === r);

    // 能力の対象に場所を選んだ人＝その場所へ動いた人
    const presence = {};
    entries.forEach(([cid, m]) => {
      const d = m.abilityId && A(m.abilityId);
      if (d && ['peek_place', 'observe_place', 'watch_place'].includes(d.resolve) && m.target?.placeId) {
        (presence[m.target.placeId] ||= []).push(cid);
      }
    });

    /* ① ドア開閉 */
    for (const [cid, m] of of('toggle_door')) {
      const d = A('k1').doors.find(x => x.id === m.target?.doorId);
      if (!d) { push(cid, A('k1').label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      const opening = this.doors[d.id] === 'closed';
      this.doors[d.id] = opening ? 'open' : 'closed';
      push(cid, A('k1').label, `${d.name}を${opening ? '開けた' : '閉めた'}。`);
    }

    /* ② 本人にしか結果が出ない能力(水) */
    for (const [cid, m] of of('flavor')) {
      this.useUp(cid, m);
      push(cid, A(m.abilityId).label, A(m.abilityId).text);
    }
    /* ②' その場で全員に見える能力(偽物を出す) */
    for (const [cid, m] of of('show_fake')) {
      const obj = A('r2').objects.find(o => o.id === m.target?.objId);
      if (!obj) { push(cid, A('r2').label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      push(cid, A('r2').label, A('r2').text.replace('{obj}', obj.name));
      this.publicLog.push({ phase: phaseName, text: A('r2').publicText.replace('{name}', this.char(cid).name).replace('{obj}', obj.name) });
    }

    /* ③ カメラ設置 */
    for (const [cid, m] of of('watch_place')) {
      const pl = this.place(m.target?.placeId);
      if (!pl) { push(cid, A('r3').label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      this.cams.push({ placeId: pl.id, byChar: cid });
      push(cid, A('r3').label, `${pl.name}にカメラを仕込んだ。`);
    }

    /* ④ すり抜け */
    for (const [cid, m] of of('peek_place')) {
      const pl = this.place(m.target?.placeId);
      if (!pl) { push(cid, A('n1').label, '対象が見つからなかった。'); continue; }
      if (!this.isLit(pl.id)) { push(cid, `${A('n1').label} → ${pl.name}`, A('n1').failText); continue; }
      this.useUp(cid, m);
      push(cid, `${A('n1').label} → ${pl.name}`, pl.touch);
    }

    /* ⑤ 同化 */
    for (const [cid, m] of of('observe_place')) {
      const pl = this.place(m.target?.placeId);
      if (!pl) { push(cid, A('n3').label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      const others = (presence[pl.id] || []).filter(x => x !== cid);
      push(cid, `${A('n3').label} → ${pl.name}`, others.length
        ? `壁になりきって様子をうかがった。\nここに現れたのは——${others.map(x => this.char(x).name).join('、')}。`
        : '壁になりきって様子をうかがった。\nここには、誰も来なかった。');
    }

    /* ⑤' カメラの報告(設置済みすべて) */
    const done = new Set();
    for (const cam of this.cams) {
      const key = cam.byChar + ':' + cam.placeId;
      if (done.has(key)) continue;
      done.add(key);
      const pl = this.place(cam.placeId); if (!pl) continue;
      const others = (presence[cam.placeId] || []).filter(x => x !== cam.byChar);
      let t;
      if (!others.length) t = `${pl.name}——誰も来なかった。`;
      else if (this.isLit(cam.placeId)) t = `${pl.name}——映像に映った。${others.map(x => this.char(x).name).join('、')}が来ている。`;
      else t = `${pl.name}——${A('r3').darkText} 誰かがここにいる。だが暗くて、誰かまでは分からない。`;
      push(cam.byChar, '📹 カメラの映像', t);
    }

    /* ── ここから『海の上でいちばん偉い人』系の行動 ── */

    /* 船長権限の宣言(いちばん先に解決する。以後の命令をすべて無効にする) */
    for (const [cid, m] of of('declare_authority')) {
      const AU = this.sc.authority || {};
      if (this.authorityDeclared) { push(cid, A('k_auth').label, 'すでに宣言している。'); continue; }
      this.useUp(cid, m);
      this.authorityDeclared = true;
      this.orders.forEach(o => { o.void = true; });
      push(cid, A(m.abilityId).label, AU.declareText || '船長権限を宣言した。');
      this.publicLog.push({ phase: phaseName, text: AU.publicText || '船長権限が宣言された。', big: true });
      if (AU.declareText) this.publicLog.push({ phase: phaseName, text: AU.declareText });
      // 代償: 指定された証言カードが強制的に公開される
      const card = (this.char(cid).cards || []).find(c => c.id === AU.costCardId);
      if (card && !this.playedCards[cid].includes(card.id)) {
        this.playedCards[cid].push(card.id);
        this.publicLog.push({ phase: phaseName, text: `【${this.char(cid).name}／${card.title}】\n${card.text}` });
        push(cid, '——引き換えに', `あなたの証言「${card.title}」が、全員の前に出された。`);
      }
    }

    /* 命令(権限宣言後は出せない) */
    for (const [cid, m] of of('give_order')) {
      const OD = this.sc.orders || {};
      const tc = this.char(m.target?.charId);
      const opt = (OD.options || []).find(o => `${o.questionId}:${o.answerId}` === m.target?.orderId);
      if (!tc || tc.id === cid || !opt) { push(cid, A(m.abilityId).label, '対象が見つからなかった。'); continue; }
      if (this.authorityDeclared) {
        push(cid, A(m.abilityId).label, '……鏑木がこちらを見ている。もう、命令は通らない。');
        continue;
      }
      this.useUp(cid, m);
      this.orders.push({ by: cid, target: tc.id, questionId: opt.questionId, answerId: opt.answerId, label: opt.label, void: false });
      const q = this.sc.finalQuestions.find(x => x.id === opt.questionId);
      const ans = q && (q.options.find(o => o.id === opt.answerId) || {}).label;
      push(cid, A(m.abilityId).label, `${tc.name}に命じた。\n「${q ? q.text : ''}」——『${ans}』と答えろ。`);
      push(tc.id, '⚠ 命令',
        (OD.targetText || '命令: 「{question}」——『{answer}』と答えろ。')
          .replace('{question}', q ? q.text : '').replace('{answer}', ans || ''));
      this.publicLog.push({
        phase: phaseName,
        text: (OD.publicText || '{name}が{target}に何かを命じた。')
          .replace('{name}', this.char(cid).name).replace('{target}', tc.name),
      });
    }

    /* 証言カードを出す(全員に公開) */
    for (const [cid, m] of of('reveal_card')) {
      const card = (this.char(cid).cards || []).find(c => c.id === m.target?.cardId);
      if (!card) { push(cid, A(m.abilityId).label, '対象が見つからなかった。'); continue; }
      if (this.playedCards[cid].includes(card.id)) { push(cid, A(m.abilityId).label, 'その証言はもう出している。'); continue; }
      this.useUp(cid, m);
      this.playedCards[cid].push(card.id);
      push(cid, A(m.abilityId).label, `証言「${card.title}」を全員の前に出した。`);
      this.publicLog.push({ phase: phaseName, text: `【${this.char(cid).name}／${card.title}】\n${card.text}` });
    }

    /* 問いかけ(全員に聞こえる。答えるかは本人次第) */
    for (const [cid, m] of of('ask_player')) {
      const AA = A(m.abilityId);
      const tc = this.char(m.target?.charId);
      const q = (AA.questions || []).find(x => x.id === m.target?.questionId);
      if (!tc || tc.id === cid || !q) { push(cid, AA.label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      push(cid, AA.label, `${tc.name}に問いかけた。\n「${q.text}」`);
      push(tc.id, '⚠ 問いかけられた', `${this.char(cid).name}から、全員の前で問われた。\n「${q.text}」\n\n答えるかどうかは、あなた次第。`);
      this.publicLog.push({
        phase: phaseName,
        text: (AA.publicText || '{name}が{target}に問いかけた——「{question}」')
          .replace('{name}', this.char(cid).name).replace('{target}', tc.name).replace('{question}', q.text),
      });
    }

    /* 思い出す(使うたびに次の記憶が開く) */
    for (const [cid, m] of of('recall')) {
      const AA = A(m.abilityId);
      const i = this.recalled[cid] || 0;
      const t = (AA.texts || [])[i];
      if (!t) { push(cid, AA.label, 'これ以上は、思い出せない。'); continue; }
      this.useUp(cid, m);
      this.recalled[cid] = i + 1;
      push(cid, AA.label, t);
    }

    /* ⑥ キーワード / コピー */
    for (const [cid, m] of of('steal_keyword')) {
      const tc = this.char(m.target?.charId);
      if (!tc || tc.id === cid) { push(cid, A('k2').label, '対象が見つからなかった。'); continue; }
      const got = this.known[cid].filter(k => k.char === tc.id).map(k => k.abilityId);
      const rest = tc.abilities.filter(a => !got.includes(a.id));
      if (!rest.length) { push(cid, A('k2').label, A('k2').emptyText); continue; }
      this.useUp(cid, m);
      const pick = rest[Math.floor(Math.random() * rest.length)];
      this.known[cid].push({ char: tc.id, abilityId: pick.id });
      push(cid, A('k2').label, `${tc.name}に触れた。頭に流れ込んできたキーワードは——「${pick.keyword}」。`);
    }
    for (const [cid, m] of of('copy_ability')) {
      const tc = this.char(m.target?.charId);
      const ok = tc && tc.id !== cid && tc.abilities.some(a => a.id === m.target?.abilityId);
      this.useUp(cid, m);
      if (ok) {
        this.copied[cid] = m.target.abilityId;
        push(cid, A('n2').label, `${A('n2').successText}\n\nコピーした能力: 「${this.ability(tc.id, m.target.abilityId).name}」`);
      } else {
        push(cid, A('n2').label, A('n2').failText);
      }
    }

    // 使わなかった人にも一言
    entries.filter(([, m]) => !m.abilityId).forEach(([cid]) =>
      push(cid, '能力を使わなかった', 'あなたは動かなかった。'));

    // ★誰が能力を使ったかだけを全員に公開(何を使ったかは伏せる)
    const users = entries.filter(([, m]) => m.abilityId).map(([cid]) => this.char(cid).name);
    this.publicLog.push({
      phase: phaseName,
      text: users.length ? `${users.join('、')}が能力を使った。` : '誰も能力を使わなかった。',
    });

    this.lastResults = out;
    Object.entries(out).forEach(([cid, arr]) => arr.forEach(r => this.log[cid].push({ phase: phaseName, ...r })));
    return out;
  }

  useUp(cid, m) {
    if (this.copied[cid] === m.abilityId) this.copied[cid] = null;
    else this.used[cid]++;
  }

  /* ── 最終回答 ── */
  submitAnswers(charId, payload) {
    if (this.phaseType !== 'final') return { ok: false, msg: '今は提出できません' };
    this.answers[charId] = {
      questions: payload.questions || {},
      abilities: payload.abilities || {},
      note: (payload.note || '').slice(0, 2000),
    };
    return { ok: true };
  }
  allAnswered() { return this.sc.characters.every(c => !!this.answers[c.id]); }

  /* ── 採点 ── */
  score() {
    const chars = this.sc.characters, Q = this.sc.finalQuestions, ans = this.answers;

    const exposed = {};
    chars.forEach(t => t.abilities.forEach(a => { exposed[`${t.id}:${a.id}`] = false; }));
    chars.forEach(g => {
      Object.entries(ans[g.id]?.abilities || {}).forEach(([tid, ids]) => {
        if (tid === g.id) return;
        (ids || []).forEach(id => { if (exposed[`${tid}:${id}`] === false) exposed[`${tid}:${id}`] = true; });
      });
    });

    const hits = {};
    chars.forEach(g => {
      let h = 0;
      Object.entries(ans[g.id]?.abilities || {}).forEach(([tid, ids]) => {
        if (tid === g.id) return;
        const t = this.char(tid); if (!t) return;
        (ids || []).forEach(id => { if (t.abilities.some(a => a.id === id)) h++; });
      });
      hits[g.id] = h;
    });

    const detail = {};
    chars.forEach(c => { detail[c.id] = { total: 0, lines: [] }; });

    (this.sc.scoring || []).forEach(rule => {
      const d = detail[rule.char]; if (!d) return;
      let got = 0, note = '';
      const q = Q.find(x => x.id === rule.question);
      if (rule.rule === 'correct') {
        const my = ans[rule.char]?.questions?.[rule.question];
        const ok = q && my === q.answer;
        got = ok ? rule.points : 0;
        note = ok ? '正解' : `不正解(あなたの回答: ${this.labelOf(q, my)})`;
      } else if (rule.rule === 'notAccused') {
        const acc = chars.filter(o => o.id !== rule.char)
          .filter(o => ans[o.id]?.questions?.[rule.question] === rule.char).map(o => o.name);
        got = acc.length === 0 ? rule.points : 0;
        note = acc.length === 0 ? '誰にも指摘されなかった' : `${acc.join('・')}に指摘された`;
      } else if (rule.rule === 'hideAbility') {
        const safe = this.char(rule.char).abilities.filter(a => !exposed[`${rule.char}:${a.id}`]);
        got = safe.length * rule.points;
        note = `バレていない能力 ${safe.length}/3` + (safe.length ? `(${safe.map(a => a.keyword).join('・')})` : '');
      } else if (rule.rule === 'guessAbility') {
        const h = hits[rule.char] || 0;
        got = Math.floor(h / (rule.per || 2)) * rule.points;
        note = `${h}個正解`;
      } else if (rule.rule === 'notCorrect') {
        // 他の誰にも正解されなければ達成
        const solvers = chars.filter(o => o.id !== rule.char)
          .filter(o => q && ans[o.id]?.questions?.[rule.question] === q.answer).map(o => o.name);
        got = solvers.length === 0 ? rule.points : 0;
        note = solvers.length === 0 ? '誰にも突き止められなかった' : `${solvers.join('・')}に突き止められた`;
      } else if (rule.rule === 'orderObeyed') {
        const live = this.orders.filter(o => !o.void);
        const obeyed = live.filter(o => ans[o.target]?.questions?.[o.questionId] === o.answerId);
        got = obeyed.length * rule.points;
        note = this.authorityDeclared
          ? `命令${this.orders.length}件は船長権限で無効化された`
          : `${obeyed.length}/${live.length} 件が守られた`;
      } else if (rule.rule === 'orderFollowed') {
        const mine = this.orders.filter(o => o.target === rule.char && !o.void);
        const followed = mine.filter(o => ans[rule.char]?.questions?.[o.questionId] === o.answerId);
        got = followed.length * rule.points;
        note = mine.length ? `${followed.length}/${mine.length} 件に従った` : '命令されなかった';
      } else if (rule.rule === 'authority') {
        got = this.authorityDeclared ? rule.points : 0;
        note = this.authorityDeclared ? '宣言した' : '宣言しなかった';
      }
      d.total += got;
      d.lines.push({ label: rule.label, points: got, note });
    });

    const ranking = chars.map(c => ({ id: c.id, name: c.name, total: detail[c.id].total }))
      .sort((a, b) => b.total - a.total);
    const winner = ranking[0];

    this.result = {
      detail, ranking, winner,
      hasAbilityGuess: !!this.sc.abilityGuess,
      reveal: Q.map(q => ({
        id: q.id, text: q.text, answerLabel: this.labelOf(q, q.answer),
        byChar: chars.map(c => ({ id: c.id, name: c.name, label: this.labelOf(q, ans[c.id]?.questions?.[q.id]) })),
      })),
      notes: chars.map(c => ({ id: c.id, name: c.name, note: ans[c.id]?.note || '' })),
      abilityReveal: chars.map(c => ({
        id: c.id, name: c.name,
        abilities: c.abilities.map(a => ({
          keyword: a.keyword, name: a.name, note: a.note,
          exposed: exposed[`${c.id}:${a.id}`],
          guessedBy: chars.filter(o => o.id !== c.id && (ans[o.id]?.abilities?.[c.id] || []).includes(a.id)).map(o => o.name),
        })),
      })),
      truth: this.sc.truth,
      outro: this.sc.truth.outro.replace('{{WINNER}}', winner.name),
    };
    return this.result;
  }

  labelOf(q, id) {
    if (!q || id == null) return '(未回答)';
    const o = (q.options || []).find(x => x.id === id);
    return o ? o.label : '(未回答)';
  }

  /* ── 配信ビュー ── */
  publicView() {
    return {
      scenario: {
        id: this.sc.id, title: this.sc.title, subtitle: this.sc.subtitle,
        icon: this.sc.icon, theme: this.sc.theme, duration: this.sc.duration,
        intro: this.sc.intro || null,
        prologue: this.sc.prologue, commonInfo: this.sc.commonInfo,
        rules: this.sc.rules, map: this.sc.map,
        phases: this.sc.phases.map(p => ({ id: p.id, type: p.type, title: p.title, minutes: p.minutes, brief: p.brief, todo: p.todo })),
        // ★名前だけ。handout も abilities も含めない
        characters: this.sc.characters.map(c => ({ id: c.id, name: c.name, gender: c.gender, color: c.color, icon: c.icon })),
        places: (this.sc.places || []).map(p => ({ id: p.id, name: p.name })), // touch は含めない
      },
      phaseIdx: this.phaseIdx,
      phase: this.phase,
      step: this.step,
      total: this.sc.phases.length,
      assign: this.assign,
      readyCount: this.readyCount(),
      movedCount: this.movedCount(),
      answeredCount: Object.keys(this.answers).length,
      playerCount: this.sc.characters.length,
      publicLog: this.publicLog,
      authorityDeclared: this.authorityDeclared,
      // 「誰が誰に命じたか」だけ公開。中身は対象者にしか送らない
      orderCount: this.orders.filter(o => !o.void).length,
      result: this.result,
    };
  }

  /* ★自分のぶんだけ */
  privateView(charId) {
    const c = this.char(charId);
    if (!c) return null;
    const list = c.abilities.map(a => ({ ...a }));
    if (this.copied[charId]) {
      const src = this.sc.characters.find(x => x.abilities.some(a => a.id === this.copied[charId]));
      list.push({ ...src.abilities.find(a => a.id === this.copied[charId]), copied: true, from: src.name });
    }
    const acts = {};
    list.forEach(a => {
      const def = this.sc.abilityActions[a.id];
      if (def) acts[a.id] = { ...def, copied: !!a.copied, usable: a.usableInGame !== false || !!a.copied, unusableReason: a.unusableReason || '' };
    });
    const isFinal = this.phaseType === 'final' || this.phaseType === 'ending';
    return {
      charId,
      character: { id: c.id, name: c.name, gender: c.gender, color: c.color, icon: c.icon, abilities: list, handout: c.handout },
      abilityActions: acts,
      abilityPool: this.pool,   // シャッフル済み(本物とダミーが混ざった順)
      usesLeft: this.maxUses() - this.used[charId],
      copied: this.copied[charId],
      known: this.known[charId].map(k => ({
        charName: this.char(k.char).name, keyword: this.ability(k.char, k.abilityId).keyword,
      })),
      // ★自分の手札だけ。出したかどうかも自分にしか分からない
      cards: (c.cards || []).map(x => ({ ...x, played: this.playedCards[charId].includes(x.id) })),
      // ★自分に向けられた命令だけ
      myOrders: this.orders.filter(o => o.target === charId).map(o => {
        const q = this.sc.finalQuestions.find(x => x.id === o.questionId);
        return {
          questionId: o.questionId, answerId: o.answerId, void: o.void,
          questionText: q ? q.text : '',
          answerLabel: q ? (q.options.find(op => op.id === o.answerId) || {}).label : '',
        };
      }),
      canOrder: (this.sc.orders && this.sc.orders.by === charId && !this.authorityDeclared) ? {
        ...this.sc.orders,
        options: this.sc.orders.options.map(o => {
          const q = this.sc.finalQuestions.find(x => x.id === o.questionId);
          return { ...o, id: `${o.questionId}:${o.answerId}`, questionText: q ? q.text : '' };
        }),
      } : null,
      authority: (this.sc.authority && this.sc.authority.by === charId) ? {
        ...this.sc.authority, declared: this.authorityDeclared,
      } : null,
      authorityDeclared: this.authorityDeclared,
      log: this.log[charId],
      lastResults: this.lastResults[charId] || [],
      ready: this.ready.has(charId),
      moved: !!(this.moves[this.phaseIdx] || {})[charId],
      answered: !!this.answers[charId],
      finalQuestions: isFinal ? this.sc.finalQuestions.map(q => ({ id: q.id, text: q.text, options: q.options })) : null,
      abilityGuess: isFinal ? { text: this.sc.abilityGuess.text, pool: this.pool } : null,
    };
  }
}

module.exports = { Game, loadScenario, listScenarios, STEPS };
