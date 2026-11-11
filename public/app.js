/* NYC Gives Back — donor reporting and live fundraising screen.
 * Donation payments ALWAYS occur on the official corporate Oracle site.
 * Live mode uses this project's Cloudflare Worker API; local file mode is a single-device preview.
 */
'use strict';
const AAF_URL='https://egud.fa.us2.oraclecloud.com/fscmUI/redwood/aafFormUI';
const KEY='nyc-gives-back-demo-v4';
const ACTIVITY_KEY='nyc-gives-back-activity-tab-v1';
const DEFAULT_CONFIG={title:'NYC Gives Back',donationUrl:AAF_URL,goal:5000,mode:'regional',teams:Array.from({length:11},(_,i)=>`District ${i+1}`),showMilestones:false,milestones:[500,1000,2500,5000]};
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:Number.isInteger(Number(n))?0:2}).format(Number(n)||0);
const shortDate=s=>{try{return new Date(s).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return String(s||'');}};
let savedAdminToken='';try{savedAdminToken=sessionStorage.getItem('aafAdminToken')||'';}catch{}
const state={mode:'demo',config:{...DEFAULT_CONFIG},summary:null,token:savedAdminToken,chosen:null,lastTotal:null,modalBlobUrl:null,refreshTimer:null};
const page=(new URL(location.href)).searchParams.get('view')||'dashboard';
const validPage=['dashboard','donate','admin'].includes(page)?page:'dashboard';
let demoMemory={config:{...DEFAULT_CONFIG},donations:[],activity:[],previewActive:null};
const demoRead=()=>{try{const raw=JSON.parse(localStorage.getItem(KEY));if(raw&&Array.isArray(raw.donations)){demoMemory=raw;return raw;}}catch{}return demoMemory;};
const demoWrite=x=>{demoMemory=x;try{localStorage.setItem(KEY,JSON.stringify(x));}catch(e){console.warn('Local test data will last only for this browser tab:',e.message);}window.dispatchEvent(new Event('aaf-demo-update'));};
const demoSummary=()=>{const d=demoRead(),approved=d.donations.filter(r=>r.status==='approved'),groups=new Map();for(const r of approved){const g=groups.get(r.team)||{name:r.team,amount:0,count:0};g.amount+=r.amount;g.count++;groups.set(r.team,g);}const teams=[...new Set([...d.config.teams,...groups.keys()])].map(name=>groups.get(name)||{name,amount:0,count:0});return{config:d.config,total:approved.reduce((a,b)=>a+b.amount,0),count:approved.length,pending:d.donations.filter(r=>r.status==='pending').length,activeCount:demoActiveCount(d),teams,recent:[]};};
// Demo sessions follow exactly the same 90-second page / 10-minute donate-click windows.
function demoActiveCount(d){
  if(Number.isInteger(d.previewActive) && d.previewActive>=0)return d.previewActive;
  const now=Date.now();
  return (d.activity||[]).filter(a=>a.stage!=='submitted'&&((['view','upload'].includes(a.stage)&&now-a.lastSeen<=90000)||(a.clickedAt&&now-a.clickedAt<=600000))).length;
}
let visitorSessionId=null;
let lastInteraction=Date.now();
let lastActivitySignal=0;
let donorSubmissionDone=false;
function getVisitorSessionId(){
  if(visitorSessionId)return visitorSessionId;
  try{
    const stored=sessionStorage.getItem(ACTIVITY_KEY);
    if(stored && /^[0-9a-f-]{36}$/i.test(stored)){visitorSessionId=stored;return stored;}
  }catch{}
  visitorSessionId=crypto.randomUUID();
  try{sessionStorage.setItem(ACTIVITY_KEY,visitorSessionId);}catch{}
  return visitorSessionId;
}
function signalActivity(stage, preferBeacon=false){
  if(validPage!=='donate' || donorSubmissionDone)return;
  const sessionId=getVisitorSessionId();
  lastActivitySignal=Date.now();
  if(state.mode==='demo'){
    const d=demoRead(),now=Date.now();d.activity=(d.activity||[]).filter(a=>now-a.lastSeen<86400000);
    let a=d.activity.find(x=>x.sessionId===sessionId);
    if(!a){a={sessionId,lastSeen:now,clickedAt:null,stage};d.activity.push(a);}
    if(a.stage!=='submitted'){a.lastSeen=now;a.stage=stage;if(stage==='donate')a.clickedAt=now;}
    demoWrite(d);
    return;
  }
  const body=JSON.stringify({sessionId,stage});
  if(preferBeacon && navigator.sendBeacon){
    const sent=navigator.sendBeacon('/api/activity',new Blob([body],{type:'application/json'}));
    if(sent)return;
  }
  fetch('/api/activity',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true,cache:'no-store'}).catch(()=>{});
}
function markSubmitted(){
  const sessionId=getVisitorSessionId();
  if(state.mode==='demo'){
    const d=demoRead(),a=(d.activity||[]).find(x=>x.sessionId===sessionId);
    if(a){a.stage='submitted';a.lastSeen=Date.now();demoWrite(d);}
  }else{
    // Submit before the local stop flag, so the server excludes this session.
    signalActivity('submitted',true);
  }
  donorSubmissionDone=true;
}
function initializeDonorActivity(){
  signalActivity('view');
  $('corporateDonateLink').addEventListener('click',()=>{lastInteraction=Date.now();signalActivity('donate',true);});
  $('receiptFile').addEventListener('click',()=>{lastInteraction=Date.now();signalActivity('upload');});
  $('receiptFile').addEventListener('change',()=>{lastInteraction=Date.now();signalActivity('upload');});
  if($('donorTeam'))$('donorTeam').addEventListener('change',()=>{lastInteraction=Date.now();signalActivity('upload');});
  const engage=()=>{
    if(document.visibilityState!=='visible'||donorSubmissionDone)return;
    lastInteraction=Date.now();
    if(Date.now()-lastActivitySignal>45000)signalActivity('view');
  };
  document.addEventListener('pointerdown',engage,{passive:true});
  document.addEventListener('keydown',engage,{passive:true});
  document.addEventListener('scroll',engage,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')engage();});
  window.addEventListener('focus',engage);
  setInterval(()=>{
    if(!donorSubmissionDone && document.visibilityState==='visible' && Date.now()-lastInteraction<90000 && Date.now()-lastActivitySignal>30000)signalActivity('view');
  },30000);
}

async function api(path,options={}){
  const headers={...(options.headers||{})};
  if(state.token&&path.startsWith('/admin/'))headers.Authorization=`Bearer ${state.token}`;
  let response;
  try{response=await fetch(`/api${path}`,{...options,headers,cache:'no-store'});}catch{throw new Error('Unable to connect to the event service.');}
  let data;
  try{data=await response.json();}catch{throw new Error('Unexpected event service response.');}
  if(!response.ok)throw new Error(data.error||`Service error ${response.status}`);
  return data;
}
function showMessage(id,msg,type=''){const el=$(id);if(!el)return;el.textContent=msg;el.className='message '+type;}
function showPage(){if(new URL(location.href).searchParams.get('screen')==='1' && validPage==='dashboard')document.body.classList.add('projector');for(const p of ['dashboard','donate','admin'])$(p+'Page').hidden=p!==validPage;document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===validPage));}
async function init(){
  showPage();
  $('corporateDonateLink').href=AAF_URL;
  const isFile=location.protocol==='file:';
  if(!isFile){
    try{const config=await api('/config');if(config&&config.goal>0){state.mode='cloud';state.config={...DEFAULT_CONFIG,...config};}}
    catch(e){console.warn('Live backend not available; entering local preview:',e.message);}
  }
  if(state.mode==='demo'){$('demoNotice').hidden=false;state.config=demoRead().config;$('loginHelp').textContent='Local preview: choose Unlock without a token. This preview is not shared across phones.';}
  if(validPage==='dashboard'){
    setupEventQr();await refreshSummary();state.refreshTimer=setInterval(()=>refreshSummary(),3000);
    if(state.mode==='demo')window.addEventListener('storage',refreshSummary);
    window.addEventListener('aaf-demo-update',refreshSummary);
  }
  if(validPage==='donate'){renderDonationTeam();bindDonationForm();initializeDonorActivity();}
  if(validPage==='admin'){bindAdmin();if(state.mode==='demo')unlockDemo();else if(state.token)unlockAdmin();}
}
function setupEventQr(){
  const target=new URL(location.href);target.search='?view=donate';target.hash='';
  const url=target.href;
  $('eventAction').href='?view=donate';
  if(state.mode==='cloud'){
    const qr=$('eventQr');
    qr.alt='Scan to open the NYC Gives Back donation and confirmation form';
    qr.onerror=()=>{qr.onerror=null;qr.src='./assets/official-qr.png';$('qrHint').textContent='Corporate donation QR — use the button below to report';};
    // QuickChart is used ONLY for rendering a QR image of this public meeting URL.
    qr.src=`https://quickchart.io/qr?size=480&margin=2&text=${encodeURIComponent(url)}`;
    $('qrHint').textContent='Scan to donate & submit';
  } else { $('qrHint').textContent='Sample corporate QR • event QR appears after deployment'; }
}
async function refreshSummary(){
  try{
    const summary=state.mode==='cloud'?await api('/summary'):demoSummary();
    state.summary=summary;state.config={...DEFAULT_CONFIG,...summary.config};
    if(validPage==='dashboard')renderDashboard(summary);
  }catch(e){console.warn('Dashboard refresh failed:',e.message);const live=document.querySelector('.live-chip');if(live){live.textContent='RECONNECTING';live.style.background='#6b471c';}}
}
function renderDashboard(s){
  $('totalRaised').textContent=money(s.total);
  $('goalValue').textContent=money(s.config.goal);
  $('donationCount').textContent=Number(s.count).toLocaleString();
  $('activeZoners').textContent=Number(s.activeCount||0).toLocaleString();
  const fraction=Math.max(0,Number(s.total)/Number(s.config.goal||1));
  $('progressPercent').textContent=`${Math.round(fraction*100)}%`;
  $('progressFill').style.width=`${Math.min(100,100*fraction)}%`;
  $('progressAria').setAttribute('aria-valuenow',String(Math.min(100,Math.round(fraction*100))));
  $('progressAria').setAttribute('aria-valuetext',`${Math.round(fraction*100)} percent of goal`);
  $('goalSubline').textContent=`${money(s.total)} of ${money(s.config.goal)} raised`;
  $('remainingText').textContent=s.total<s.config.goal?`${money(s.config.goal-s.total)} to go`:'GOAL REACHED!';
  document.querySelector('.live-chip').innerHTML='<span class="pulse"></span> LIVE';
  document.querySelector('.live-chip').style.background='#b5000b';
  renderMilestones(s);renderTeams(s);
  if(state.lastTotal!==null && s.total>state.lastTotal && s.config.showMilestones){
    const justCrossed=(s.config.milestones||[]).filter(x=>x>state.lastTotal&&x<=s.total);
    if(justCrossed.length)celebrate(justCrossed[justCrossed.length-1]);
  }
  state.lastTotal=s.total;
}
function renderMilestones(s){
  $('milestoneCard').hidden=!s.config.showMilestones;
  if(!s.config.showMilestones)return;
  const next=(s.config.milestones||[]).slice().sort((a,b)=>a-b).find(x=>x>s.total);
  $('nextMilestone').textContent=next?money(next):'ALL UNLOCKED';
  $('milestoneRemaining').textContent=next?`${money(next-s.total)} to go`:'Amazing generosity!';
}
function renderTeams(s){
  const panel=$('teamPanel');panel.hidden=s.config.mode!=='team';
  if(panel.hidden)return;
  const list=$('teamRanks');list.replaceChildren();
  const teams=(s.teams||[]).filter(t=>s.config.teams.includes(t.name)).sort((a,b)=>b.amount-a.amount).slice(0,11);
  const max=Math.max(1,...teams.map(t=>t.amount));
  teams.forEach((t,i)=>{const row=document.createElement('div');row.className='team-row';const rank=document.createElement('span');rank.textContent=`${i+1}.`;const name=document.createElement('span');name.className='team-name';name.textContent=t.name;const rail=document.createElement('div');rail.className='team-rail';const fill=document.createElement('div');fill.className='team-fill';fill.style.width=`${100*t.amount/max}%`;rail.append(fill);const amount=document.createElement('span');amount.className='team-money';amount.textContent=money(t.amount);row.append(rank,name,rail,amount);list.append(row);});
}
function celebrate(amount){$('celebrationValue').textContent=money(amount);$('celebration').hidden=false;setTimeout(()=>$('celebration').hidden=true,4100);}
function renderDonationTeam(){const enabled=state.config.mode==='team';$('teamChooser').hidden=!enabled;const sel=$('donorTeam');sel.replaceChildren();for(const name of state.config.teams){const opt=new Option(name,name);sel.append(opt);}}
function bindDonationForm(){$('donationForm').addEventListener('submit',submitDonation);}
function imageDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
async function compressDemoImage(file){
  const source=await imageDataUrl(file);
  const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=source;});
  const max=1000,ratio=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.round(img.naturalWidth*ratio);canvas.height=Math.round(img.naturalHeight*ratio);
  canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.67);
}
async function submitDonation(e){
  e.preventDefault();const file=$('receiptFile').files[0];const btn=$('sendReceipt');
  if(!file){showMessage('donorMessage','Choose a screenshot first.','error');return;}
  if(file.size>5*1024*1024){showMessage('donorMessage','Choose an image under 5 MB.','error');return;}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){showMessage('donorMessage','Use a PNG, JPG or WebP screenshot.','error');return;}
  btn.disabled=true;btn.textContent='Submitting screenshot…';
  try{
    if(state.mode==='cloud'){
      const fd=new FormData();fd.append('proof',file);fd.append('team',state.config.mode==='team'?$('donorTeam').value:'NYC Region');
      await api('/submit',{method:'POST',body:fd});
      showMessage('donorMessage','✓ Confirmation received! Your donation will count after review.','success');
    }else{
      const d=demoRead(),preview=await compressDemoImage(file);
      d.donations.unshift({id:crypto.randomUUID(),team:state.config.mode==='team'?$('donorTeam').value:'NYC Region',status:'pending',amount:0,submitted_at:new Date().toISOString(),preview});demoWrite(d);
      showMessage('donorMessage','✓ Local preview received. Open Admin on this computer to approve it. No real event submission was sent.','success');
    }
    $('receiptFile').value='';
    markSubmitted();
  }catch(err){showMessage('donorMessage',err.message||'Could not upload screenshot.','error');}
  finally{btn.disabled=false;btn.textContent='Submit confirmation →';}
}
function bindAdmin(){
  $('adminUnlock').addEventListener('click',()=>{if(state.mode==='demo')unlockDemo();else{state.token=$('adminToken').value.trim();sessionStorage.setItem('aafAdminToken',state.token);unlockAdmin();}});
  $('adminToken').addEventListener('keydown',e=>{if(e.key==='Enter')$('adminUnlock').click();});
  $('adminLogout').addEventListener('click',()=>{state.token='';sessionStorage.removeItem('aafAdminToken');$('adminWorkbench').hidden=true;$('adminLogin').hidden=false;$('adminToken').value='';});
  $('settingMode').addEventListener('change',()=>{$('teamSettings').hidden=$('settingMode').value!=='team';});
  $('settingMilestones').addEventListener('change',()=>{$('milestoneSettings').hidden=!$('settingMilestones').checked;});
  $('saveSettings').addEventListener('click',saveSettings);
  $('refreshQueue').addEventListener('click',loadQueue);
  $('manualAdd').addEventListener('click',manualAdd);
  $('simulateActiveButton').addEventListener('click',()=>{
    if(state.mode!=='demo')return;
    const n=Number($('simulateActiveCount').value);
    if(!Number.isInteger(n)||n<0||n>150)return;
    const d=demoRead();d.previewActive=n;demoWrite(d);
  });
  $('modalClose').addEventListener('click',closeModal);
  $('reviewModal').addEventListener('click',e=>{if(e.target===$('reviewModal'))closeModal();});
  $('reviewApprove').addEventListener('click',()=>reviewDonation('approved'));
  $('reviewReject').addEventListener('click',()=>reviewDonation('rejected'));
  $('reviewDelete').addEventListener('click',deleteDonation);
}
function unlockDemo(){$('demoActivityControls').hidden=false;state.token='';$('adminLogin').hidden=true;$('adminWorkbench').hidden=false;$('adminModeTag').textContent='LOCAL PREVIEW — not connected to attendees';populateAdminSettings();loadQueue();}
async function unlockAdmin(){
  if(!state.token){showMessage('loginHelp','Enter your private ADMIN_TOKEN.','error');return;}
  try{await api('/admin/queue');$('adminLogin').hidden=true;$('adminWorkbench').hidden=false;$('adminModeTag').textContent='LIVE EVENT SERVICE';populateAdminSettings();loadQueue();}
  catch(e){$('adminWorkbench').hidden=true;$('adminLogin').hidden=false;$('loginHelp').textContent=e.message+' Check the secret configured in Cloudflare.';state.token='';sessionStorage.removeItem('aafAdminToken');}
}
function populateAdminSettings(){const c=state.config;$('settingGoal').value=c.goal;$('settingMode').value=c.mode;$('settingTeams').value=c.teams.join('\n');$('settingMilestones').checked=Boolean(c.showMilestones);$('settingMilestoneValues').value=(c.milestones||[]).join(', ');$('teamSettings').hidden=c.mode!=='team';$('milestoneSettings').hidden=!c.showMilestones;renderManualTeam();}
function renderManualTeam(){const teamMode=state.config.mode==='team';$('manualTeam').hidden=!teamMode;$('manualTeam').replaceChildren();if(teamMode)for(const name of state.config.teams)$('manualTeam').append(new Option(name,name));}
async function saveSettings(){
  const teams=$('settingTeams').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const cfg={title:'NYC Gives Back',goal:Number($('settingGoal').value),mode:$('settingMode').value,teams:teams.length?teams:DEFAULT_CONFIG.teams,showMilestones:$('settingMilestones').checked,milestones:$('settingMilestoneValues').value.split(',').map(s=>Number(s.trim())).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b)};
  if(!Number.isFinite(cfg.goal)||cfg.goal<=0){showMessage('settingsMessage','Enter a goal greater than $0.','error');return;}
  if(cfg.mode==='team'&&(cfg.teams.length>25||new Set(cfg.teams).size!==cfg.teams.length)){showMessage('settingsMessage','Use up to 25 unique team names.','error');return;}
  try{
    if(state.mode==='cloud')await api('/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    else{const d=demoRead();d.config=cfg;demoWrite(d);}
    state.config=cfg;renderManualTeam();showMessage('settingsMessage','✓ Settings saved. The live display will reflect the new goal and mode.','success');
  }catch(e){showMessage('settingsMessage',e.message,'error');}
}
async function loadQueue(){
  try{
    let rows;
    if(state.mode==='cloud')rows=(await api('/admin/queue')).donations;
    else rows=demoRead().donations;
    $('queuePending').textContent=`${rows.filter(r=>r.status==='pending').length} pending`;
    $('queueApproved').textContent=`${rows.filter(r=>r.status==='approved').length} approved`;
    const list=$('queueList');list.replaceChildren();
    if(!rows.length){const p=document.createElement('p');p.className='muted';p.textContent='No submissions yet. Test the workflow from Donate / upload, or add a manual verified entry.';list.append(p);return;}
    for(const r of rows){const item=document.createElement('div');item.className='queue-item';const meta=document.createElement('div');const title=document.createElement('strong');title.textContent=`${r.team} · ${r.status==='approved'?money(r.amount_cents!=null?r.amount_cents/100:r.amount):r.status.toUpperCase()}`;const details=document.createElement('small');details.textContent=`${shortDate(r.submitted_at)} · ${r.id.slice(0,8)}`;meta.append(title,details);const button=document.createElement('button');button.textContent=r.status==='pending'?'Review':'View / edit';button.addEventListener('click',()=>openReview(r));item.append(meta,button);list.append(item);}
  }catch(e){showMessage('manualMessage','Queue unavailable: '+e.message,'error');}
}
async function openReview(r){
  state.chosen=r;
  $('reviewHeading').textContent=r.status==='pending'?'Review screenshot':`Review ${r.status} entry`;
  $('reviewMeta').textContent=`${r.team} · submitted ${shortDate(r.submitted_at)}`;
  $('reviewAmount').value=r.amount_cents!=null?(r.amount_cents/100):r.amount||'';
  $('reviewNote').value=r.reviewer_note||'';
  $('reviewImage').hidden=true;$('manualReceiptNote').hidden=true;
  showMessage('reviewMessage','');$('reviewModal').hidden=false;
  if(state.modalBlobUrl){URL.revokeObjectURL(state.modalBlobUrl);state.modalBlobUrl=null;}
  try{
    if(state.mode==='demo'){
      if(r.preview){$('reviewImage').src=r.preview;$('reviewImage').hidden=false;}else $('manualReceiptNote').hidden=false;
    }else if(r.mime_type==='manual' || r.id?.startsWith('manual'))$('manualReceiptNote').hidden=false;
    else{
      const response=await fetch(`/api/admin/receipt/${encodeURIComponent(r.id)}`,{headers:{Authorization:`Bearer ${state.token}`},cache:'no-store'});
      if(!response.ok)throw new Error('Screenshot unavailable.');
      state.modalBlobUrl=URL.createObjectURL(await response.blob());$('reviewImage').src=state.modalBlobUrl;$('reviewImage').hidden=false;
    }
  }catch(e){showMessage('reviewMessage',e.message,'error');}
}
function closeModal(){$('reviewModal').hidden=true;state.chosen=null;if(state.modalBlobUrl){URL.revokeObjectURL(state.modalBlobUrl);state.modalBlobUrl=null;}}
async function reviewDonation(status){
  const r=state.chosen;if(!r)return;
  const amount=Number($('reviewAmount').value),note=$('reviewNote').value.trim();
  if(status==='approved'&&(!Number.isFinite(amount)||amount<=0||amount>10000)){showMessage('reviewMessage','Enter the dollar amount displayed on the proof.','error');return;}
  $('reviewApprove').disabled=true;$('reviewReject').disabled=true;
  try{
    if(state.mode==='cloud')await api('/admin/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:r.id,status,amount,note})});
    else{const d=demoRead();const item=d.donations.find(x=>x.id===r.id);if(item){item.status=status;item.amount=status==='approved'?amount:0;item.reviewed_at=new Date().toISOString();item.reviewer_note=note;demoWrite(d);}}
    closeModal();await loadQueue();
  }catch(e){showMessage('reviewMessage',e.message,'error');}
  finally{$('reviewApprove').disabled=false;$('reviewReject').disabled=false;}
}
async function deleteDonation(){
  const r=state.chosen;if(!r)return;
  if(!confirm('Permanently delete this donation entry and its private screenshot? This cannot be undone.'))return;
  try{
    if(state.mode==='cloud')await api(`/admin/donation/${encodeURIComponent(r.id)}`,{method:'DELETE'});
    else{const d=demoRead();d.donations=d.donations.filter(x=>x.id!==r.id);demoWrite(d);}
    closeModal();loadQueue();
  }catch(e){showMessage('reviewMessage',e.message,'error');}
}
async function manualAdd(){
  const amount=Number($('manualAmount').value),team=state.config.mode==='team'?$('manualTeam').value:'NYC Region';
  if(!Number.isFinite(amount)||amount<=0||amount>10000){showMessage('manualMessage','Enter a valid confirmed amount.','error');return;}
  const confirmMessage=`Add ${money(amount)} as a manually verified contribution? Only do this after checking actual proof of payment.`;
  if(!confirm(confirmMessage))return;
  try{
    if(state.mode==='cloud')await api('/admin/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount,team})});
    else{const d=demoRead();d.donations.unshift({id:crypto.randomUUID(),team,amount,status:'approved',submitted_at:new Date().toISOString(),reviewed_at:new Date().toISOString()});demoWrite(d);}
    $('manualAmount').value='';showMessage('manualMessage',`✓ ${money(amount)} added to verified totals.`,'success');loadQueue();
  }catch(e){showMessage('manualMessage',e.message,'error');}
}
init();
