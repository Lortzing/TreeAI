import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { createStaticResponder } from "../src/http/static.ts";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
async function call(pathname: string) {
  let status: number|null=null;
  let headers: Record<string,any>|null=null;
  let body: unknown=null;
  const response = {
    writeHead(code: number, metadata: Record<string,any>) { status=code; headers=metadata; return response; },
    end(chunk?:unknown) {body=chunk; return response;},
  } as unknown as ServerResponse;
  const handled=await createStaticResponder(publicDir)(response,pathname);
  return {handled,status,headers,body};
}
test("ESM and CSS static allowlist serves correct content type", async () => {
  for (const path of ["/app.js", "/core/create-studio-app.js", "/core/dom.js", "/core/views/search.js",
    "/shared/source/sha256.js", "/shared/source/selection.js",
    "/shared/reading-position/scroll.js"]) {
    const r=await call(path);
    assert.equal(r.handled,true,path);
    assert.equal(r.status,200,path);
    assert.equal(r.headers?.["content-type"],"text/javascript; charset=utf-8",path);
  }
  const css=await call("/styles/responsive.css");
  assert.equal(css.status,200);
  assert.equal(css.headers?.["content-type"],"text/css; charset=utf-8");
});
test("unknown static paths and traversal attempts are rejected, not read from disk", async () => {
  for (const path of ["/.env","/styles/../app.js","/styles/secret.css","/core/nope.js","/package.json"]) {
    const r=await call(path);
    assert.equal(r.handled,false,path);
    assert.equal(r.status,null,path);
  }
});
