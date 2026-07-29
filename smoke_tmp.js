const io=require('socket.io-client');const URL='http://localhost:3111';
const mk=()=>io(URL,{transports:['websocket']});const P=(s,e,a)=>new Promise(r=>s.emit(e,a,r));
const wait=ms=>new Promise(r=>setTimeout(r,ms));const S={};const CL={};
(async()=>{
  const A=mk(),B=mk(),C=mk();CL.A=A;CL.B=B;CL.C=C;
  Object.entries(CL).forEach(([k,s])=>s.on('mm:state',st=>S[k]=st));
  await wait(400);
  const {code}=await P(A,'mm:create',{name:'あらい',scenarioId:'cake'});
  console.log('2人で開始しようとする:',await P(A,'mm:start',{}));
  await P(B,'mm:join',{code,name:'びー'});await P(C,'mm:join',{code,name:'しー'});
  await P(A,'mm:start',{});await wait(250);
  console.log('ランダム配布:',Object.entries(S).map(([k,st])=>`${k}=${st.priv.character.name}`).join(' / '));
  const ready=async()=>{for(const k of ['A','B','C']){await P(CL[k],'mm:ready',{});await wait(70);}await wait(180);};
  const at=()=>`${S.A.pub.phase.title}[${S.A.pub.step}]`;
  const key=k=>S[k].priv.charId;
  await ready(); // read brief -> main
  await ready(); // read main -> talk1 brief
  await ready(); // talk1 brief -> main
  await ready(); // talk1 main -> act1 brief
  await ready(); // act1 brief -> act1 main
  console.log('いまここ:',at());
  console.log('★能力を決めずに完了を押す:',await P(A,'mm:ready',{}));
  for(const k of ['A','B','C']){
    const ch=key(k);
    const mv = ch==='natsuki' ? {abilityId:'n1',target:{placeId:'r_ryusei'}}
             : ch==='ryusei'  ? {abilityId:'r3',target:{placeId:'r_ryusei'}}
             : {abilityId:'k2',target:{charId:'ryusei'}};
    console.log(`  ${S[k].priv.character.name} が能力を決定:`,(await P(CL[k],'mm:act',mv)).ok);
  }
  await wait(200); await ready();
  console.log('いまここ:',at());
  Object.entries(S).forEach(([k,st])=>{
    console.log(` 【${st.priv.character.name}】`);
    (st.priv.lastResults||[]).forEach(r=>console.log('   ・',r.title,'|',r.text.replace(/\n/g,' ').slice(0,72)));
  });
  console.log(' 公開ログ:',S.A.pub.publicLog.map(x=>x.text).join(' / '));
  console.log(' ★「電源」の漏れ:',/電源|コード/.test(JSON.stringify(S.A.pub))?'あり!!!':'なし');
  console.log(' ★他人のHOの漏れ:',/おれの能力を最大限使う/.test(JSON.stringify(S.A))&&S.A.priv.charId!=='ryusei'?'あり!!!':'なし');
  let gd=0;
  while(S.A.lobby.stage!=='ended'&&gd++<30){
    if(S.A.pub.phase.type==='ability'&&S.A.pub.step==='main')
      for(const k of ['A','B','C']) await P(CL[k],'mm:act',{abilityId:null,target:{}});
    if(S.A.pub.phase.type==='final'&&S.A.pub.step==='main'){
      const q={q_eater:'ryusei',q_fake:'kaito',q_taste:'a',q_jewel:'a',q_fail:'a',q_sound1:'a',q_sound2:'a'};
      for(const k of ['A','B','C']) await P(CL[k],'mm:answers',{questions:q,abilities:{},note:'テスト'});
    }
    await wait(120); await ready();
  }
  console.log('終了:',S.A.lobby.stage,'/',S.A.pub.result.ranking.map(r=>`${r.name} ${r.total}pt`).join(' / '));
  A.close();B.close();C.close();process.exit(0);
})().catch(e=>{console.error('ERR',e);process.exit(1)});
