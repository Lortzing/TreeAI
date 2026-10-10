import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TreeDiagnostics, TreeStudioService } from "../src/service.ts";
import { createSseStream } from "../src/http/sse.ts";

test("SSE emits the owning tree only, snapshot before events, and disconnects once", () => {
  const request = new EventEmitter() as IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    status: 0, chunks: [] as string[], ended: 0,
    writeHead(code: number) { this.status=code; return this; },
    write(chunk: string) { this.chunks.push(chunk); return true; },
    end() { this.ended++; return this; },
  }) as unknown as ServerResponse & { status:number; chunks:string[]; ended:number };
  let listener: ((event: {treeId:string;type:string})=>void) | null = null;
  let unsub = 0;
  const service = {subscribeStudioEvents(cb: typeof listener){listener=cb;return () => {unsub++;};}} as unknown as TreeStudioService;
  const responses = new Set<ServerResponse>();
  createSseStream(service,responses)(request,response,"a" as never,{ok:true} as unknown as TreeDiagnostics);
  assert.equal(response.status,200);
  assert.deepEqual(response.chunks.slice(0,2).map(text=>text.split(String.fromCharCode(10))[0]),[": connected","event: snapshot"]);
  assert.equal(responses.size,1);
  assert.ok(listener!==null);
  (listener as (event:{treeId:string;type:string})=>void)({treeId:"b",type:"wrong"});
  (listener as (event:{treeId:string;type:string})=>void)({treeId:"a",type:"run-terminal"});
  assert.equal(response.chunks.join("").includes("wrong"),false);
  assert.equal(response.chunks.join("").includes("run-terminal"),true);
  request.emit("close");
  response.emit("close");
  assert.equal(unsub,1);
  assert.equal(response.ended,1);
  assert.equal(responses.size,0);
});
