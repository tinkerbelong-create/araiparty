const io=require('socket.io-client');const URL='http://localhost:3111';
const mk=()=>io(URL,{transports:['websocket']});const P=(s,e,a)=>new Promise(r=>s.emit(e,a,r));
const wait=ms=>new Promise(r=>setTimeout(r,ms));const S={};const CL={};const K=['A','B','C','D'];
(async()=>{
  K.forEach(k=>{CL[k]=mk();CL[k].on('mm:state',st=>S[k]=st);});
  await wait(500);
  const sc=await P(CL.A,'mm:scenarios',{});
  console.log('シナリオ一覧:',sc.list.map(x=>`${x.icon}${x.title}(${x.players.min}人/${x.duration})`).join(' / '));
  const {code}=await P(CL.A,'mm:create',{name:'あらい',scenarioId:'umi'});
  for(const k of ['B','C','D']) await P(CL[k],'mm:join',{code,name:k});
  console.log('4人未満で開始:',(await P(CL.A,'mm:start',{})).msg||'開始した');
  await wait(250);
  console.log('▼ランダム配布:',K.map(k=>`${k}=${S[k].priv.character.name}`).join(' / '));
  const who=n=>K.find(k=>S[k].priv.character.name.startsWith(n));
  const ready=async()=>{for(const k of K){await P(CL[k],'mm:ready',{});await wait(50);}await wait(200);};
  const at=()=>`${S.A.pub.phase.title}[${S.A.pub.step}]`;
  console.log('▼',at(),'←はじめに');
  await ready(); await ready(); // intro
  console.log('▼',at());
  await ready(); await ready(); // read
  await ready(); await ready(); // talk1
  console.log('▼',at());
  const T=who('遠見'),KB=who('鏑木'),SZ=who('静'),ME=who('芽衣');
  console.log('  遠見が静に命令:',(await P(CL[T],'mm:act',{abilityId:'o_order',target:{charId:'shizu',orderId:'q_push:toomi'}})).ok);
  console.log('  鏑木は証言カードを出す:',(await P(CL[KB],'mm:act',{abilityId:'k_card',target:{cardId:'k1'}})).ok);
  console.log('  静は問いかけ:',(await P(CL[SZ],'mm:act',{abilityId:'s_ask',target:{charId:'kaburagi',questionId:'a2'}})).ok);
  console.log('  芽衣は思い出す:',(await P(CL[ME],'mm:act',{abilityId:'m_watch'})).ok);
  await wait(200); await ready();
  console.log('▼',at());
  console.log('  【静に届いたもの】'); (S[SZ].priv.lastResults||[]).forEach(r=>console.log('   ・',r.title,'|',r.text.replace(/\n/g,' ').slice(0,60)));
  console.log('  【芽衣に届いたもの】'); (S[ME].priv.lastResults||[]).forEach(r=>console.log('   ・',r.title,'|',r.text.replace(/\n/g,' ').slice(0,60)));
  console.log('  公開ログ:'); S.A.pub.publicLog.forEach(x=>console.log('   -',x.text.replace(/\n/g,' ').slice(0,70)));
  console.log('  ★静の画面の命令:',JSON.stringify(S[SZ].priv.myOrders));
  console.log('  ★芽衣の画面の命令:',JSON.stringify(S[ME].priv.myOrders));
  await ready(); await ready(); await ready(); // talk2 -> act2 brief -> main
  console.log('▼',at());
  console.log('  鏑木が船長権限を宣言:',(await P(CL[KB],'mm:act',{abilityId:'k_auth'})).ok);
  for(const k of [T,SZ,ME]) await P(CL[k],'mm:act',{abilityId:null,target:{}});
  await wait(200); await ready();
  console.log('▼',at());
  console.log('  宣言の公開ログ:'); S.A.pub.publicLog.slice(-3).forEach(x=>console.log('   -',x.text.replace(/\n/g,' ').slice(0,90)));
  console.log('  ★静の命令は無効か:',S[SZ].priv.myOrders.map(o=>o.void));
  let gd=0;
  while(S.A.lobby.stage!=='ended'&&gd++<20){
    if(S.A.pub.phase.type==='ability'&&S.A.pub.step==='main') for(const k of K) await P(CL[k],'mm:act',{abilityId:null,target:{}});
    if(S.A.pub.phase.type==='final'&&S.A.pub.step==='main'){
      const truth={q_where:'toomi',q_push:'shizu',q_kill:'kaburagi',q_witness:'legatee',q_heir:'shizu',q_mei:'daughter',q_valid:'invalid',q_why:'protect',q_illness:'dying'};
      for(const k of K) await P(CL[k],'mm:answers',{questions:truth,abilities:{},note:'真相にたどり着いた'});
    }
    await wait(120); await ready();
  }
  console.log('▼ 終了:',S.A.lobby.stage);
  console.log('  結果:',S.A.pub.result.ranking.map(r=>`${r.name} ${r.total}pt`).join(' / '));
  console.log('  最後の一文:',S.A.pub.result.outro.split('\n').filter(Boolean).pop());
  console.log('  ★真相はここで初めて配信:',!!S.A.pub.result.truth);
  K.forEach(k=>CL[k].close());process.exit(0);
})().catch(e=>{console.error('ERR',e);process.exit(1)});
