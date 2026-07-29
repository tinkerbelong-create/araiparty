/* マーダーミステリー共通エンジン (core)
 * シナリオJSONを読み込み、フェーズ進行・行動解決・採点を行う。
 * 秘匿情報(他人のHO・真相・未取得の手がかり)は一切ここから外に出さない。
 * server側は必ず publicView() / privateView() 経由でクライアントへ配信すること。
 *
 * ── 行動フェーズの考え方 ──
 * 全員が毎回「1か所へ調べに行く」。能力はその上に1つだけ重ねられる(ゲーム中2回まで)。
 * 調査を全員に開放したことで、各能力に固有の役割が生まれる:
 *   ドア開閉  = 他人の調査を封じる
 *   偽物設置  = 他人の調査結果を汚染する
 *   カメラ    = 自分が行かない場所の人の動きを掴む
 *   すり抜け  = 閉ざされた場所へ手を伸ばす(ドア封じの対抗手段)
 *   同化      = 自分がいる場所の来訪者を目撃する
 *   水        = 自分がいる場所の証拠を消す
 *   キーワード= 相手の能力を確定させる(得点＋相手の秘匿点を潰す)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCENARIO_DIR = path.join(__dirname, 'scenarios');

/* ── シナリオ読み込み ── */
const cache = new Map();
function loadScenario(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(SCENARIO_DIR, `${id}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(id, data);
  return data;
}
function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs.readdirSync(SCENARIO_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const s = loadScenario(f.replace(/\.json$/, ''));
      return {
        id: s.id, title: s.title, subtitle: s.subtitle || '',
        players: s.players, duration: s.duration, icon: s.icon || '🕯',
        theme: s.theme || null,
      };
    });
}

/* ── ゲーム本体 ── */
class Game {
  constructor(scenarioId) {
    this.sc = loadScenario(scenarioId);
    this.scenarioId = scenarioId;
    this.phaseIdx = -1;                 // -1 = 未開始(キャラ選択中)
    this.assign = {};                   // charId -> seatIdx

    this.fridgePower = !!(this.sc.world && this.sc.world.fridgePower);
    this.doors = {};                    // doorId -> 'open' | 'closed'
    (this.sc.abilityActions?.k1?.doors || []).forEach(d => { this.doors[d.id] = 'open'; });
    this.doors.fridge = 'closed';       // ナツキが22:00に勢いよく閉めたまま

    this.used = {};                     // charId -> 能力使用回数
    this.copied = {};                   // charId -> コピー中の abilityId(1回分)
    this.known = {};                    // charId -> [{char, abilityId}]
    this.erased = new Set();            // 水で流された placeId
    this.fakes = [];                    // {objId, objName, placeId, byChar, phaseIdx}
    this.cams = [];                     // {placeId, byChar, label}
    this.log = {};                      // charId -> [{phase, title, text}] 本人だけの記録
    this.moves = {};                    // phaseIdx -> { charId: move }
    this.publicLog = [];                // 全員に見える出来事
    this.answers = {};
    this.result = null;

    this.sc.characters.forEach(c => {
      this.used[c.id] = 0; this.known[c.id] = []; this.log[c.id] = []; this.copied[c.id] = null;
    });
    // シナリオ開始時点ですでに掴んでいるキーワード(HOに書かれているもの)
    Object.entries(this.sc.initialKnown || {}).forEach(([cid, arr]) => {
      arr.forEach(k => this.known[cid].push({ char: k.char, abilityId: k.abilityId }));
    });
    // 開始時点ですでに仕掛かっているもの
    (this.sc.initialCams || []).forEach(c => this.cams.push({ ...c }));
  }

  get phase() { return this.phaseIdx >= 0 ? this.sc.phases[this.phaseIdx] : null; }
  get phaseType() { return this.phase ? this.phase.type : 'select'; }
  char(id) { return this.sc.characters.find(c => c.id === id); }
  ability(charId, abId) { return this.char(charId)?.abilities.find(a => a.id === abId); }
  place(id) { return (this.sc.places || []).find(p => p.id === id); }
  maxUses() { return 2; }

  /* すり抜け先が明るいか。部屋は基本明るく、冷蔵庫だけ電源＋扉に依存する */
  isLit(placeId) {
    const p = this.place(placeId);
    if (!p || !p.dark) return true;
    return this.fridgePower && this.doors.fridge === 'open';
  }
  /* ドアが閉められていて入れない場所か */
  isBlocked(placeId) {
    const p = this.place(placeId);
    if (!p || !p.door) return false;
    return this.doors[placeId] === 'closed';
  }

  advance() {
    if (this.phaseIdx < this.sc.phases.length - 1) { this.phaseIdx++; return true; }
    return false;
  }

  /* ── 行動の登録(同時提出) ──
   * move = { placeId, extra, abilityId, target } */
  submitMove(charId, move) {
    if (this.phaseType !== 'ability') return { ok: false, msg: '今は行動できません' };
    const bucket = (this.moves[this.phaseIdx] ||= {});
    if (bucket[charId]) return { ok: false, msg: 'このフェーズではもう行動しています' };
    move = move || {};
    if (!move.placeId || !this.place(move.placeId)) return { ok: false, msg: '調べに行く場所を選んでください' };
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
    const bucket = this.moves[this.phaseIdx] || {};
    return this.sc.characters.every(c => !!bucket[c.id]);
  }

  /* ── 同時解決 ──
   * ①ドア → ②偽物 → ③カメラ → ④電源 → ⑤移動＆調査 → ⑥すり抜け
   * → ⑦水(証拠隠滅) → ⑧同化/カメラ報告 → ⑨キーワード/コピー */
  resolvePhase() {
    const bucket = this.moves[this.phaseIdx] || {};
    const phaseName = this.sc.phases[this.phaseIdx].title;
    const out = {};
    const push = (cid, title, text) => { (out[cid] ||= []).push({ title, text }); };
    const act = id => this.sc.abilityActions[id];
    const entries = Object.entries(bucket);
    const withAbility = r => entries.filter(([cid, m]) =>
      m.abilityId && act(m.abilityId) && act(m.abilityId).resolve === r);

    // 誰がどこへ動いたか(同化・カメラの検知に使う)
    const presence = {};
    entries.forEach(([cid, m]) => { (presence[m.placeId] ||= []).push(cid); });

    /* ① ドア開閉 */
    for (const [cid, m] of withAbility('toggle_door')) {
      const d = act('k1').doors.find(x => x.id === m.target?.doorId);
      if (!d) { push(cid, act('k1').label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      const opening = this.doors[d.id] === 'closed';
      this.doors[d.id] = opening ? 'open' : 'closed';
      let t = `${d.name}を${opening ? '開けた' : '閉めた'}。`;
      if (d.id === 'fridge') {
        t += this.fridgePower
          ? (opening ? ' 庫内灯がついた。' : ' 庫内は暗くなった。')
          : ' ……電源が入っていないので、庫内は暗いままだ。';
      } else {
        t += opening ? ' これで誰でも入れる。' : ' これでもう、誰もここには入れない。';
      }
      push(cid, act('k1').label, t);
      this.publicLog.push({ phase: phaseName, text: `${d.name}が${opening ? '開いている' : '閉まっている'}。` });
    }

    /* ② 偽物設置 */
    for (const [cid, m] of withAbility('plant_fake')) {
      const A = act('r2');
      const obj = A.objects.find(o => o.id === m.target?.objId);
      const pl = this.place(m.target?.placeId);
      if (!obj || !pl) { push(cid, A.label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      this.fakes.push({ objId: obj.id, objName: obj.name, placeId: pl.id, byChar: cid, phaseIdx: this.phaseIdx });
      push(cid, A.label, `${obj.name}の偽物を作り、${pl.name}に置いた。3時間で消える。触っても機能はしないし、味も匂いもない。`);
    }

    /* ③ カメラ設置 */
    for (const [cid, m] of withAbility('watch_place')) {
      const A = act('r3');
      const pl = this.place(m.target?.placeId);
      if (!pl) { push(cid, A.label, '対象が見つからなかった。'); continue; }
      this.useUp(cid, m);
      this.cams.push({ placeId: pl.id, byChar: cid, label: `${phaseName}に仕込んだカメラ` });
      push(cid, A.label, `${pl.name}にカメラを仕込んだ。以後、ここに来た人が分かる。`);
    }

    /* ④ 電源など、場所ごとの操作 */
    for (const [cid, m] of entries) {
      if (m.extra !== 'action') continue;
      const pl = this.place(m.placeId);
      if (!pl || !pl.action || this.isBlocked(pl.id)) continue;
      if (pl.action.id === 'power') {
        this.fridgePower = !this.fridgePower;
        push(cid, pl.action.id === 'power' ? '電源コード' : pl.action.id,
          this.fridgePower ? pl.action.onText : pl.action.offText);
        this.publicLog.push({ phase: phaseName, text: `冷蔵庫の電源が${this.fridgePower ? '入っている' : '切れている'}。` });
      }
    }

    /* ⑤ 移動して調べる(全員) */
    for (const [cid, m] of entries) {
      const pl = this.place(m.placeId);
      if (this.isBlocked(pl.id)) {
        push(cid, `${pl.name}へ`, 'ドアが閉まっていて、中に入れなかった。……誰かが閉めたらしい。');
        continue;
      }
      if (pl.openOnVisit && this.doors.fridge === 'closed') this.doors.fridge = 'open';
      push(cid, `${pl.name}を調べた`, this.clueText(pl.id, cid));
    }

    /* ⑥ すり抜け(調べに行った場所とは別の1か所へ手を伸ばす) */
    for (const [cid, m] of withAbility('peek_place')) {
      const A = act('n1');
      const pl = this.place(m.target?.placeId);
      if (!pl) { push(cid, A.label, '対象が見つからなかった。'); continue; }
      if (!this.isLit(pl.id)) { push(cid, A.label, A.failIfDark); continue; } // 失敗なので回数を消費しない
      this.useUp(cid, m);
      push(cid, `${A.label} → ${pl.name}`, this.clueText(pl.id, cid));
    }

    /* ⑦ 水で洗い流す(自分が調べに行った場所) */
    for (const [cid, m] of withAbility('wash_here')) {
      const A = act('r1');
      const pl = this.place(m.placeId);
      if (this.isBlocked(pl.id)) { push(cid, A.label, 'そこには入れなかった。'); continue; }
      this.useUp(cid, m);
      if (this.erased.has(pl.id)) { push(cid, A.label, A.emptyText); continue; }
      this.erased.add(pl.id);
      push(cid, A.label, `${A.text}\n(${pl.name}の手がかりは、もう誰にも見つからない)`);
    }

    /* ⑧ 同化 — 調べに行った場所の来訪者を目撃 */
    for (const [cid, m] of withAbility('observe_here')) {
      const A = act('n3');
      const pl = this.place(m.placeId);
      if (this.isBlocked(pl.id)) { push(cid, A.label, 'ドアが閉まっていて、同化する壁にたどり着けなかった。'); continue; }
      this.useUp(cid, m);
      const others = (presence[pl.id] || []).filter(x => x !== cid);
      push(cid, A.label, others.length
        ? `${pl.name}の壁になりきった。\nこの場所に現れたのは——${others.map(x => this.char(x).name).join('、')}。`
        : `${pl.name}の壁になりきった。\nこのあいだ、ここには誰も来なかった。`);
    }

    /* ⑧' カメラの報告(設置済みのものすべて) */
    const camReported = new Set();
    for (const cam of this.cams) {
      const key = cam.byChar + ':' + cam.placeId;
      if (camReported.has(key)) continue;
      camReported.add(key);
      const others = (presence[cam.placeId] || []).filter(x => x !== cam.byChar);
      const pl = this.place(cam.placeId);
      if (!pl) continue;
      let t;
      if (!others.length) t = `${pl.name}——このあいだ、誰も来なかった。`;
      else if (this.isLit(cam.placeId)) t = `${pl.name}——映像に映った。${others.map(x => this.char(x).name).join('、')}が来ている。`;
      else t = `${pl.name}——${act('r3').darkText} 誰かがここにいる。だが暗くて、誰かまでは分からない。`;
      push(cam.byChar, '📹 カメラの映像', t);
    }

    /* ⑨ キーワード / コピー */
    for (const [cid, m] of withAbility('steal_keyword')) {
      const A = act('k2');
      const tc = this.char(m.target?.charId);
      if (!tc || tc.id === cid) { push(cid, A.label, '対象が見つからなかった。'); continue; }
      const got = this.known[cid].filter(k => k.char === tc.id).map(k => k.abilityId);
      const rest = tc.abilities.filter(a => !got.includes(a.id));
      if (!rest.length) { push(cid, A.label, A.emptyText); continue; }
      this.useUp(cid, m);
      const pick = rest[Math.floor(Math.random() * rest.length)];
      this.known[cid].push({ char: tc.id, abilityId: pick.id });
      push(cid, A.label, `${tc.name}に触れた。頭に流れ込んできたキーワードは——「${pick.keyword}」。`);
    }
    for (const [cid, m] of withAbility('copy_ability')) {
      const A = act('n2');
      const tc = this.char(m.target?.charId);
      const ok = tc && tc.id !== cid && tc.abilities.some(a => a.id === m.target?.abilityId);
      this.useUp(cid, m);
      if (ok) {
        this.copied[cid] = m.target.abilityId;
        push(cid, A.label, `${A.successText}\n\nコピーした能力: 「${this.ability(tc.id, m.target.abilityId).name}」`);
      } else {
        push(cid, A.label, A.failText);
      }
    }
    for (const [cid, m] of withAbility('unusable')) {
      push(cid, act(m.abilityId).label, act(m.abilityId).text);
    }

    // 能力を使った人は全員に伝わる(原作の「宣言する」ルール)
    const users = entries.filter(([, m]) => m.abilityId).map(([cid]) => this.char(cid).name);
    this.publicLog.push({
      phase: phaseName,
      text: users.length ? `${users.join('、')}が能力を使った。` : '誰も能力を使わなかった。',
    });

    Object.entries(out).forEach(([cid, arr]) => {
      arr.forEach(r => this.log[cid].push({ phase: phaseName, ...r }));
    });
    return out;
  }

  useUp(cid, m) {
    if (this.copied[cid] === m.abilityId) this.copied[cid] = null;
    else this.used[cid]++;
  }

  /* 場所の手がかり(消された場所・置かれた偽物・仕込まれたカメラを反映) */
  clueText(placeId, viewerId) {
    const pl = this.place(placeId);
    if (this.erased.has(placeId)) return '床がうっすら濡れている。……それ以外、めぼしいものは何も残っていない。';
    let t = pl.clue;
    const fakes = this.fakes.filter(f => f.placeId === placeId && f.byChar !== viewerId);
    if (fakes.length) t += `\n\nそして——${fakes.map(f => f.objName).join('と')}が置かれている。`;
    const cams = this.cams.filter(c => c.placeId === placeId && c.byChar !== viewerId);
    if (cams.length) t += '\n\nさらに、目を凝らすと——ゴマ粒ほどの黒い異物が貼りついている。カメラ、だろうか。';
    return t;
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
    const chars = this.sc.characters;
    const Q = this.sc.finalQuestions;
    const ans = this.answers;

    const exposed = {};
    chars.forEach(t => t.abilities.forEach(a => { exposed[`${t.id}:${a.id}`] = false; }));
    chars.forEach(guesser => {
      const g = ans[guesser.id]?.abilities || {};
      Object.entries(g).forEach(([targetId, ids]) => {
        if (targetId === guesser.id) return;
        (ids || []).forEach(id => { if (exposed[`${targetId}:${id}`] === false) exposed[`${targetId}:${id}`] = true; });
      });
    });

    const guessHits = {};
    chars.forEach(guesser => {
      let hit = 0;
      const g = ans[guesser.id]?.abilities || {};
      Object.entries(g).forEach(([targetId, ids]) => {
        if (targetId === guesser.id) return;
        const t = this.char(targetId); if (!t) return;
        (ids || []).forEach(id => { if (t.abilities.some(a => a.id === id)) hit++; });
      });
      guessHits[guesser.id] = hit;
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
        const accusers = chars.filter(o => o.id !== rule.char)
          .filter(o => ans[o.id]?.questions?.[rule.question] === rule.char).map(o => o.name);
        got = accusers.length === 0 ? rule.points : 0;
        note = accusers.length === 0 ? '誰にも指摘されなかった' : `${accusers.join('・')}に指摘された`;
      } else if (rule.rule === 'hideAbility') {
        const safe = this.char(rule.char).abilities.filter(a => !exposed[`${rule.char}:${a.id}`]);
        got = safe.length * rule.points;
        note = `バレていない能力 ${safe.length}/3` + (safe.length ? `(${safe.map(a => a.keyword).join('・')})` : '');
      } else if (rule.rule === 'guessAbility') {
        const hit = guessHits[rule.char] || 0;
        got = Math.floor(hit / (rule.per || 2)) * rule.points;
        note = `${hit}個正解`;
      }
      d.total += got;
      d.lines.push({ label: rule.label, points: got, note });
    });

    const ranking = chars.map(c => ({ id: c.id, name: c.name, total: detail[c.id].total }))
      .sort((a, b) => b.total - a.total);
    const winner = ranking[0];

    const reveal = Q.map(q => ({
      id: q.id, text: q.text, answerLabel: this.labelOf(q, q.answer),
      byChar: chars.map(c => ({ id: c.id, name: c.name, label: this.labelOf(q, ans[c.id]?.questions?.[q.id]) })),
    }));
    const notes = chars.map(c => ({ id: c.id, name: c.name, note: ans[c.id]?.note || '' }));
    const abilityReveal = chars.map(c => ({
      id: c.id, name: c.name,
      abilities: c.abilities.map(a => ({
        keyword: a.keyword, name: a.name, note: a.note,
        exposed: exposed[`${c.id}:${a.id}`],
        guessedBy: chars.filter(o => o.id !== c.id && (ans[o.id]?.abilities?.[c.id] || []).includes(a.id)).map(o => o.name),
      })),
    }));

    this.result = {
      detail, ranking, winner, reveal, notes, abilityReveal,
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
        prologue: this.sc.prologue, commonInfo: this.sc.commonInfo,
        rules: this.sc.rules, map: this.sc.map,
        phases: this.sc.phases.map(p => ({ id: p.id, type: p.type, title: p.title, minutes: p.minutes, desc: p.desc })),
        // ★公開プロフィールのみ。handout は絶対に含めない
        characters: this.sc.characters.map(c => ({
          id: c.id, name: c.name, gender: c.gender, color: c.color, icon: c.icon, catch: c.catch,
        })),
        // clue は含めない。入れるかどうかの判定に必要な最低限だけ
        places: (this.sc.places || []).map(p => ({ id: p.id, name: p.name, door: !!p.door, dark: !!p.dark })),
      },
      phaseIdx: this.phaseIdx,
      phase: this.phase,
      assign: this.assign,
      usesLeft: Object.fromEntries(this.sc.characters.map(c => [c.id, this.maxUses() - this.used[c.id]])),
      board: {
        doors: this.doors,
        fridgePower: this.fridgePower,
        log: this.publicLog,
      },
      moved: Object.keys(this.moves[this.phaseIdx] || {}),
      answered: Object.keys(this.answers),
      result: this.result,
    };
  }

  /* ★自分のぶんだけ。他人の handout は決して入れない */
  privateView(charId) {
    const c = this.char(charId);
    if (!c) return null;
    const list = c.abilities.map(a => ({ ...a }));
    if (this.copied[charId]) {
      const src = this.sc.characters.find(x => x.abilities.some(a => a.id === this.copied[charId]));
      const a = src.abilities.find(a => a.id === this.copied[charId]);
      list.push({ ...a, copied: true, from: src.name });
    }
    const acts = {};
    list.forEach(a => {
      const def = this.sc.abilityActions[a.id];
      if (def) acts[a.id] = { ...def, copied: !!a.copied, usable: a.usableInGame !== false || !!a.copied };
    });
    const isFinal = this.phaseType === 'final' || this.phaseType === 'ending';
    return {
      charId,
      character: { id: c.id, name: c.name, gender: c.gender, color: c.color, icon: c.icon, abilities: list, handout: c.handout },
      abilityActions: acts,
      // コピー時の宣言候補。ダミーを含む全候補を出す(実在する9個だけを見せると答えが割れてしまう)
      abilityPool: this.sc.abilityGuess ? this.sc.abilityGuess.pool : [],
      usesLeft: this.maxUses() - this.used[charId],
      copied: this.copied[charId],
      known: this.known[charId].map(k => ({
        charId: k.char, charName: this.char(k.char).name, keyword: this.ability(k.char, k.abilityId).keyword,
      })),
      log: this.log[charId],
      moved: !!(this.moves[this.phaseIdx] || {})[charId],
      answered: !!this.answers[charId],
      finalQuestions: isFinal ? this.sc.finalQuestions.map(q => ({ id: q.id, text: q.text, type: q.type, options: q.options })) : null,
      abilityGuess: isFinal ? this.sc.abilityGuess : null,
    };
  }
}

module.exports = { Game, loadScenario, listScenarios };
