import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser ES modules intentionally have no TypeScript declarations.
import { registerApiSettings } from '../public/core/controllers/api-settings.js';
class Element extends EventTarget {
 value='';textContent='';disabled=false;open=false;children:Element[]=[];elements:Element[]=[];attrs=new Set<string>();
 get firstChild():Element|null{return this.children[0]??null;}
 appendChild(child:Element){this.children.push(child);return child;}
 removeChild(child:Element){this.children.splice(this.children.indexOf(child),1);}
 setAttribute(name:string){this.attrs.add(name);if(name==='open')this.open=true;}
 removeAttribute(name:string){this.attrs.delete(name);if(name==='open')this.open=false;}
 hasAttribute(name:string){return this.attrs.has(name);}
 showModal(){this.open=true;}
 close(){this.open=false;this.dispatchEvent(new Event('close'));}
 click(){this.dispatchEvent(new Event('click',{cancelable:true}));}
}
const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));};
const snapshot=()=>({enabled:true,configured:true,revision:'first',restartRequired:false,config:{providers:{local:{api:'anthropic-messages',baseUrl:'http://127.0.0.1:15722',apiKeyEnv:'LOCAL_API_KEY',models:[{id:'one',contextWindow:10000,maxTokens:1000},{id:'two',contextWindow:20000,maxTokens:2000}]}}},selection:{providerId:'local',modelId:'one'},environment:[{name:'LOCAL_API_KEY',present:true}]});
function setup(fetch:(path:string,options?:{body?:string;signal?:AbortSignal;headers?:Record<string,string>;method?:string})=>Promise<unknown>){
 const ids=['api-settings-open','api-settings-dialog','api-settings-form','api-settings-close','api-provider','api-model','api-format','api-base-url','api-key-env','api-context-window','api-max-tokens','api-provider-add','api-model-add','api-connection-test','api-settings-status','api-config-json','api-json-apply','api-env-status'];
 const nodes=new Map(ids.map(id=>[id,new Element()]));nodes.get('api-settings-form')!.elements=[...nodes.values()];
 const defaultView=Object.assign(new EventTarget(),{AbortController});
 const document={getElementById:(id:string)=>nodes.get(id)??null,createElement:()=>new Element(),defaultView};
 return {el:(id:string)=>nodes.get(id)!,dispose:registerApiSettings({document,fetch}) as ()=>void};
}
test('API settings UI loads on demand, preserves edited values across model switching and sends guarded test/save requests',async()=>{
 const requests:{path:string;body:Record<string,unknown>|null;headers:Record<string,string>|undefined}[]=[];
 const ui=setup(async(path,options)=>{
  const body=options?.body?JSON.parse(options.body):null;requests.push({path,body,headers:options?.headers});
  return {ok:true,status:200,json:async()=>path.endsWith('/test')?{ok:true,code:'connected'}:options?.method==='PUT'?{...snapshot(),...body,revision:'second',restartRequired:true}:snapshot()};
 });
 try {
  assert.equal(requests.length,0);ui.el('api-settings-open').click();await tick();
  assert.equal(ui.el('api-provider').value,'local');assert.equal(ui.el('api-key-env').value,'LOCAL_API_KEY');
  ui.el('api-base-url').value='https://api.example.com';ui.el('api-base-url').dispatchEvent(new Event('input'));
  ui.el('api-model').value='two';ui.el('api-model').dispatchEvent(new Event('change'));
  ui.el('api-connection-test').click();await tick();
  assert.ok(ui.el('api-settings-status').textContent.includes('成功'));
  assert.equal(requests[1]!.headers!['X-TreeAI-Settings'],'1');
  const sent=requests[1]!.body as ReturnType<typeof snapshot>;
  assert.equal(sent.selection.modelId,'two');assert.equal(sent.config.providers.local.baseUrl,'https://api.example.com');
  ui.el('api-settings-form').dispatchEvent(new Event('submit',{cancelable:true}));await tick();
  assert.equal(requests[2]!.body!.revision,'first');assert.ok(ui.el('api-settings-status').textContent.includes('重启'));
  assert.equal(ui.el('api-connection-test').disabled,false);
 }finally{ui.dispose();}
});
test('API settings UI explains invalid JSON and stale saves without rendering untrusted server error text',async()=>{
 const ui=setup(async(_path,options)=>({ok:options?.method!=='PUT',status:options?.method==='PUT'?409:200,json:async()=>options?.method==='PUT'?{error:{code:'settings-conflict',message:'untrusted-server-value'}}:snapshot()}));
 try{
  ui.el('api-settings-open').click();await tick();
  ui.el('api-config-json').value='{bad';ui.el('api-json-apply').click();assert.ok(ui.el('api-settings-status').textContent.includes('JSON'));
  ui.el('api-settings-form').dispatchEvent(new Event('submit',{cancelable:true}));await tick();
  assert.ok(ui.el('api-settings-status').textContent.includes('其他窗口'));assert.ok(!ui.el('api-settings-status').textContent.includes('untrusted-server-value'));
  assert.equal(ui.el('api-connection-test').disabled,false);
 }finally{ui.dispose();}
});
test('API settings UI aborts an in-flight test on close and removes listeners on disposal',async()=>{
 let aborted=false,requests=0;
 const ui=setup(async(path,options)=>{
  requests++;
  if(!path.endsWith('/test'))return {ok:true,json:async()=>snapshot()};
  return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));}));
 });
 ui.el('api-settings-open').click();await tick();ui.el('api-connection-test').click();assert.equal(ui.el('api-connection-test').disabled,true);
 ui.el('api-settings-close').click();await tick();assert.equal(aborted,true);assert.equal(ui.el('api-connection-test').disabled,false);
 ui.dispose();ui.el('api-settings-open').click();await tick();assert.equal(requests,2);
});
