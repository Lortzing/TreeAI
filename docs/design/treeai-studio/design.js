const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let activeBranch = 'feedback';
let origin = 'conversation';
let returnTrigger = null;
let toastTimer;
const examples = {
  feedback: { title:'反馈回路与习惯', question:'怎样识别我日常习惯里的反馈回路？', intro:'先观察一个会重复出现的行为，再追踪它如何影响下一次行为。', detail:'这个回路不断放大疲惫。改变它的切入点，可能不是「少喝一杯」，而是给下午设置一个固定的休息时间。', insight:'把关注点从意志力，移到行为发生的结构上。', harvest:'与其依赖意志力打破坏习惯，不如先找出维持它的反馈回路，再改变一个关键的结构：例如，用固定的午后休息替代咖啡。' },
  leverage: { title:'寻找杠杆点', question:'怎么找到能改变系统走向的小切入点？', intro:'先问：哪个因素在不断维持这个系统？杠杆点往往藏在规则、信息流和目标里。', detail:'例如，把「每天必须读完多少页」改成「读后记录一个问题」，可能比增加阅读时间更能改变学习的质量。', insight:'小改变的价值，取决于它落在系统的什么位置。', harvest:'寻找杠杆点时，优先检查规则、信息流与目标。改变学习的反馈方式，有时比增加投入更有效。' }
};
function toast(message){ $('toast').textContent=message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3000); }
function setView(view){ const material=view==='material'; $('material').hidden=!material; $('conversation').hidden=material; for(const name of ['conversation','material']){ const selected=name===view; $(name+'-tab').classList.toggle('active',selected); $(name+'-tab').setAttribute('aria-selected',String(selected)); } }
function openBranch(kind='feedback', source='conversation', trigger=null){
  const changing=activeBranch!==kind||origin!==source;
  activeBranch=kind; origin=source; returnTrigger=trigger||document.activeElement;
  const data=examples[kind];
  $('branch-title').textContent=data.title; $('branch-question').textContent=data.question;
  $('branch-answer-intro').textContent=data.intro; $('branch-answer-detail').textContent=data.detail;
  document.querySelector('.branch-insight').textContent=data.insight;
  $('causal-chain').hidden=kind!=='feedback';
  $('origin-quote').textContent=source==='material'?'“反馈回路是一个闭合的因果链：系统过去的行为，会影响它未来的行为。”':'“真正推动结果的，是藏在事件背后的反馈回路。”';
  if(kind==='leverage') $('origin-quote').textContent='“寻找一个能改变系统走向的小切入点。”';
  $('origin-label').textContent=source==='material'?'系统之美 · 阅读摘记.md · v1 · 第 02 段':'思考主线 · 今天 10:24';
  if(changing){ $('branch-thoughts').replaceChildren(); $('branch-input').value=''; }
  $('branch-empty').hidden=true; $('branch-active').hidden=false; $('branch-pane').classList.add('open');
  document.querySelectorAll('[data-branch]').forEach(el=>el.classList.toggle('active',el.dataset.branch===kind));
  $('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false');
  $('branch-close').focus({preventScroll:true});
}
function closeBranch(focus=true){ $('branch-active').hidden=true; $('branch-empty').hidden=false; $('branch-pane').classList.remove('open'); document.querySelectorAll('[data-branch]').forEach(el=>el.classList.remove('active')); if(focus&&returnTrigger?.isConnected) returnTrigger.focus({preventScroll:true}); }
function locateOrigin(){
  const source=origin; closeBranch(false); setView(source);
  const target=$(source==='material'?'material-anchor':'answer-anchor');
  target.scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'center'});
  target.classList.remove('highlight'); void target.offsetWidth; target.classList.add('highlight');
  $(source==='material'?'material-explore':'explore').focus({preventScroll:true});
}
for(const id of ['concept','explore','empty-explore']) $(id).addEventListener('click',e=>openBranch('feedback','conversation',e.currentTarget));
$('material-explore').addEventListener('click',e=>openBranch('feedback','material',e.currentTarget));
document.querySelectorAll('[data-branch]').forEach(el=>el.addEventListener('click',()=>openBranch(el.dataset.branch,'conversation',el)));
for(const id of ['branch-close','back-trunk','trunk-nav']) $(id).addEventListener('click',()=>closeBranch());
$('reveal-source').addEventListener('click',locateOrigin);
for(const name of ['conversation','material']) $(name+'-tab').addEventListener('click',()=>setView(name));
document.querySelectorAll('[role="tab"]').forEach(tab=>tab.addEventListener('keydown',e=>{ if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); const next=tab.id==='material-tab'?'conversation':'material'; setView(next); $(next+'-tab').focus(); } }));
$('return-open').addEventListener('click',()=>{ $('harvest').value=examples[activeBranch].harvest; $('dialog-origin').textContent='来源：'+examples[activeBranch].title+(origin==='material'?' · 系统之美 · v1 · 第 02 段':'')+' → 思考主线'; $('return-dialog').showModal(); });
let savedBranch='feedback', savedOrigin='conversation';
$('return-form').addEventListener('submit',e=>{ e.preventDefault(); const value=$('harvest').value.trim(); if(!value){ $('harvest').setCustomValidity('请先写下一点收获。'); $('harvest').reportValidity(); return; } savedBranch=activeBranch; savedOrigin=origin; $('return-text').textContent=value; $('return-source').textContent=examples[activeBranch].title+(origin==='material'?' · 阅读摘记 v1 · 第 02 段':'')+' · 查看探索 ↗'; $(origin==='material'?'material-returns':'answer-anchor').append($('return-card')); $('return-dialog').close(); closeBranch(false); setView('conversation'); $('return-card').hidden=false; $('return-card').scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'nearest'}); $('main-input').focus({preventScroll:true}); toast('收获已带回主线 · 仅演示，未写入正式数据'); });
$('harvest').addEventListener('input',()=> $('harvest').setCustomValidity(''));
$('return-source').addEventListener('click',e=>openBranch(savedBranch,savedOrigin,e.currentTarget));
document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>$(el.dataset.close).close()));
$('source-open').addEventListener('click',()=>{ const material=origin==='material'; $('source-kind').textContent=material?'材料原文':'主线回答'; $('source-title').textContent=material?'系统之美 · 阅读摘记.md':$('tree-title').textContent; $('source-quote').textContent=$('origin-quote').textContent; $('source-meta').textContent=material?'v1 · 第 02 段 · 示例来源':'示例锚点 · 今天 10:24'; $('source-dialog').showModal(); });
$('source-locate').addEventListener('click',()=>{ $('source-dialog').close(); locateOrigin(); });
function appendThought(container,value){ const article=document.createElement('article'); article.className='demo-thought'; const label=document.createElement('small'); label.textContent='你 · 示例输入'; const paragraph=document.createElement('p'); paragraph.textContent=value; article.append(label,paragraph); container.append(article); article.scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'nearest'}); }
for(const name of ['main','branch']) $(name+'-form').addEventListener('submit',e=>{ e.preventDefault(); const input=$(name+'-input'); const value=input.value.trim(); if(!value){input.focus();return;} appendThought($(name==='main'?'new-thoughts':'branch-thoughts'),value); input.value=''; toast('输入已展示 · 设计稿未连接模型'); });
$('menu').addEventListener('click',()=>{ const open=$('sidebar').classList.toggle('open'); $('menu').setAttribute('aria-expanded',String(open)); });
document.addEventListener('click',e=>{ if($('sidebar').classList.contains('open')&&!$('sidebar').contains(e.target)&&!$('menu').contains(e.target)){ $('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false'); } });
document.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); if(!document.querySelector('dialog[open]')) openSearch(); } if(e.key==='Escape'&&!document.querySelector('dialog[open]')){ closeBranch(); $('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false'); } });
const searchItems=[{title:'反馈回路与习惯',kind:'支线 · 系统思维的日常练习',branch:'feedback'},{title:'寻找杠杆点',kind:'支线 · 系统思维的日常练习',branch:'leverage'},{title:'系统之美 · 阅读摘记.md',kind:'材料 · v1 · 第 02 段',material:true},{title:'如何建立长期的学习系统',kind:'思考树 · 昨天',tree:true},{title:'设计中的秩序与留白',kind:'思考树 · 10 月 12 日',tree:true}];
function renderSearch(){ const query=$('search-input').value.trim().toLowerCase(); const results=searchItems.filter(item=>(item.title+item.kind).toLowerCase().includes(query)); $('search-results').replaceChildren(); for(const item of results){ const button=document.createElement('button'); button.className='search-result'; const text=document.createElement('span');text.textContent=item.title;const note=document.createElement('small');note.textContent=item.kind;text.append(note);button.append(text);button.addEventListener('click',()=>{ $('search-dialog').close(); if(item.branch)openBranch(item.branch);else if(item.material)setView('material');else selectTree(item.title); }); $('search-results').append(button); } if(!results.length){ const empty=document.createElement('p');empty.className='muted';empty.textContent='没有匹配的示例思考。';$('search-results').append(empty); } }
function openSearch(){ $('search-input').value=''; renderSearch(); $('search-dialog').showModal(); $('search-input').focus(); }
$('search-open').addEventListener('click',openSearch); $('search-input').addEventListener('input',renderSearch);
function selectTree(title){ closeBranch(false); setView('conversation'); $('page-title').textContent=title; $('tree-title').textContent=title; document.querySelectorAll('[data-tree]').forEach(el=>el.classList.toggle('selected',el.dataset.tree===title)); $('sidebar').classList.remove('open'); $('menu').setAttribute('aria-expanded','false'); $('new-thoughts').replaceChildren(); toast('已切换树标题 · 对话内容为通用演示样例'); }
document.querySelectorAll('[data-tree]').forEach(el=>el.addEventListener('click',()=>selectTree(el.dataset.tree)));
$('new-tree').addEventListener('click',()=>{ $('new-title').value=''; $('new-dialog').showModal(); $('new-title').focus(); });
$('new-form').addEventListener('submit',e=>{ e.preventDefault(); const title=$('new-title').value.trim(); if(!title)return; const button=document.createElement('button');button.className='forest-item';button.dataset.tree=title; const dot=document.createElement('span');dot.className='tree-dot'; const text=document.createElement('span');text.textContent=title;const small=document.createElement('small');small.textContent='刚刚 · 演示';text.append(small);button.append(dot,text);button.addEventListener('click',()=>selectTree(title));document.querySelector('.forest').append(button); $('forest-count').textContent=String(document.querySelectorAll('[data-tree]').length).padStart(2,'0'); $('new-dialog').close(); selectTree(title); toast('已种下示例思考树 · 当前页面内保留'); });
