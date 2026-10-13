/** Resolve only the published local CSS imports in style.css, in original cascade order.
 * The scripted-DOM tests inspect the effective stylesheet rather than a single
 * physical file; this preserves every pre-split media-rule assertion.
 */
import {
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

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

export interface CssRule {
  selector: string;
  declarations: string;
}

export interface CssMediaBlock {
  query: string;
  rules: CssRule[];
}

export function extractMediaBlocks(css: string): CssMediaBlock[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: CssMediaBlock[] = [];
  const mediaRe = /@media([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = mediaRe.exec(src)) !== null) {
    const query = match[1]!.trim();
    let depth = 1;
    let end = mediaRe.lastIndex;
    while (end < src.length && depth > 0) {
      const ch = src[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      end += 1;
    }
    const body = depth === 0 ? src.slice(mediaRe.lastIndex, end - 1) : src.slice(mediaRe.lastIndex, end);
    const rules: CssRule[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(body)) !== null) {
      rules.push({
        selector: ruleMatch[1]!.trim().replace(/\s+/g, " "),
        declarations: ruleMatch[2]!.replace(/\s+/g, " ").trim(),
      });
    }
    blocks.push({ query, rules });
    mediaRe.lastIndex = end;
  }
  return blocks;
}

export function declarationsOf(block: CssMediaBlock, selector: string): string | null {
  const rule = block.rules.find((r) => r.selector === selector);
  return rule === undefined ? null : rule.declarations;
}

export function baseCssLayer(css: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf("@media", i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, at);
    const open = src.indexOf("{", at);
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}
