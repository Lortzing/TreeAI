import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
// @ts-expect-error Native browser runner has no TS declarations.
import {exposeInputTarget} from '../../scripts/d4/browser/material/input.mjs';
for (const identified of [true,false]) test(`native disclosure targeting handles a summary ${identified?'with':'without'} its own ID`,async()=>{
 const details={tagName:'DETAILS',id:'search-section',open:false,parentElement:null as unknown,children:[] as unknown[],querySelector:()=>summary};
 const summary={tagName:'SUMMARY',id:identified?'search-shortcut':'',parentElement:details,contains:(el:unknown)=>el===summary,closest:(selector:string)=>selector==='#sidebar'?null:summary,getBoundingClientRect:()=>({left:10,top:10,width:100,height:40}),scrollIntoView:()=>{}};
 const input={tagName:'INPUT',parentElement:details,closest:(selector:string)=>selector==='#sidebar'?null:input,getBoundingClientRect:()=>({left:10,top:60,width:100,height:40}),scrollIntoView:()=>{}};
 details.children=[summary,input];const selectors:string[]=[];let target:unknown;
 const document={body:{classList:{contains:()=>false}},getElementById:()=>null,querySelector:(selector:string)=>{
  selectors.push(selector);assert.ok(!selector.endsWith(' > '),'the selector is complete');
  target=selector==='#search-input'?input:summary;return target;
 },elementFromPoint:()=>target};
 const ctx={evalJs:async(code:string)=>runInNewContext(code,{document,CSS:{escape:(s:string)=>s}}),cdpSend:async(_method:string,args:{type:string})=>{if(args.type==='mouseReleased')details.open=true;}};
 await exposeInputTarget(ctx,'#search-input');assert.equal(details.open,true);
 assert.ok(selectors.includes(identified?'#search-shortcut':'#search-section > summary:nth-child(1)'));
});
