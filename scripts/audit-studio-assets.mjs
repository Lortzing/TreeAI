#!/usr/bin/env node
/**
 * R0/R1 asset dependency audit for unbundled native Studio ESM.
 * Fails closed when a relative module is absent from the exact HTTP allowlist.
 * No browser framework, generated manifest, API keys, or external dependencies.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = resolve(ROOT,"apps/studio/public");
const serverSource=readFileSync(resolve(ROOT,"apps/studio/src/http/static.ts"),"utf8");
const installerSource=readFileSync(resolve(ROOT,"scripts/d4/package-installer.mjs"),"utf8");
const indexSource=readFileSync(resolve(PUBLIC,"index.html"),"utf8");
const styleSource=readFileSync(resolve(PUBLIC,"style.css"),"utf8");
const errors=[];
const staticRoutes=new Map([...serverSource.matchAll(/"(\/[a-zA-Z0-9_.\/-]+)":\s*\{\s*file:\s*"([^"]+)"/g)]
  .map(m=>[m[1],m[2]]));
const staticRouteNames = [...serverSource.matchAll(/"(\/[a-zA-Z0-9_.\/-]+)":\s*\{\s*file:/g)].map(match => match[1]);
if (new Set(staticRouteNames).size !== staticRouteNames.length) errors.push("Duplicate exact static JS/CSS route");
const cssEntry=/const CSS_MODULE_FILES = new Set\(\[([^\]]+)\]\)/.exec(serverSource);
if(cssEntry===null)errors.push("Missing static CSS filename allowlist");
const cssFiles=new Set(cssEntry?[...cssEntry[1].matchAll(/"([^"]+\.css)"/g)].map(x=>x[1]):[]);
const importedCSS=[...styleSource.matchAll(/@import\s+url\(["'](\/styles\/[^"']+\.css)["']\)/g)].map(m=>m[1]);
for(const url of importedCSS){
 const file=url.slice("/styles/".length);
 if(!cssFiles.has(file))errors.push(`CSS URL ${url} not allowlisted`);
 if(!existsSync(resolve(PUBLIC,"styles",file)))errors.push(`CSS file missing: ${url}`);
}
for(const name of cssFiles)if(!importedCSS.includes("/styles/"+name))errors.push(`Unused allowlisted CSS module: ${name}`);
if(!indexSource.includes('<script type="module" src="/app.js"></script>'))errors.push("ESM bootstrap script changed");
if(!indexSource.includes('href="/style.css"'))errors.push("CSS bootstrap link changed");

const visited=new Set();
function auditModule(url) {
 if(visited.has(url))return;
 visited.add(url);
 const rel=url.slice(1);
 const path=resolve(PUBLIC,rel);
 if(!path.startsWith(PUBLIC+sep)) { errors.push(`URL escaped public dir: ${url}`);return; }
 if(staticRoutes.get(url)!==rel){errors.push(`Missing/mismatched exact static JS route ${url} => ${rel}`);return;}
 if(!existsSync(path)){errors.push(`ESM asset missing on disk: ${url}`);return;}
 const source=readFileSync(path,"utf8");
 const imports=[
   ...source.matchAll(/\bfrom\s*["'](\.[^"']+\.js)["']/g),
   ...source.matchAll(/\bimport\s*["'](\.[^"']+\.js)["']/g),
   ...source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+\.js)["']\s*\)/g),
 ];
 for(const match of imports){
   const target=resolve(dirname(path),match[1]);
   const targetUrl="/"+relative(PUBLIC,target).split(sep).join("/");
   if(target.includes("/tests/")||target.includes("/fixtures/"))errors.push(`Production import of test resource: ${url} -> ${match[1]}`);
   auditModule(targetUrl);
 }
}
auditModule("/app.js");
// Pinned, self-hosted Web Awesome subset: check every byte and every relative stylesheet import.
const vendorRoot = resolve(PUBLIC, "vendor/webawesome");
const vendorManifest = JSON.parse(readFileSync(resolve(vendorRoot, "manifest.json"), "utf8"));
if (!existsSync(resolve(vendorRoot, "LICENSE.md"))) errors.push("Missing Web Awesome license");
if (!indexSource.includes('href="/vendor/webawesome/styles/themes/default.css"')) errors.push("Missing Web Awesome local theme");
for (const [name, checksum] of Object.entries(vendorManifest)) {
 const url = "/vendor/webawesome/" + name;
 const path = resolve(vendorRoot, name);
 if (staticRoutes.get(url) !== "vendor/webawesome/" + name) errors.push(`Vendor asset not exactly allowlisted: ${url}`);
 if (!existsSync(path)) { errors.push(`Missing vendor asset: ${url}`); continue; }
 const bytes = readFileSync(path);
 if (createHash("sha256").update(bytes).digest("hex") !== checksum) errors.push(`Vendored file changed: ${url}`);
 if (name.endsWith(".js") && !visited.has(url)) errors.push(`Unreachable vendor module: ${url}`);
 for (const match of bytes.toString().matchAll(/@import\s+url\(["']([^"']+)["']\)/g)) {
  const target = relative(vendorRoot, resolve(dirname(path), match[1])).split(sep).join("/");
  if (!Object.hasOwn(vendorManifest, target)) errors.push(`Vendor CSS dependency missing: ${target}`);
 }
}

if(!installerSource.includes('entry.name === "src" || entry.name === "public" || entry.name === "package.json"')) {
 errors.push("D4 installer no longer copies entire Studio public directory");
}
if(!installerSource.includes('join(REPO_ROOT, "apps", "studio")'))errors.push("Installer Studio input path not detected");
if(!installerSource.includes('join(REPO_ROOT, "node_modules", "pdfjs-dist")'))errors.push("Installer PDF.js inclusion not detected");
if(!serverSource.includes('const moduleMatch = /^\\/vendor\\/pdfjs\\/'))errors.push("PDF.js vendor static route not detected");
if(errors.length){console.error(errors.map(s=>"FAIL: "+s).join("\n"));process.exitCode=1;}
else console.log(`PASS: ${visited.size} native ESM assets + ${importedCSS.length} CSS modules and installer/public allowlist accounted for`);
