/** Resolve only the published local CSS imports in style.css, in original cascade order.
 * The scripted-DOM tests inspect the effective stylesheet rather than a single
 * physical file; this preserves every pre-split media-rule assertion.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function studioCssModuleNames(publicDir: string): string[] {
  const entry = readFileSync(join(publicDir, "style.css"), "utf8");
  const lines = entry.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const names = lines.map((line) => {
    const match = /^@import url\("\/styles\/([a-z-]+\.css)"\);$/.exec(line);
    if (match === null) throw new Error(`unexpected stylesheet entry: ${line}`);
    return match[1]!;
  });
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error("missing or duplicate CSS module imports");
  }
  return names;
}

export function readStudioCss(publicDir: string): string {
  return studioCssModuleNames(publicDir)
    .map((name) => readFileSync(join(publicDir, "styles", name), "utf8"))
    .join("");
}
