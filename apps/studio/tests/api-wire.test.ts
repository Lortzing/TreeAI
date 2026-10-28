/** Actual pinned Pi SDK against local protocol fixtures; no vendor API or credentials. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseApiConfig, prepareApiConfig, API_FORMATS } from "../src/api-config.ts";
import { createPiRuntime } from "@treeai/runtime-pi";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeApiConnection } from "../src/api-settings.ts";
function anthropic() {
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } };
  return [ ["message_start", { type: "message_start", message }], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }], ["content_block_stop", { type: "content_block_stop", index: 0 }], ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }], ["message_stop", { type: "message_stop" }] ].map(([event,data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
function chat() { return [{ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] }, { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }].map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n"; }
function responses() {
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "fixture", output: [item], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }, { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" }, { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "OK" }, { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }].map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
for (const api of API_FORMATS) {
  test(`actual Pi SDK streams ${api} and uses the configured model/header`, async () => {
    const requests: { path: string; body: Record<string, unknown>; header: string | string[] | undefined }[] = [];
    const server = createServer(async (req,res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()), header: req.headers['x-test-client'] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(api === 'anthropic-messages' ? anthropic() : api === 'openai-completions' ? chat() : api === 'openai-responses' ? responses() : 'data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } }) + '\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
    const port = (server.address() as { port: number }).port;
    const oldKey = process.env.TREEAI_WIRE_KEY, oldHeader = process.env.TREEAI_WIRE_HEADER;
    process.env.TREEAI_WIRE_KEY = 'fixture-api-key'; process.env.TREEAI_WIRE_HEADER = 'fixture-client';
    try {
      const config = parseApiConfig({ providers: { 'wire-test': { api, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'TREEAI_WIRE_KEY', headerEnv: { 'X-Test-Client': 'TREEAI_WIRE_HEADER' }, models: [{ id: 'fixture' }] } } });
      const result = await probeApiConnection({ config, selection: { providerId: 'wire-test', modelId: 'fixture' } }, process.env);
      assert.equal(result.ok, true, JSON.stringify({ result, requests }));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.header, 'fixture-client');
      if (api === 'google-generative-ai') assert.ok(requests[0]!.path.includes('fixture'));
      else { assert.equal(requests[0]!.body.model, 'fixture'); assert.equal(requests[0]!.body.stream, true); }
    } finally {
      if (oldKey === undefined) delete process.env.TREEAI_WIRE_KEY; else process.env.TREEAI_WIRE_KEY = oldKey;
      if (oldHeader === undefined) delete process.env.TREEAI_WIRE_HEADER; else process.env.TREEAI_WIRE_HEADER = oldHeader;
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}


test("stored multi-provider keys and custom headers reach the real SDK only in memory", async () => {
  const seen: { auth: string | undefined; header: string | undefined }[] = [];
  const server = createServer(async (req,res) => {
    for await (const _chunk of req) { /* drain fixture input */ }
    seen.push({auth: req.headers['x-api-key'] as string | undefined, header: req.headers['x-memory-header'] as string | undefined});
    res.writeHead(200, {'Content-Type':'text/event-stream'}); res.end(anthropic());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'treeai-memory-wire-'));
  const provider=(name:string)=>({api:'anthropic-messages',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKeyEnv:name,headerEnv:{'X-Memory-Header':'TREEAI_MEMORY_HEADER'},models:[{id:'fixture'}]});
  const config=parseApiConfig({providers:{first:provider('TREEAI_MEMORY_FIRST'),second:provider('TREEAI_MEMORY_SECOND')}});
  const prepared=prepareApiConfig(config,{dataDir:dir,providerId:'first',modelId:'fixture',terminologyProviderId:'second',terminologyModelId:'fixture'},
    {TREEAI_MEMORY_FIRST:'first-memory-canary',TREEAI_MEMORY_SECOND:'second-memory-canary',TREEAI_MEMORY_HEADER:'!literal-$TREEAI_MUST_NOT_EXPAND'});
  const runtime=createPiRuntime({agentDir:prepared.agentDir,defaultCwd:dir,credentials:prepared.credentials});
  try{
    assert.equal(process.env.TREEAI_MEMORY_SECOND,undefined);
    await runtime.createSession({model:{providerId:'second',modelId:'fixture'},cwd:dir,sessionDir:join(dir,'sessions')});
    const answer=await runtime.prompt({text:'Reply OK'});assert.equal(answer.message,'OK');
    assert.deepEqual(seen,[{auth:'second-memory-canary',header:'!literal-$TREEAI_MUST_NOT_EXPAND'}]);
    const disk=readFileSync(join(prepared.agentDir,'models.json'),'utf8');
    for(const value of ['first-memory-canary','second-memory-canary','!literal-$TREEAI_MUST_NOT_EXPAND'])assert.ok(!disk.includes(value));
  }finally{await runtime.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
