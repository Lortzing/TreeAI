import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { ApiSettingsService, readSavedApiSettings, parseApiSettings } from '../src/api-settings.ts';
import { handleApiSettingsRoute } from '../src/http/routes/api-settings.ts';
const profile = () => parseApiSettings({ config: { providers: { local: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:15722', apiKeyEnv: 'LOCAL_API_KEY', models: [{ id: 'fixture' }] } } }, selection: { providerId: 'local', modelId: 'fixture' } });
test('settings save is atomic, detects stale edits, and activates only on a later startup', () => {
 const dir=mkdtempSync(join(tmpdir(),'treeai-api-settings-'));
 try {
  const service=new ApiSettingsService({ dataDir:dir,initial:null,env:{ LOCAL_API_KEY:'secret-never-write' } });
  const snapshot=service.snapshot(); assert.equal(snapshot.configured,false);
  const next=service.save({ ...profile(), revision:snapshot.revision });
  assert.equal(next.restartRequired,true); assert.equal(next.environment[0]!.present,true);
  assert.ok(!JSON.stringify(next).includes('secret-never-write'));
  assert.ok(!readFileSync(join(dir,'api-settings.json'),'utf8').includes('secret-never-write'));
  assert.throws(()=>service.save({ ...profile(), revision:snapshot.revision }),/settings-conflict/);
  const stored=readSavedApiSettings(dir); assert.deepEqual(stored?.selection,profile().selection);
  const restarted=new ApiSettingsService({ dataDir:dir, initial:stored,env:{} });
  assert.equal(restarted.snapshot().restartRequired,false);
  assert.equal(restarted.snapshot().environment[0]!.present,false);
 } finally { rmSync(dir,{ recursive:true,force:true }); }
});
test('connection testing is isolated, prevents concurrent probes, and never saves a draft', async () => {
 const dir=mkdtempSync(join(tmpdir(),'treeai-api-settings-'));
 let finish!: (v:{ok:boolean;code:string;message:string})=>void;
 const service=new ApiSettingsService({ dataDir:dir,initial:profile(),env:{},credentialStore:{supported:false,backend:"unsupported",get:async()=>null,set:async()=>{},remove:async()=>{}},probe:()=>new Promise(resolve=>{finish=resolve;}) });
 try {
  const first=service.test(profile());
  await assert.rejects(service.test(profile()),/probe-busy/);
  finish({ok:true,code:'connected',message:'ok'}); assert.equal((await first).ok,true);
  assert.equal(readSavedApiSettings(dir),null);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('an explicitly offline recovery can manage corrupt saved settings without exposing or overwriting their contents', () => {
 const dir=mkdtempSync(join(tmpdir(),'treeai-api-settings-'));
 try {
  const path=join(dir,'api-settings.json');writeFileSync(path,'{broken-secret-sentinel');
  const service=new ApiSettingsService({dataDir:dir,initial:null,env:{}});
  assert.equal(service.snapshot().configurationWarning,true);
  assert.ok(!JSON.stringify(service.snapshot()).includes('broken-secret-sentinel'));
  assert.equal(readFileSync(path,'utf8'),'{broken-secret-sentinel');
  const repaired=service.save({...profile(),revision:service.snapshot().revision});
  assert.equal(repaired.configurationWarning,false);
  assert.deepEqual(readSavedApiSettings(dir)?.selection,profile().selection);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('HTTP settings reject cross-origin, rebinding hosts and unguarded writes; responses contain no secret values', async () => {
 const dir=mkdtempSync(join(tmpdir(),'treeai-api-settings-'));
 const service=new ApiSettingsService({ dataDir:dir,initial:profile(),env:{ LOCAL_API_KEY:'secret-never-send' },probe:async()=>({ok:true,code:'connected',message:'ok'}) });
 const server=createServer((req,res)=>{void handleApiSettingsRoute(req,res,new URL(req.url!,'http://localhost').pathname,service);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try {
  const snap=await (await fetch(base+'/api/settings/api')).json() as {revision:string}; assert.ok(!JSON.stringify(snap).includes('secret-never-send'));
  assert.equal((await fetch(base+'/api/settings/api',{headers:{Origin:'https://evil.example'}})).status,403);
  const rebound = await new Promise<number>((resolve,reject)=>{ const req=request(base+'/api/settings/api',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end(); });
  assert.equal(rebound,403);
  assert.equal((await fetch(base+'/api/settings/api',{method:'PUT',body:JSON.stringify({...profile(),revision:snap.revision})})).status,403);
  const headers={'Content-Type':'application/json','X-TreeAI-Settings':'1',Origin:base};
  const saved=await fetch(base+'/api/settings/api',{method:'PUT',headers,body:JSON.stringify({...profile(),revision:snap.revision})}); assert.equal(saved.status,200);
  const stale=await fetch(base+'/api/settings/api',{method:'PUT',headers,body:JSON.stringify({...profile(),revision:'stale'})}); assert.equal(stale.status,409);
  const bad=await fetch(base+'/api/settings/api/test',{method:'POST',headers,body:JSON.stringify({config:{providers:{local:{apiKey:'raw-secret-sentinel'}}}})}); assert.equal(bad.status,400); assert.ok(!(await bad.text()).includes('raw-secret-sentinel'));
  const probe=await fetch(base+'/api/settings/api/test',{method:'POST',headers,body:JSON.stringify(profile())}); assert.equal(((await probe.json()) as {ok:boolean}).ok,true);
 } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(dir,{recursive:true,force:true}); }
});

test('system credentials are separate from settings, resolve in memory, and can be removed without changing environment values', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'treeai-api-vault-'));const entries=new Map<string,string>();const env={};
 const store={supported:true,backend:'test-keychain',get:async(name:string)=>entries.get(name)??null,set:async(name:string,value:string)=>{entries.set(name,value);},remove:async(name:string)=>{entries.delete(name);}};
 let probeKey:string|undefined;
 const service=new ApiSettingsService({dataDir:dir,initial:profile(),env,credentialStore:store,probe:async(_settings,resolved)=>{probeKey=resolved.LOCAL_API_KEY;return {ok:true,code:'connected',message:'ok'};}});
 try{
  const result=await service.credential({...profile(),value:'synthetic-vault-value'});assert.equal(result.stored,true);
  assert.ok(!JSON.stringify(result).includes('synthetic-vault-value'));assert.equal(readSavedApiSettings(dir),null);
  await service.refreshCredentials();assert.equal(service.snapshot().environment[0]!.source,'keychain');
  assert.ok(!JSON.stringify(service.snapshot()).includes('synthetic-vault-value'));
  await service.test(profile());assert.equal(probeKey,'synthetic-vault-value');assert.deepEqual(env,{});
  service.save({...profile(),revision:service.snapshot().revision});assert.ok(!readFileSync(join(dir,'api-settings.json'),'utf8').includes('synthetic-vault-value'));
  await service.credential(profile(),true);assert.equal(entries.size,0);assert.equal(service.snapshot().environment[0]!.present,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('credential HTTP writes keep origin and CSRF guards and sanitize native failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'treeai-vault-http-'));const entries=new Map<string,string>();
 const service=new ApiSettingsService({dataDir:dir,initial:profile(),env:{},credentialStore:{supported:true,backend:'test',get:async(name)=>entries.get(name)??null,set:async(name,value)=>{if(value==='native-failure-canary')throw new Error(value);entries.set(name,value);},remove:async(name)=>{entries.delete(name);}}});
 const server=createServer((req,res)=>{void handleApiSettingsRoute(req,res,new URL(req.url!,'http://localhost').pathname,service);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const payload={...profile(),value:'http-synthetic-key'};const url=base+'/api/settings/api/credentials';
  assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(payload)})).status,403);assert.equal(entries.size,0);
  const headers={'Content-Type':'application/json','X-TreeAI-Settings':'1',Origin:base};
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(payload)})).status,403);
  const saved=await fetch(url,{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes('http-synthetic-key'));
  const snapshotText=await (await fetch(base+'/api/settings/api')).text();assert.ok(!snapshotText.includes('http-synthetic-key'));
  const failed=await fetch(url,{method:'POST',headers,body:JSON.stringify({...profile(),value:'native-failure-canary'})});assert.equal(failed.status,400);assert.ok(!(await failed.text()).includes('native-failure-canary'));
  assert.equal((await fetch(url,{method:'DELETE',headers,body:JSON.stringify(profile())})).status,200);assert.equal(entries.size,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
