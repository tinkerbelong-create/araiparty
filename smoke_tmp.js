const io = require('socket.io-client');
const URL = 'http://localhost:3111';
const mk = () => io(URL, { transports:['websocket'] });
const P = (s,ev,arg) => new Promise(r => s.emit(ev, arg, r));
const wait = ms => new Promise(r => setTimeout(r, ms));
const states = {};
(async () => {
  const A = mk(), B = mk(), C = mk();
  [['A',A],['B',B],['C',C]].forEach(([k,s]) => s.on('mm:state', st => states[k]=st));
  await wait(400);
  const r1 = await P(A,'mm:create',{name:'あらい',scenarioId:'cake'});
  console.log('create', r1);
  const code = r1.code;
  console.log('join B', await P(B,'mm:join',{code,name:'びー'}));
  console.log('join C', await P(C,'mm:join',{code,name:'しー'}));
  console.log('toSelect', await P(A,'mm:toSelect',{}));
  await wait(200);
  console.log('pick', await P(A,'mm:pick',{charId:'natsuki'}), await P(B,'mm:pick',{charId:'ryusei'}), await P(C,'mm:pick',{charId:'kaito'}));
  console.log('dup pick', await P(B,'mm:pick',{charId:'natsuki'}));
  console.log('start', await P(A,'mm:start',{}));
  await wait(200);
  console.log('phase:', states.A.pub.phase.title, '| priv char:', states.A.priv.character.name);
  // 秘匿チェック
  const leak = JSON.stringify(states.A).includes('おれの能力を最大限使う');
  console.log('★他人のHO漏れ:', leak ? 'あり!!!' : 'なし');
  const truthLeak = JSON.stringify(states.A).includes('偽物のケーキを冷蔵庫に設置');
  console.log('★真相漏れ:', truthLeak ? 'あり!!!' : 'なし');

  await P(A,'mm:next',{}); await wait(150); // talk1
  await P(A,'mm:next',{}); await wait(150); // act1
  console.log('phase:', states.A.pub.phase.title);
  let got = null; A.on('mm:reveal', d => got = d);
  console.log('act A', await P(A,'mm:act',{abilityId:'n1',target:{placeId:'r_kaito'}}));
  console.log('act B', await P(B,'mm:act',{abilityId:'r3',target:{placeId:'kitchen'}}));
  console.log('act C', await P(C,'mm:act',{abilityId:'k2',target:{charId:'natsuki'}}));
  await wait(1200);
  console.log('reveal to A:', got && got.results[0].text.slice(0,50));
  console.log('phase now:', states.A.pub.phase.title);
  // final まで進める
  while (states.A.pub.phase.type !== 'final') { await P(A,'mm:next',{}); await wait(200); }
  console.log('phase:', states.A.pub.phase.title, '| 設問数:', states.A.priv.finalQuestions.length);
  const q = { q_eater:'ryusei', q_fake:'kaito', q_taste:'a', q_jewel:'a', q_fail:'a', q_sound1:'a', q_sound2:'a' };
  await P(A,'mm:answers',{questions:q, abilities:{ryusei:['r1','r2','r3'],kaito:['k1','k2','k3']}, note:'リュウセイが偽物とすり替えた'});
  await P(B,'mm:answers',{questions:q, abilities:{}, note:''});
  await P(C,'mm:answers',{questions:q, abilities:{}, note:''});
  await wait(1200);
  console.log('stage:', states.A.lobby.stage);
  const R = states.A.pub.result;
  console.log('結果:', R.ranking.map(r=>`${r.name} ${r.total}pt`).join(' / '));
  console.log('outro:', R.outro.split('\n').pop());
  console.log('真相はここで初めて配信される:', !!R.truth);
  A.close(); B.close(); C.close(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
