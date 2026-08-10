/* パーティモードを頭から終わりまで通しで動かす検証。
 * ホスト1人 + 参加者6人を実際にsocketで繋いで、3戦ぶんを最後まで進める。
 * 途中で止まったら、どのイベントで止まったかを出力する。
 *
 *   node test_party_flow.js
 */
'use strict';
const { io } = require('socket.io-client');
process.env.PORT = process.env.TEST_PORT || '3111';
require('./server.js');
const { QUESTIONS } = require('./np_questions.js');
const answerOf = (text) => (QUESTIONS.find(q => q.t === text) || {}).a;

const PORT = process.env.TEST_PORT || 3111;
const URL = `http://localhost:${PORT}`;
const NAMES = ['ゆうと', 'おばあちゃん', 'たける', 'みなみ', 'はると', 'さき'];

let ng = 0, warn = 0;
const log = (...a) => console.log(...a);
const ok   = (m) => log('  OK   ' + m);
const fail = (m) => { ng++; log('  NG   ' + m); };
const note = (m) => { warn++; log('  注意 ' + m); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 条件が満たされるまで待つ。だめなら null を返す */
async function waitFor(getState, pred, ms = 3000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = getState();
    if (s && pred(s)) return s;
    await sleep(50);
  }
  return null;
}

function connect(name) {
  return new Promise((resolve) => {
    const sock = io(URL, { transports: ['websocket'], forceNew: true });
    const box = { sock, name, pub: null, priv: null, events: [] };
    sock.on('pt:state', ({ pub, priv }) => { box.pub = pub; box.priv = priv; });
    sock.on('pt:sz:reveal', (d) => { box.events.push(['sz:reveal', d]); box.lastReveal = d; });
    sock.on('connect', () => resolve(box));
  });
}

(async () => {
  await sleep(1500); log('════ パーティモード 通し検証 ════\n');

  /* ── 1. 部屋をつくる ── */
  log('[1] 部屋をつくる');
  const host = await connect('ホスト');
  const code = await new Promise(r => host.sock.emit('pt:createRoom', { name: 'ホスト' }, x => r(x && x.code)));
  code ? ok(`あいことば = ${code}`) : fail('部屋がつくれない');
  if (!code) process.exit(1);

  /* ── 2. 6人が参加 ── */
  log('\n[2] 参加者が入る');
  const players = [];
  for (const n of NAMES) {
    const p = await connect(n);
    const res = await new Promise(r => p.sock.emit('pt:joinRoom', { code, name: n }, x => r(x)));
    if (!res || !res.ok) fail(`${n} が入れない: ${res && res.error}`);
    players.push(p);
  }
  await sleep(200);
  const roster = host.pub && Object.keys(host.pub.players).length;
  roster === 6 ? ok(`6人そろった`) : fail(`参加人数が ${roster} 人になっている`);

  /* ── 3. チーム分け(3人 + 3人) ── */
  log('\n[3] チームを2つ作って3人ずつ入れる');
  host.sock.emit('pt:addTeam', { name: 'あかチーム' });
  host.sock.emit('pt:addTeam', { name: 'あおチーム' });
  await sleep(300);
  const teamIds = Object.keys(host.pub.teams);
  teamIds.length === 2 ? ok('チーム2つ') : fail(`チームが ${teamIds.length} 個`);
  const pids = Object.values(host.pub.players).sort((a, b) => a.order - b.order).map(p => p.id);
  pids.forEach((pid, i) => host.sock.emit('pt:assignPlayer', { playerId: pid, teamId: teamIds[i % 2] }));
  await sleep(300);
  const cnt = teamIds.map(t => Object.values(host.pub.players).filter(p => p.teamId === t).length);
  cnt.every(c => c === 3) ? ok(`各チーム3人ずつ (${cnt.join(' / ')})`) : fail(`人数が偏っている (${cnt.join(' / ')})`);

  /* ── 4. 3戦の組み立て ── */
  log('\n[4] 3戦にして、1戦目ファイブリーグ / 2戦目シュゾマス / 3戦目ファイブリーグ');
  host.sock.emit('pt:setConfig', { matchCount: 3, slots: [
    { game: 'nepleague', format: 'all' }, { game: 'shuzomas', format: 'all' }, { game: 'nepleague', format: 'all' } ] });
  await sleep(300);
  const plan = host.pub.config.slots.map(s => s.game).join(' → ');
  plan === 'nepleague → shuzomas → nepleague' ? ok(plan) : note(`組み立てが ${plan} になった`);

  /* ── 5. 開始 ── */
  log('\n[5] はじめる');
  const started = await new Promise(r => host.sock.emit('pt:start', null, x => r(x)));
  (started && started.ok) ? ok('開始できた') : fail(`開始できない: ${started && started.error}`);
  let st = await waitFor(() => host.pub, s => s.phase === 'eyecatch', 3000);
  st ? ok(`1戦目の予告が出た (${st.curGameName})`) : fail('予告(eyecatch)に進まない');

  /* ══════════ 1戦目: ファイブリーグ ══════════ */
  log('\n[6] 1戦目 ファイブリーグ');
  host.sock.emit('pt:beginMatch');
  st = await waitFor(() => host.pub, s => s.phase === 'ingame' && s.game && s.game.type === 'nepleague', 3000);
  st ? ok('盤面に入った') : fail('ingame に進まない');

  host.sock.emit('pt:np:selectUnit', { unitId: teamIds[0] });
  await sleep(300);
  log(`      手番 = ${host.pub.game.activeUnitName}`);

  host.sock.emit('pt:np:deal', { difficulty: 2, genre: '一般常識' });
  st = await waitFor(() => host.pub, s => s.game && s.game.question, 3000);
  if (!st) {
    fail('★ 問題が出ない (pt:np:deal をしても question が null のまま)');
    log(`      サーバからのメッセージ: 「${host.pub.game.message}」`);
  } else {
    const q = host.pub.game;
    ok(`問題が出た`);
    log(`      問題文 = ${JSON.stringify(q.question.text)}`);
    log(`      マス数 = ${q.length} / スロット = ${q.slots.length}`);
    if (q.question.text === undefined || q.question.text === null) fail('★ 問題文が undefined。テレビに何も表示されない');
    if (!q.length || q.slots.length === 0) fail('★ マスが0個。誰も入力できない');
  }

  /* 入力してロック */
  if (host.pub.game && host.pub.game.slots.length) {
    const slots = host.pub.game.slots;
    for (const sl of slots) {
      const p = players.find(x => x.priv && x.priv.youId === sl.playerId);
      if (!p) { note(`${sl.playerName} のスロットに対応する参加者が見つからない`); continue; }
      p.sock.emit('pt:np:input', { index: sl.index, char: 'ア' });
      await sleep(60);
      p.sock.emit('pt:np:lock', { index: sl.index, locked: true });
      await sleep(60);
    }
    const locked = await waitFor(() => host.pub, s => s.game.slots.every(x => x.locked), 3000);
    locked ? ok('全員がロックできた') : fail('ロックが全員ぶん通らない');

    host.sock.emit('pt:np:open');
    const opened = await waitFor(() => host.pub, s => s.game.revealed, 3000);
    opened ? ok(`オープンできた (${host.pub.game.message})`) : fail('★ オープンしても結果が出ない');
  }

  log('\n[7] 1戦目を終えて2戦目へ');
  host.sock.emit('pt:endMatch');
  st = await waitFor(() => host.pub, s => s.phase === 'eyecatch' && s.session.index === 1, 3000);
  st ? ok(`2戦目の予告が出た (${st.curGameName})`) : fail('★ 次のゲームに進めない (endMatch しても eyecatch にならない)');

  /* ══════════ 2戦目: シュゾマス ══════════ */
  log('\n[8] 2戦目 シュゾマス');
  host.sock.emit('pt:beginMatch');
  st = await waitFor(() => host.pub, s => s.phase === 'ingame' && s.game && s.game.type === 'shuzomas', 4000);
  st ? ok('盤面に入った') : fail('★ シュゾマスが始まらない');

  if (st) {
    const seats = host.pub.game.seats;
    log(`      席 = ${seats.length}人`);
    for (let i = 0; i < seats.length; i++) {
      const p = players.find(x => x.priv && x.priv.youId === seats[i].id);
      if (!p) { note(`席${i} に対応する参加者が見つからない`); continue; }
      p.sock.emit('pt:sz:chooseMy', { ingId: i + 1 });
      await sleep(80);
    }
    const chosen = await waitFor(() => host.pub, s => s.game.seats.every(x => x.chosen), 4000);
    chosen ? ok('全員がマイ食材を選べた') : fail('★ マイ食材の選択が全員ぶん通らない');

    const brewing = await waitFor(() => host.pub, s => s.game.sub !== 'myselect', 4000);
    brewing ? ok(`醸造フェーズに進んだ (sub=${host.pub.game.sub})`) : fail('★ 全員選んでも次のフェーズに進まない');

    if (brewing) {
      for (const p of players) {
        if (!p.priv || !p.priv.sz) continue;
        p.sock.emit('pt:sz:submit', { type: 'brew', picks: [1, 2, 3] });
        await sleep(80);
      }
      const revealed = await waitFor(() => host.lastReveal, () => true, 5000);
      revealed ? ok('ラウンドが公開された') : fail('★ 全員提出してもラウンドが公開されない');
    }
  }

  log('\n[9] 2戦目を終えて3戦目へ');
  host.sock.emit('pt:endMatch');
  st = await waitFor(() => host.pub, s => s.phase === 'eyecatch' && s.session.index === 2, 3000);
  st ? ok(`3戦目の予告が出た (${st.curGameName})`) : fail('★ 3戦目に進めない');

  /* ══════════ 3戦目 → 結果 ══════════ */
  log('\n[10] 3戦目をやって結果発表まで');
  host.sock.emit('pt:beginMatch');
  await waitFor(() => host.pub, s => s.phase === 'ingame', 3000);
  host.sock.emit('pt:endMatch');
  st = await waitFor(() => host.pub, s => s.phase === 'result', 3000);
  if (st) {
    ok('結果発表まで到達');
    const scores = Object.values(host.pub.teams).map(t => `${t.name} ${t.score}pt`).join(' / ');
    log(`      得点 = ${scores}`);
    if (Object.values(host.pub.teams).every(t => t.score === 0)) note('全チーム0点。得点がどこかで入っていない');
  } else fail('★ 結果発表に進めない');


  /* ══════════ 追加検証 ══════════ */
  async function newRoom(names, mode, teamCount) {
    const h = await connect('ホスト');
    const c = await new Promise(r => h.sock.emit('pt:createRoom', { name: 'ホスト' }, x => r(x && x.code)));
    const ps = [];
    for (const n of names) { const p = await connect(n); await new Promise(r => p.sock.emit('pt:joinRoom', { code: c, name: n }, r)); ps.push(p); }
    await sleep(200);
    h.sock.emit('pt:setMode', { mode });
    if (mode === 'team') { for (let i = 0; i < teamCount; i++) h.sock.emit('pt:addTeam', { name: 'チーム' + (i + 1) }); }
    await sleep(250);
    if (mode === 'team') {
      const tids = Object.keys(h.pub.teams);
      const pids = Object.values(h.pub.players).sort((a, b) => a.order - b.order).map(p => p.id);
      pids.forEach((pid, i) => h.sock.emit('pt:assignPlayer', { playerId: pid, teamId: tids[i % tids.length] }));
      await sleep(250);
    }
    return { h, ps };
  }

  log('\n[11] 正解したときに得点が入るか');
  {
    const { h, ps } = await newRoom(NAMES, 'team', 2);
    h.sock.emit('pt:setConfig', { matchCount: 3, slots: [{ game: 'nepleague', format: 'all' }] });
    await sleep(200);
    await new Promise(r => h.sock.emit('pt:start', null, r));
    await waitFor(() => h.pub, s => s.phase === 'eyecatch', 2000);
    h.sock.emit('pt:beginMatch');
    await waitFor(() => h.pub, s => s.phase === 'ingame' && s.game && s.game.type === 'nepleague', 2000);
    const tid = Object.keys(h.pub.teams)[0];
    h.sock.emit('pt:np:selectUnit', { unitId: tid });
    await sleep(200);
    h.sock.emit('pt:np:deal', { difficulty: 3, genre: '一般常識' });
    const dealt = await waitFor(() => h.pub, s => s.game && s.game.question, 2000);
    if (!dealt) { fail('2回目の部屋で問題が出ない'); }
    else {
      const ans = answerOf(h.pub.game.question.text);
      const chars = Array.from(ans || '');
      for (const sl of h.pub.game.slots) {
        const p = ps.find(x => x.priv && x.priv.youId === sl.playerId);
        if (!p) continue;
        p.sock.emit('pt:np:input', { index: sl.index, char: chars[sl.index] });
        await sleep(50);
        p.sock.emit('pt:np:lock', { index: sl.index, locked: true });
        await sleep(50);
      }
      h.sock.emit('pt:np:open');
      const opened = await waitFor(() => h.pub, s => s.game.revealed, 2000);
      const score = h.pub.teams[tid].score;
      if (opened && h.pub.game.correctAll) ok(`正解と判定された`); else fail('★ 全員正しい文字を入れても正解にならない');
      score === 30 ? ok(`得点が入った (${score}pt = 難易度3 × 10)`) : fail(`★ 得点が ${score}pt。難易度3なら30ptのはず`);
    }
    h.sock.close(); ps.forEach(p => p.sock.close());
  }

  log('\n[12] 1チーム2人だとどうなるか(親戚4人・2チームを想定)');
  {
    const { h, ps } = await newRoom(NAMES.slice(0, 4), 'team', 2);
    h.sock.emit('pt:setConfig', { matchCount: 3, slots: [{ game: 'nepleague', format: 'all' }] });
    await sleep(200);
    await new Promise(r => h.sock.emit('pt:start', null, r));
    await waitFor(() => h.pub, s => s.phase === 'eyecatch', 2000);
    h.sock.emit('pt:beginMatch');
    await waitFor(() => h.pub, s => s.phase === 'ingame', 2000);
    h.sock.emit('pt:np:selectUnit', { unitId: Object.keys(h.pub.teams)[0] });
    await sleep(200);
    h.sock.emit('pt:np:deal', { difficulty: 2, genre: '一般常識' });
    await sleep(600);
    if (h.pub.game && h.pub.game.question) ok('2人チームでも問題が出た');
    else { note('2人チームでは問題が出ない'); log(`      画面に出る文言: 「${h.pub.game.message}」`); }
    h.sock.close(); ps.forEach(p => p.sock.close());
  }

  log('\n[13] 個人戦だとどうなるか');
  {
    const { h, ps } = await newRoom(NAMES.slice(0, 3), 'individual', 0);
    h.sock.emit('pt:setConfig', { matchCount: 3, slots: [{ game: 'nepleague', format: 'all' }] });
    await sleep(200);
    const r = await new Promise(x => h.sock.emit('pt:start', null, x));
    (r && r.ok) ? ok('個人戦で開始できた') : fail(`個人戦で開始できない: ${r && r.error}`);
    await waitFor(() => h.pub, s => s.phase === 'eyecatch', 2000);
    h.sock.emit('pt:beginMatch');
    await waitFor(() => h.pub, s => s.phase === 'ingame', 2000);
    const pid = Object.keys(h.pub.players)[0];
    h.sock.emit('pt:np:selectUnit', { unitId: pid });
    await sleep(200);
    h.sock.emit('pt:np:deal', { difficulty: 1, genre: '一般常識' });
    const d = await waitFor(() => h.pub, s => s.game && s.game.question, 2000);
    if (d) { ok(`個人戦でも問題が出た (マス${h.pub.game.length})`); }
    else { fail('★ 個人戦で問題が出ない'); log(`      文言: 「${h.pub.game.message}」`); }
    h.sock.close(); ps.forEach(p => p.sock.close());
  }

  /* ── まとめ ── */
  log(`\n════ 結果: 失敗 ${ng} 件 / 注意 ${warn} 件 ════`);
  players.forEach(p => p.sock.close());
  host.sock.close();
  process.exit(ng ? 1 : 0);
})().catch(e => { console.error('検証スクリプト自体が落ちました:', e); process.exit(2); });
