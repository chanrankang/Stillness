(function(){
'use strict';

/* ================= content ================= */
/* The questions are fixed. They are the same on every day for everyone. */
var QUESTIONS=[
  'What does this passage say about God?',
  'What stood out to me, or what questions do I have?',
  'How will I respond or apply this today?',
  'Your space for any other thoughts:'
];
/* Earlier wordings, so answers saved under them still show under the current question. */
var ALIASES={'Your space for any other thoughts:':['A space for any other thoughts:']};
/* Scripture Union daily passages, added by hand: 'YYYY-MM-DD': 'Book 1:1-5'. */
var SU_MAP={'2026-10-06':'Judges 18:21-31'};

/* ================= small helpers ================= */
function $(id){return document.getElementById(id)}
function pad(n){return String(n).padStart(2,'0')}
function keyOf(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function parse(k){var p=k.split('-');return new Date(+p[0],+p[1]-1,+p[2])}
function num(k){var p=k.split('-');return Math.round(Date.UTC(+p[0],+p[1]-1,+p[2])/864e5)}
function add(k,n){var d=parse(k);d.setDate(d.getDate()+n);return keyOf(d)}
function todayKey(){return keyOf(new Date())}
var fmtMonth=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'});
var fmtLong=new Intl.DateTimeFormat(undefined,{weekday:'long',day:'numeric',month:'long'});
var fmtShort=new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short'});
function sameQ(q,stored){return stored===q||(ALIASES[q]||[]).indexOf(stored)>-1}
function isCurrent(stored){return QUESTIONS.some(function(q){return sameQ(q,stored)})}
function isTyping(){var a=document.activeElement;return !!a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')}
function csbUrl(ref){return 'https://www.biblegateway.com/passage/?search='+encodeURIComponent(ref)+'&version=CSB'}

/* ================= views ================= */
function showView(name){
  ['boot','setup','auth','recover','app'].forEach(function(v){$(v).hidden=(v!==name)});
  $('acct').hidden=(name!=='app');
}
function say(id,text,bad){var el=$(id);el.textContent=text||'';el.classList.toggle('bad',!!bad)}

/* ================= config and client ================= */
var CFG=window.STILLNESS_CONFIG||{};
var uid=null,email='';
var sb=null;

function configProblem(){
  if(!CFG.SUPABASE_URL||!CFG.SUPABASE_ANON_KEY||/PASTE_/.test(CFG.SUPABASE_URL+CFG.SUPABASE_ANON_KEY)){
    return 'This app is not connected to its database yet.\nOpen config.js and paste in your Supabase project URL and anon key. The README explains where to find them.';
  }
  if(!window.supabase||!window.supabase.createClient){
    return 'The sign-in library did not load.\nCheck your internet connection and reload the page.';
  }
  return '';
}

/* ================= state ================= */
/* days[key] = { d: true|false (QT done), p: passage, qa: [{q, a}] } */
var state={days:{}};
var sel=todayKey(),curDay=sel;
var vt=parse(sel);
var view={y:vt.getFullYear(),m:vt.getMonth()};

/* Answers belong to a question by its wording. Answers to a question that was
   removed stay stored after the current questions, so nothing is lost. */
function mapQA(arr){
  arr=Array.isArray(arr)?arr:[];
  var out=QUESTIONS.map(function(q){
    var m=null;
    arr.forEach(function(x){if(x&&sameQ(q,x.q)&&!m) m=x});
    return {q:q,a:m&&typeof m.a==='string'?m.a.slice(0,4000):''};
  });
  arr.forEach(function(x){
    if(x&&typeof x.a==='string'&&x.a.trim()&&typeof x.q==='string'&&!isCurrent(x.q)&&out.length<12)
      out.push({q:x.q.slice(0,160),a:x.a.slice(0,4000)});
  });
  return out;
}
function defaultQA(){return QUESTIONS.map(function(q){return {q:q,a:''}})}
function rowToEntry(r){
  var o={};
  if(typeof r.done==='boolean') o.d=r.done;
  if(typeof r.passage==='string'&&r.passage) o.p=r.passage.slice(0,80);
  o.qa=mapQA(r.answers);
  return o;
}
function signature(days){
  return Object.keys(days).sort().map(function(k){return k+JSON.stringify(days[k])}).join('|');
}

/* ================= saving ================= */
var dirty=new Set(),ver={},flushing=false,saveTimer=0,retryTimer=0;
function setStatus(k){
  var t={loading:'Loading your entries…',saving:'Saving…',saved:'Saved to your account.',
    err:'Could not save just now. Trying again shortly.',loaderr:'Could not load your entries. Trying again shortly.'};
  $('sync').textContent=t[k]||'';
}
function queue(k){
  dirty.add(k);ver[k]=(ver[k]||0)+1;
  setStatus('saving');
  clearTimeout(saveTimer);saveTimer=setTimeout(flush,600);
}
async function flush(){
  if(flushing||!uid||!sb) return;
  flushing=true;
  try{
    while(dirty.size){
      var k=dirty.values().next().value,v=ver[k],e=state.days[k],res;
      if(e){
        res=await sb.from('entries').upsert({
          user_id:uid,day:k,
          done:e.d===undefined?null:e.d,
          passage:e.p||null,
          answers:mapQA(e.qa),
          updated_at:new Date().toISOString()
        },{onConflict:'user_id,day'});
      }else{
        res=await sb.from('entries').delete().eq('user_id',uid).eq('day',k);
      }
      if(res&&res.error) throw res.error;
      if(ver[k]===v) dirty.delete(k);
    }
    setStatus('saved');
  }catch(err){
    setStatus('err');
    clearTimeout(retryTimer);retryTimer=setTimeout(flush,5000);
  }finally{
    flushing=false;
  }
}

async function loadAll(){
  var days={},from=0,size=1000;
  for(;;){
    var res=await sb.from('entries').select('day,done,passage,answers').order('day',{ascending:true}).range(from,from+size-1);
    if(res.error) throw res.error;
    var rows=res.data||[];
    rows.forEach(function(r){days[String(r.day).slice(0,10)]=rowToEntry(r)});
    if(rows.length<size) break;
    from+=size;
  }
  return days;
}
/* Writes the SU passage into days that have no entry yet. Never marks a day done. */
function fillSu(){
  var t=todayKey(),n=0;
  Object.keys(SU_MAP).forEach(function(k){
    if(num(k)>num(t)||state.days[k]) return;
    state.days[k]={p:SU_MAP[k],qa:defaultQA()};queue(k);n++;
  });
  return n>0;
}
var loadToken=0;
async function startLoad(first){
  var my=++loadToken;
  if(first) setStatus('loading');
  try{
    var days=await loadAll();
    if(my!==loadToken||!uid) return;
    if(dirty.size||flushing) return;
    var changed=signature(days)!==signature(state.days);
    if(changed||first){state.days=days}
    var filled=fillSu();
    if(first||changed||filled) refresh(first);
    if(!dirty.size) setStatus('saved');
  }catch(err){
    if(my!==loadToken||!uid) return;
    if(first){
      setStatus('loaderr');
      clearTimeout(retryTimer);retryTimer=setTimeout(function(){if(uid)startLoad(true)},5000);
    }
  }
}

/* ================= helpers on state ================= */
function isDone(k){var e=state.days[k];return !!(e&&e.d===true)}
function hasNotes(k){
  var e=state.days[k];
  if(!e) return false;
  return !!(e.p||(e.qa&&e.qa.some(function(x){return x.a})));
}
function streak(){
  var k=todayKey();
  if(!isDone(k)) k=add(k,-1);
  var n=0;
  while(isDone(k)){n++;k=add(k,-1)}
  return n;
}
function monthCount(){
  var n=0,dim=new Date(view.y,view.m+1,0).getDate();
  for(var i=1;i<=dim;i++){if(isDone(view.y+'-'+pad(view.m+1)+'-'+pad(i)))n++}
  return n;
}
function ensure(){
  var e=state.days[sel];
  if(!e) e=state.days[sel]={};
  e.qa=mapQA(e.qa);
  return e;
}
function autoDone(e){if(e.d===undefined){e.d=true;return true}return false}
function tidy(){
  var e=state.days[sel];
  if(!e) return;
  var empty=!e.p&&e.d===undefined&&(!e.qa||!e.qa.some(function(x){return x.a}));
  if(empty) delete state.days[sel];
}

/* ================= render ================= */
function renderCal(){
  var t=todayKey();
  $('monthTitle').textContent=fmtMonth.format(new Date(view.y,view.m,1));
  var first=new Date(view.y,view.m,1),lead=(first.getDay()+6)%7,dim=new Date(view.y,view.m+1,0).getDate(),html='',i;
  for(i=0;i<lead;i++) html+='<span class="c blank" aria-hidden="true"></span>';
  for(i=1;i<=dim;i++){
    var k=view.y+'-'+pad(view.m+1)+'-'+pad(i),fut=num(k)>num(t),dn=isDone(k);
    var cls='c'+(dn?' done':'')+(!dn&&hasNotes(k)?' has':'')+(k===t?' today':'')+(k===sel?' sel':'');
    var label=fmtShort.format(parse(k))+(dn?', QT done':(hasNotes(k)?', has notes':''));
    html+='<button type="button" class="'+cls+'" data-k="'+k+'"'+(fut?' disabled':'')+
      ' aria-label="'+label+'" aria-pressed="'+(k===sel)+'">'+i+'</button>';
  }
  $('cal').innerHTML=html;
  var n=monthCount(),s=streak();
  $('summary').innerHTML='<b>'+n+'</b> '+(n===1?'day':'days')+' this month'+(s>0?' &middot; <b>'+s+'</b> '+(s===1?'day':'days')+' in a row':'');
  var t0=parse(t);
  $('next').disabled=(view.y>t0.getFullYear()||(view.y===t0.getFullYear()&&view.m>=t0.getMonth()));
}
function setPassageLink(){
  var p=($('passage').value||'').trim(),a=$('csbLink');
  a.hidden=!p;
  if(p) a.href=csbUrl(p);
}
function renderSu(){
  var ref=SU_MAP[sel],cur=($('passage').value||'').trim(),b=$('suUse');
  b.hidden=!(ref&&!cur);
  if(ref) b.textContent='Use the SU passage: '+ref;
  var isToday=(sel===todayKey());
  $('suLink').textContent=isToday?'Open today’s SU reading':'Open the SU reading site';
  $('suNote').hidden=isToday;
}
function renderQs(qa){
  var host=$('qs');host.innerHTML='';
  QUESTIONS.forEach(function(text,i){
    var x=qa[i]||{a:''};
    var q=document.createElement('div');q.className='q';q.dataset.i=i;
    var top=document.createElement('div');top.className='q-top';
    var n=document.createElement('span');n.className='q-n';n.textContent=i+1;
    var qt=document.createElement('p');qt.className='q-text';qt.id='qt'+i;qt.textContent=text;
    top.appendChild(n);top.appendChild(qt);
    var ta=document.createElement('textarea');ta.className='q-a';ta.id='a'+i;ta.maxLength=4000;
    ta.setAttribute('aria-labelledby','qt'+i);
    ta.placeholder='Your thoughts…';ta.value=x.a;
    q.appendChild(top);q.appendChild(ta);host.appendChild(q);
  });
}
function renderDay(){
  var t=todayKey(),e=state.days[sel]||{};
  $('dayTitle').textContent=sel===t?'Today, '+fmtShort.format(parse(sel)):fmtLong.format(parse(sel));
  var dn=e.d===true,b=$('doneBtn');
  b.setAttribute('aria-pressed',dn?'true':'false');
  b.textContent=dn?'QT done':'Mark QT done';
  $('passage').value=e.p||'';
  setPassageLink();
  renderSu();
  renderQs(mapQA(e.qa));
}
function refresh(force){
  renderCal();
  if(force||!isTyping()) renderDay();
}

/* ================= calendar and day navigation ================= */
var isOpen=false;
function show(o){
  isOpen=o;$('home').hidden=o;$('day').hidden=!o;
  window.scrollTo(0,0);
}
function selectDay(k,openIt){
  sel=k;$('msg').textContent='';
  var d=parse(k);view={y:d.getFullYear(),m:d.getMonth()};
  refresh(true);
  if(openIt) show(true);
}
function markDoneButton(){var b=$('doneBtn');b.setAttribute('aria-pressed','true');b.textContent='QT done'}

function wireApp(){
  $('prev').addEventListener('click',function(){view.m--;if(view.m<0){view.m=11;view.y--}renderCal()});
  $('next').addEventListener('click',function(){view.m++;if(view.m>11){view.m=0;view.y++}renderCal()});
  $('goToday').addEventListener('click',function(){selectDay(todayKey(),false)});
  $('startToday').addEventListener('click',function(){selectDay(todayKey(),true)});
  $('back').addEventListener('click',function(){show(false);renderCal()});
  document.addEventListener('keydown',function(ev){
    if(ev.key==='Escape'&&isOpen&&!isTyping()){show(false);renderCal()}
  });
  $('cal').addEventListener('click',function(ev){
    var b=ev.target.closest('.c');
    if(b&&!b.disabled&&b.dataset.k) selectDay(b.dataset.k,true);
  });
  $('suUse').addEventListener('click',function(){
    var ref=SU_MAP[sel];if(!ref) return;
    var el=$('passage');el.value=ref;
    el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  $('doneBtn').addEventListener('click',function(){
    var e=ensure();
    e.d=!(e.d===true);
    queue(sel);
    $('msg').textContent=e.d?(sel===todayKey()?'Marked done for today.':'Marked done for '+fmtShort.format(parse(sel))+'.'):'Unmarked.';
    renderCal();renderDay();
  });
  $('passage').addEventListener('input',function(){
    var e=ensure();e.p=this.value.slice(0,80);if(!e.p)delete e.p;
    var ch=this.value.trim()?autoDone(e):false;
    tidy();queue(sel);setPassageLink();renderSu();
    if(ch) markDoneButton();
    renderCal();
  });
  $('qs').addEventListener('input',function(ev){
    var q=ev.target.closest('.q');if(!q||!ev.target.classList.contains('q-a')) return;
    var i=+q.dataset.i,e=ensure();
    e.qa[i].a=ev.target.value.slice(0,4000);
    if(ev.target.value.trim()&&autoDone(e)) markDoneButton();
    tidy();queue(sel);renderCal();
  });
}

/* ================= accounts ================= */
var mode='login',busy=false,recoveryMode=/type=recovery/.test(location.hash||'');

function setMode(m){
  mode=m;
  var signup=(m==='signup');
  $('authTitle').textContent=signup?'Create an account':'Log in';
  $('authSubmit').textContent=signup?'Create account':'Log in';
  $('authToggle').textContent=signup?'I already have an account':'Create an account';
  $('forgot').hidden=signup;
  $('pwHint').hidden=!signup;
  $('password').setAttribute('autocomplete',signup?'new-password':'current-password');
  say('authMsg','');
}
function friendly(err){
  var m=(err&&err.message)||'Something went wrong.';
  if(/invalid login/i.test(m)) return 'That email and password do not match.';
  if(/not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link.';
  if(/rate limit|too many|security purposes/i.test(m)) return 'Too many tries. Please wait a minute and try again.';
  if(/already registered|already been registered/i.test(m)) return 'There is already an account with that email. Try logging in.';
  if(/password/i.test(m)&&/(short|least|weak|characters)/i.test(m)) return 'Choose a longer password (at least 8 characters).';
  if(/network|fetch/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
  return m;
}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)}
function lock(on){busy=on;$('authSubmit').disabled=on;$('forgot').disabled=on;$('authToggle').disabled=on;$('recSubmit').disabled=on}

function wireAuth(){
  $('authToggle').addEventListener('click',function(){setMode(mode==='login'?'signup':'login')});
  $('authForm').addEventListener('submit',async function(ev){
    ev.preventDefault();
    if(busy) return;
    var em=$('email').value.trim(),pw=$('password').value;
    if(!validEmail(em)){say('authMsg','Enter a valid email address.',true);return}
    if(!pw){say('authMsg','Enter your password.',true);return}
    if(mode==='signup'&&pw.length<8){say('authMsg','Choose a password of at least 8 characters.',true);return}
    lock(true);say('authMsg',mode==='signup'?'Creating your account…':'Logging in…');
    try{
      var res;
      if(mode==='signup'){
        res=await sb.auth.signUp({email:em,password:pw,options:{emailRedirectTo:location.origin+location.pathname}});
        if(res.error) throw res.error;
        if(!res.data||!res.data.session){
          say('authMsg','Almost there. We sent a link to '+em+'. Open it to confirm your account, then log in.');
          setMode('login');
          say('authMsg','Almost there. We sent a link to '+em+'. Open it to confirm your account, then log in.');
        }
      }else{
        res=await sb.auth.signInWithPassword({email:em,password:pw});
        if(res.error) throw res.error;
      }
    }catch(err){say('authMsg',friendly(err),true)}
    lock(false);
  });
  $('forgot').addEventListener('click',async function(){
    if(busy) return;
    var em=$('email').value.trim();
    if(!validEmail(em)){say('authMsg','Enter your email above first, then press Forgot password.',true);return}
    lock(true);say('authMsg','Sending…');
    try{
      var res=await sb.auth.resetPasswordForEmail(em,{redirectTo:location.origin+location.pathname});
      if(res.error) throw res.error;
      say('authMsg','If there is an account for '+em+', a reset link is on its way.');
    }catch(err){say('authMsg',friendly(err),true)}
    lock(false);
  });
  $('recForm').addEventListener('submit',async function(ev){
    ev.preventDefault();
    if(busy) return;
    var pw=$('newPassword').value;
    if(pw.length<8){say('recMsg','Choose a password of at least 8 characters.',true);return}
    lock(true);say('recMsg','Saving…');
    try{
      var res=await sb.auth.updateUser({password:pw});
      if(res.error) throw res.error;
      recoveryMode=false;
      try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}
      $('newPassword').value='';say('recMsg','');
      var s=await sb.auth.getSession();
      handleSession(s&&s.data?s.data.session:null,'RECOVERED');
    }catch(err){say('recMsg',friendly(err),true)}
    lock(false);
  });
  $('logout').addEventListener('click',async function(){
    var b=this;b.disabled=true;
    try{
      if(dirty.size) await flush();
      if(dirty.size){say('msg','Some changes have not saved yet. Try again when you are online.',true);setStatus('err');b.disabled=false;return}
      await sb.auth.signOut();
    }catch(err){}
    b.disabled=false;
  });
}

function startApp(user){
  uid=user.id;email=user.email||'';
  $('acctEmail').textContent=email?'Signed in as '+email:'Signed in';
  state={days:{}};dirty.clear();ver={};
  sel=todayKey();curDay=sel;
  var d=parse(sel);view={y:d.getFullYear(),m:d.getMonth()};
  $('msg').textContent='';
  show(false);
  showView('app');
  renderCal();
  startLoad(true);
}
function stopApp(){
  uid=null;email='';loadToken++;
  state={days:{}};dirty.clear();ver={};
  clearTimeout(saveTimer);clearTimeout(retryTimer);
  $('password').value='';
  setStatus('');
}
function handleSession(session,event){
  if(event==='PASSWORD_RECOVERY') recoveryMode=true;
  if(recoveryMode){
    showView('recover');
    return;
  }
  if(session&&session.user){
    if(uid!==session.user.id||$('app').hidden) startApp(session.user);
  }else{
    if(uid) stopApp();
    setMode('login');
    showView('auth');
  }
}

/* ================= tick and refocus ================= */
function tick(){
  if(!uid) return;
  var nk=todayKey();
  if(nk!==curDay){
    if(sel===curDay){sel=nk;var d=parse(nk);view={y:d.getFullYear(),m:d.getMonth()}}
    curDay=nk;refresh(false);
  }
}
function wireGlobal(){
  setInterval(tick,30000);
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){if(dirty.size) flush();return}
    tick();
    if(uid&&!dirty.size&&!flushing&&!isTyping()) startLoad(false);
  });
  window.addEventListener('pagehide',function(){if(dirty.size) flush()});
  window.addEventListener('beforeunload',function(ev){
    if(dirty.size){ev.preventDefault();ev.returnValue=''}
  });
}

/* ================= start ================= */
function boot(){
  var problem=configProblem();
  if(problem){$('setupText').textContent=problem;showView('setup');return}
  sb=window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_ANON_KEY);
  wireApp();wireAuth();wireGlobal();setMode('login');
  sb.auth.onAuthStateChange(function(event,session){
    /* do not call other Supabase methods directly inside this callback */
    setTimeout(function(){handleSession(session,event)},0);
  });
  sb.auth.getSession().then(function(r){
    handleSession(r&&r.data?r.data.session:null,'INITIAL_SESSION');
  },function(){handleSession(null,'INITIAL_SESSION')});
}
boot();
})();
