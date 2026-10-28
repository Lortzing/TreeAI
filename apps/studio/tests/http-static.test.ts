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
  for (const path of ["/core/views/session-workspace.js", "/core/controllers/workspace-events.js", "/app.js", "/core/create-studio-app.js", "/core/dom.js", "/core/controllers/nav-finder.js", "/core/controllers/nav-session.js", "/core/controllers/nav-interaction.js", "/core/controllers/nav-persistence.js", "/core/controllers/nav-node-search.js", "/core/controllers/nav-locate.js", "/core/views/nav-path.js", "/core/views/nav-node-results.js", "/core/views/nav-tree.js", "/core/views/search.js", "/core/views/return.js", "/core/views/diagnostics.js", "/core/views/nav-finder.js", "/core/views/nav-chrome.js",
    "/shared/source/sha256.js", "/shared/source/selection.js",
    "/shared/reading-position/scroll.js"]) {
    const r=await call(path);
    assert.equal(r.handled,true,path);
    assert.equal(r.status,200,path);
    assert.equal(r.headers?.["content-type"],"text/javascript; charset=utf-8",path);
  }
  for (const path of ["/styles/responsive.css", "/styles/session-workspace.css", "/styles/api-settings.css"]) {
    const css=await call(path);
    assert.equal(css.status,200);
    assert.equal(css.headers?.["content-type"],"text/css; charset=utf-8");
  }
});
test("unknown static paths and traversal attempts are rejected, not read from disk", async () => {
  for (const path of ["/.env","/styles/../app.js","/styles/secret.css","/core/nope.js","/package.json"]) {
    const r=await call(path);
    assert.equal(r.handled,false,path);
    assert.equal(r.status,null,path);
  }
});
