import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
// @ts-expect-error Native browser runner modules have no declaration files.
import { createBrowserProjections } from '../../scripts/d3/browser-projections.mjs';
function fixture() {
 const state={round:1,tree:'tree-one',selected:false,clicks:0,pages:[['u1','a1'],['u2','a2']]};
 const body={};
 const makeTurn=(id:string)=>({dataset:{turnId:id,turnText:id},classList:{contains:(role:string)=>role===(id.startsWith('a')?'assistant':'user')},querySelector:()=>null});
 const branch={dataset:{branchId:'trunk'},textContent:'Main',classList:{contains:(name:string)=>name==='active'},getAttribute:()=>null};
 const elements: Record<string,unknown>={
  'round-navigation':{hidden:false}, 'round-position':{get textContent(){return `${state.pages.length?state.round+1:0} / ${state.pages.length}`;}},
  'round-previous':{get disabled(){return state.round<=0;},click(){state.round--;state.clicks++;}},
  'round-next':{get disabled(){return state.round>=state.pages.length-1;},click(){state.round++;state.clicks++;}},
  'conversation':{scrollTop:23},'branch-panel':{hidden:true},'run-status':{textContent:'idle'},'tree-list':{children:[branch]},
 };
 const document={body,activeElement:body,readyState:'complete',getElementById:(id:string)=>elements[id]??null,
  querySelector:(selector:string)=>selector==='#tree-list button.active'?{dataset:{treeId:state.tree}}:null,
  querySelectorAll:(selector:string)=>{
   if(selector==='#branch-tabs button')return [branch];
   if(selector.includes('#conversation .turn')) {
    const all=(state.pages[state.round]??[]).map(makeTurn);
    if(selector.includes('.assistant'))return all.filter(t=>t.dataset.turnId.startsWith('a'));
    if(selector.includes('.return'))return [];
    return all;
   }
   return [];
  }};
 const context={setTimeout,document,location:{pathname:'/'},window:{getSelection:()=>({toString:()=>state.selected?'selection':''})},getComputedStyle:()=>({display:'block'}),requestAnimationFrame:(callback:()=>void)=>callback()};
 const evalJs=async(expression:string)=>runInNewContext(expression,context);
 const projections=createBrowserProjections({evalJs,assert:(ok:unknown,message:string)=>assert.ok(ok,message)}) as {pageSummaryExpression():string;assistantTurnSelector(container:string,index:number):Promise<string>};
 const summary=async()=>JSON.parse(JSON.stringify(await evalJs(projections.pageSummaryExpression()))) as {conversation:{turns:{turnId:string}[];roundCount:number}};
 return {state,summary,projections};
}
test('round probe reads all actual pages in order and restores the selected page',async()=>{
 const f=fixture(); const snapshot=await f.summary();
 assert.deepEqual(snapshot.conversation.turns.map(t=>t.turnId),['u1','a1','u2','a2']);
 assert.equal(f.state.round,1); assert.equal(snapshot.conversation.roundCount,2);
 const target=await f.projections.assistantTurnSelector('#conversation',0);
 assert.ok(target.includes('a1')); assert.equal(f.state.round,0);
});
test('round probe keeps a native selection intact, refreshes appended pages and isolates tree identity',async()=>{
 const f=fixture(); await f.summary(); f.state.selected=true; f.state.round=0; f.state.clicks=0;
 assert.equal((await f.summary()).conversation.turns.length,4); assert.equal(f.state.clicks,0);
 f.state.selected=false; f.state.pages.push(['u3','a3']); f.state.round=2;
 assert.equal((await f.summary()).conversation.turns.length,6); assert.equal(f.state.round,2);
 f.state.tree='tree-two'; f.state.pages=[['fresh-user','fresh-answer']]; f.state.round=0;
 assert.deepEqual((await f.summary()).conversation.turns.map(t=>t.turnId),['fresh-user','fresh-answer']);
});
test('round probe handles a fresh empty conversation without stale or out-of-scope counters',async()=>{
 const f=fixture(); f.state.pages=[]; f.state.round=0;
 const snapshot=await f.summary(); assert.equal(snapshot.conversation.turns.length,0); assert.equal(snapshot.conversation.roundCount,0);
});
