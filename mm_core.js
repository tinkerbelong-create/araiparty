/* マーダーミステリー共通エンジン (core)
 * シナリオJSONを読み込み、フェーズ進行・能力解決・採点を行う。
 * 秘匿情報(他人のHO・真相・未取得の手がかり)は一切ここから外に出さない。
 * server側は必ず publicView() / privateView() 経由でクライアントへ配信すること。 */
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
    this.world = JSON.parse(JSON.stringify(this.sc.world || {}));
    this.doors = {};                    // doorId -> open?
    (this.sc.abilityActions?.k1?.doors || []).forEach(d => { this.doors[d.id] = false; });
    this.doors.fridge = !!this.world.fridgeDoorOpen;

    this.used = {};                     // charId -> 使用済み能力回数
    this.copied = {};                   // charId -> コピー済み abilityId(1回分)
    this.known = {};                    // charId -> 掴んだキーワード [{char, abilityId}]
    this.fakes = [];                    // {objId, placeId, byChar, phaseIdx}
    this.cams = [];                     // {placeId, byChar, fromPhase}
    this.log = {};                      // charId -> [{phase, title, text}] 自分だけの調査ログ
    this.moves = {};                    // phaseIdx -> { charId: {abilityId, target} }
    this.answers = {};                  // charId -> {questions:{}, abilities:{targetChar:[ids]}}
    this.result = null;

    this.sc.characters.forEach(c => {
      this.used[c.id] = 0; this.known[c.id] = []; this.log[c.id] = []; this.copied[c.id] = null;
    });
  }

  get phase() { return this.phaseIdx >= 0 ? this.sc.phases[this.phaseIdx] : null; }
  get phaseType() { return this.phase ? this.phase.type : 'select'; }
  char(id) { return this.sc.characters.find(c => c.id === id); }
  ability(charId, abId) { return this.char(charId)?.abilities.find(a => a.id === abId); }
  place(id) { return (this.sc.places || []).find(p => p.id === id); }
  maxUses() { return 2; }

  /* 場所が明るいか(冷蔵庫の中だけ電源+扉に依存) */
  isLit(placeId) {
    const p = this.place(placeId);
    if (!p || !p.dark) return true;
    if (placeId === 'fridge') return !!this.world.fridgePower && !!this.doors.fridge;
    return false;
  }
  /* ドアが閉じられていて入れないか */
  isBlocked(placeId) {
    if (placeId === 'fridge') return false;
    return this.doors[placeId] === true ? false : (this.doors[placeId] === 'closed');
  }

  advance() {
    if (this.phaseIdx < this.sc.phases.length - 1) { this.phaseIdx++; return true; }
    return false;
  }

  /* ── 能力使用の登録(同時提出) ── */
  submitMove(charId, move) {
    if (this.phaseType !== 'ability') return { ok: false, msg: '今は能力を使えません' };
    const bucket = (this.moves[this.phaseIdx] ||= {});
    if (bucket[charId]) return { ok: false, msg: 'このフェーズではもう行動しています' };
    if (move && move.abilityId) {
      const isCopy = this.copied[charId] === move.abilityId;
      if (!isCopy) {
        if (this.used[charId] >= this.maxUses()) return { ok: false, msg: '能力の使用回数(2回)を使い切っています' };
        const own = this.ability(charId, move.abilityId);
        if (!own) return { ok: false, msg: 'その能力は持っていません' };
      }
    }
    bucket[charId] = move || { abilityId: null };
    return { ok: true };
  }
  allMoved() {
    const bucket = this.moves[this.phaseIdx] || {};
    return this.sc.characters.every(c => !!bucket[c.id]);
  }

  /* ── 能力フェーズの同時解決 ──
   * 解決順: ①ドア開閉 → ②偽物設置 → ③カメラ設置 → ④覗き見/観察 → ⑤キーワード/コピー
   * これにより「カイトが扉を閉める → ナツキのすり抜けが失敗」等の干渉が成立する。 */
  resolvePhase() {
    const bucket = this.moves[this.phaseIdx] || {};
    const out = {};   // charId -> [{title, text}]
    const push = (cid, title, text) => { (out[cid] ||= []).push({ title, text }); };
    const entries = Object.entries(bucket).filter(([, m]) => m && m.abilityId);
    const order = { toggle_door: 0, plant_fake: 1, watch_place: 2, peek_place: 3, observe_place: 3, steal_keyword: 4, copy_ability: 4, flavor: 5, unusable: 5 };
    entries.sort((a, b) => {
      const ra = this.sc.abilityActions[a[1].abilityId]?.resolve;
      const rb = this.sc.abilityActions[b[1].abilityId]?.resolve;
      return (order[ra] ?? 9) - (order[rb] ?? 9);
    });

    // 誰がどこに現れたか(カメラ/同化の検知用)
    const presence = {};  // placeId -> [charId]
    entries.forEach(([cid, m]) => {
      const act = this.sc.abilityActions[m.abilityId];
      if (!act) return;
      if (['peek_place', 'observe_place', 'plant_fake', 'watch_place'].includes(act.resolve)) {
        const pl = m.target?.placeId || m.target?.place;
        if (pl) (presence[pl] ||= []).push(cid);
      }
    });

    for (const [cid, m] of entries) {
      const act = this.sc.abilityActions[m.abilityId];
      if (!act) continue;
      const isCopy = this.copied[cid] === m.abilityId;
      if (isCopy) this.copied[cid] = null; else this.used[cid]++;
      const label = act.label;

      switch (act.resolve) {
        case 'unusable':
          push(cid, label, act.text);
          this.used[cid]--; // 使えなかったので回数は戻す
          break;

        case 'flavor':
          push(cid, label, act.text);
          break;

        case 'toggle_door': {
          const id = m.target?.doorId;
          const door = (act.doors || []).find(d => d.id === id);
          if (!door) { push(cid, label, '対象が見つからなかった。'); break; }
          const opening = !this.doors[id];
          this.doors[id] = opening;
          let t = `${door.name}を${opening ? '開けた' : '閉めた'}。`;
          if (id === 'fridge') {
            t += this.world.fridgePower
              ? (opening ? ' 庫内灯がついた。' : ' 庫内は暗くなった。')
              : ' ……電源が入っていないので、庫内は暗いままだ。';
          }
          push(cid, label, t);
          break;
        }

        case 'plant_fake': {
          const objId = m.target?.objId, placeId = m.target?.placeId;
          const obj = (act.objects || []).find(o => o.id === objId);
          const pl = this.place(placeId);
          if (!obj || !pl) { push(cid, label, '対象が見つからなかった。'); break; }
          this.fakes.push({ objId, objName: obj.name, placeId, byChar: cid, phaseIdx: this.phaseIdx });
          push(cid, label, `${obj.name}の偽物を作り、${pl.name}に置いた。3時間で消える。触っても機能はしないし、味も匂いもない。`);
          break;
        }

        case 'watch_place': {
          const placeId = m.target?.placeId;
          const pl = this.place(placeId);
          if (!pl) { push(cid, label, '対象が見つからなかった。'); break; }
          this.cams.push({ placeId, byChar: cid, fromPhase: this.phaseIdx });
          const others = (presence[placeId] || []).filter(x => x !== cid);
          const lit = this.isLit(placeId);
          let t = `${pl.name}にカメラを仕込んだ。`;
          if (others.length === 0) t += ' このフェーズの間、誰も来なかった。';
          else if (lit) t += ` 映像に映った——${others.map(x => this.char(x).name).join('、')}が来ている。`;
          else t += ` ${act.darkText} 誰かがここで動いている。だが暗くて誰かは分からない。`;
          push(cid, label, t);
          break;
        }

        case 'peek_place': {
          const placeId = m.target?.placeId;
          const pl = this.place(placeId);
          if (!pl) { push(cid, label, '対象が見つからなかった。'); break; }
          if (!this.isLit(placeId)) { push(cid, label, act.failIfDark); this.used[cid]--; break; }
          push(cid, label, this.clueText(placeId, cid));
          break;
        }

        case 'observe_place': {
          const placeId = m.target?.placeId;
          const pl = this.place(placeId);
          if (!pl) { push(cid, label, '対象が見つからなかった。'); break; }
          const others = (presence[placeId] || []).filter(x => x !== cid);
          let t = `${pl.name}の壁になりきった。\n${this.clueText(placeId, cid)}`;
          if (others.length) t += `\n\nそして——${others.map(x => this.char(x).name).join('、')}がこの場所に現れた。`;
          push(cid, label, t);
          break;
        }

        case 'steal_keyword': {
          const targetChar = m.target?.charId;
          const tc = this.char(targetChar);
          if (!tc || targetChar === cid) { push(cid, label, '対象が見つからなかった。'); break; }
          const got = this.known[cid].filter(k => k.char === targetChar).map(k => k.abilityId);
          const rest = tc.abilities.filter(a => !got.includes(a.id));
          if (!rest.length) { push(cid, label, act.emptyText); this.used[cid]--; break; }
          const pick = rest[Math.floor(Math.random() * rest.length)];
          this.known[cid].push({ char: targetChar, abilityId: pick.id });
          push(cid, label, `${tc.name}に触れた。頭に流れ込んできたキーワードは——「${pick.keyword}」。`);
          break;
        }

        case 'copy_ability': {
          const targetChar = m.target?.charId, abId = m.target?.abilityId;
          const tc = this.char(targetChar);
          const ok = tc && targetChar !== cid && tc.abilities.some(a => a.id === abId);
          if (ok) {
            this.copied[cid] = abId;
            const a = this.ability(targetChar, abId);
            push(cid, label, `${act.successText}\n\nコピーした能力: 「${a.name}」`);
          } else {
            push(cid, label, act.failText);
          }
          break;
        }

        default:
          push(cid, label, '何も起きなかった。');
      }
    }

    // ログに保存
    Object.entries(out).forEach(([cid, arr]) => {
      arr.forEach(r => this.log[cid].push({ phase: this.sc.phases[this.phaseIdx].title, ...r }));
    });
    return out;
  }

  /* 場所の手がかり(その場に置かれた偽物も混ざる) */
  clueText(placeId, viewerId) {
    const pl = this.place(placeId);
    let t = pl.clue;
    const here = this.fakes.filter(f => f.placeId === placeId && f.byChar !== viewerId);
    if (here.length) t += `\n\nさらに——${here.map(f => f.objName).join('と')}が置かれている。`;
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

    // 各能力がバレたか: 他の誰か1人でも正しく指摘していればバレ
    const exposed = {}; // `${charId}:${abId}` -> true
    chars.forEach(target => {
      target.abilities.forEach(a => { exposed[`${target.id}:${a.id}`] = false; });
    });
    chars.forEach(guesser => {
      const g = ans[guesser.id]?.abilities || {};
      Object.entries(g).forEach(([targetId, ids]) => {
        if (targetId === guesser.id) return;
        (ids || []).forEach(id => {
          if (exposed[`${targetId}:${id}`] === false) exposed[`${targetId}:${id}`] = true;
        });
      });
    });

    // 能力当て正解数(自分が他人について当てた数)
    const guessHits = {};
    chars.forEach(guesser => {
      let hit = 0;
      const g = ans[guesser.id]?.abilities || {};
      Object.entries(g).forEach(([targetId, ids]) => {
        if (targetId === guesser.id) return;
        const t = this.char(targetId);
        if (!t) return;
        (ids || []).forEach(id => { if (t.abilities.some(a => a.id === id)) hit++; });
      });
      guessHits[guesser.id] = hit;
    });

    const detail = {};
    chars.forEach(c => { detail[c.id] = { total: 0, lines: [] }; });

    (this.sc.scoring || []).forEach(rule => {
      const d = detail[rule.char];
      if (!d) return;
      let got = 0, note = '';
      const q = Q.find(x => x.id === rule.question);

      if (rule.rule === 'correct') {
        const my = ans[rule.char]?.questions?.[rule.question];
        const ok = q && my === q.answer;
        got = ok ? rule.points : 0;
        note = ok ? '正解' : `不正解(あなたの回答: ${this.labelOf(q, my)})`;
      } else if (rule.rule === 'notAccused') {
        const accusers = chars.filter(o => o.id !== rule.char)
          .filter(o => ans[o.id]?.questions?.[rule.question] === rule.char)
          .map(o => o.name);
        got = accusers.length === 0 ? rule.points : 0;
        note = accusers.length === 0 ? '誰にも指摘されなかった' : `${accusers.join('・')}に指摘された`;
      } else if (rule.rule === 'hideAbility') {
        const safe = this.char(rule.char).abilities.filter(a => !exposed[`${rule.char}:${a.id}`]);
        got = safe.length * rule.points;
        note = `バレていない能力 ${safe.length}/3` +
          (safe.length ? `(${safe.map(a => a.keyword).join('・')})` : '');
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

    // 全員の回答を公開用に整形
    const reveal = Q.map(q => ({
      id: q.id, text: q.text,
      answerLabel: this.labelOf(q, q.answer),
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
        places: (this.sc.places || []).map(p => ({ id: p.id, name: p.name })), // clue は含めない
      },
      phaseIdx: this.phaseIdx,
      phase: this.phase,
      assign: this.assign,
      usesLeft: Object.fromEntries(this.sc.characters.map(c => [c.id, this.maxUses() - this.used[c.id]])),
      doors: this.doors,
      moved: Object.keys(this.moves[this.phaseIdx] || {}),
      answered: Object.keys(this.answers),
      result: this.result,
    };
  }

  /* ★自分のぶんだけ。他人の handout は決して入れない */
  privateView(charId) {
    const c = this.char(charId);
    if (!c) return null;
    const acts = {};
    const list = [...c.abilities];
    if (this.copied[charId]) {
      const src = this.sc.characters.find(x => x.abilities.some(a => a.id === this.copied[charId]));
      const a = src.abilities.find(a => a.id === this.copied[charId]);
      list.push({ ...a, copied: true, from: src.name });
    }
    list.forEach(a => {
      const def = this.sc.abilityActions[a.id];
      if (def) acts[a.id] = { ...def, copied: !!a.copied };
    });
    return {
      charId,
      character: {
        id: c.id, name: c.name, gender: c.gender, color: c.color, icon: c.icon,
        abilities: list, handout: c.handout,
      },
      abilityActions: acts,
      usesLeft: this.maxUses() - this.used[charId],
      copied: this.copied[charId],
      known: this.known[charId].map(k => ({
        charName: this.char(k.char).name,
        keyword: this.ability(k.char, k.abilityId).keyword,
      })),
      log: this.log[charId],
      moved: !!(this.moves[this.phaseIdx] || {})[charId],
      answered: !!this.answers[charId],
      myAnswers: this.answers[charId] || null,
      finalQuestions: this.phaseType === 'final' || this.phaseType === 'ending' ? this.sc.finalQuestions.map(q => ({
        id: q.id, text: q.text, type: q.type, options: q.options, // answer は含めない
      })) : null,
      abilityGuess: this.phaseType === 'final' || this.phaseType === 'ending' ? this.sc.abilityGuess : null,
    };
  }
}

module.exports = { Game, loadScenario, listScenarios };
