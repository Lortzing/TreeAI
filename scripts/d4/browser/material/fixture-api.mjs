/** fixture-api ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  B1_ROOT,
} from "./fixtures.mjs";
import {
  sleep,
} from "./input.mjs";
import {
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* B1 全分母/负例共享工具                                                */
/* ------------------------------------------------------------------ */

/** 分册登记读取（md-registry.json / pdf-registry.json；运行时读取，不内嵌）。 */
export function loadB1Registries(root) {
  const out = [];
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const registry = JSON.parse(readFileSync(join(root, ...B1_ROOT, name), "utf8"));
    out.push({ name, kind: registry.kind, fixtures: registry.fixtures, negativeFixtures: registry.negativeFixtures });
  }
  return out;
}

export function b1FixtureBasename(file) {
  return file.split("/").pop() ?? file;
}

/** 登记项 → 冻结 fixture（原始字节 + 真值；真值字段与登记 id 对账）。 */
export function loadB1RegistryFixture(root, entry, registryName) {
  const bytes = readFileSync(join(root, ...B1_ROOT, entry.file));
  const truth = JSON.parse(readFileSync(join(root, ...B1_ROOT, entry.expected), "utf8"));
  if (truth.fixtureId !== entry.fixtureId) {
    throw new Error(`${registryName}: truth id ${String(truth.fixtureId)} ≠ registry id ${String(entry.fixtureId)}`);
  }
  if (typeof truth.canonicalText !== "string" || !Array.isArray(truth.blocks)) {
    throw new Error(`${registryName}: ${String(entry.fixtureId)} truth missing canonicalText/blocks`);
  }
  const expectedUnits = typeof truth.textUnits === "number" ? truth.textUnits : truth.canonicalText.length;
  if (expectedUnits !== truth.canonicalText.length) {
    throw new Error(`${registryName}: ${String(entry.fixtureId)} truth textUnits ${String(truth.textUnits)} ≠ canonicalText.length ${String(truth.canonicalText.length)} (fixture inconsistency)`);
  }
  return { fixtureId: entry.fixtureId, filename: b1FixtureBasename(entry.file), bytes, truth, expectedUnits };
}

export const TERMINAL_PARSE_STATUSES = new Set(["ready", "failed", "canceled", "unsupported", "rejected"]);

/** 版本到达指定终态（ready / failed）；其他终态或超时如实失败。 */
export async function waitForVersionStatus(ctx, treeId, materialId, versionId, fixtureId, wantStatus, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}`);
    const version = (res.body?.versions ?? []).find((candidate) => candidate.id === versionId) ?? null;
    if (res.status === 200 && version !== null && version.parseStatus === wantStatus) return version;
    if (res.status === 200 && version !== null && TERMINAL_PARSE_STATUSES.has(version.parseStatus)) {
      throw new Error(`${fixtureId}: parse ended as ${version.parseStatus} (wanted ${wantStatus}) — ${String(version.parseError)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${fixtureId}: parse did not reach ${wantStatus} in ${String(timeoutMs)}ms (last status: ${JSON.stringify(version?.parseStatus ?? res.status)})`);
    }
    await sleep(150);
  }
}

/** 分页读尽版本块图（浏览器同款读取面 GET …/versions/:versionId）。 */
export async function readAllBlocksViaApi(ctx, treeId, materialId, versionId, fixtureId) {
  const out = [];
  let afterBlock = null;
  for (;;) {
    const query = afterBlock === null ? "" : `?afterBlock=${encodeURIComponent(afterBlock)}`;
    const res = await ctx.api(
      "GET",
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}${query}`,
    );
    if (res.status !== 200) {
      throw new Error(`${fixtureId}: blocks page HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
    }
    for (const entry of res.body?.blocks ?? []) {
      out.push({
        blockId: entry.block.blockId,
        kind: entry.block.kind,
        start: entry.block.start,
        end: entry.block.end,
        ...(entry.block.page !== undefined ? { page: entry.block.page } : {}),
        text: entry.text,
      });
    }
    const next = res.body?.nextAfterBlock ?? null;
    if (next === null) return out;
    afterBlock = next;
  }
}

export async function countMaterialsViaApi(ctx, treeId) {
  const res = await ctx.api("GET", `/api/trees/${encodeURIComponent(treeId)}/materials`);
  if (res.status !== 200) throw new Error(`materials list HTTP ${String(res.status)}: ${JSON.stringify(res.body)}`);
  return (res.body?.materials ?? []).length;
}

/* ---- 确定性超限探针生成器（与 tests/support/verifier/d4-b1-import.ts 同源； */
/* ---- manifest.json sets.b1-import.generatedOversize 的执行配方）。        */

export function utf8BytesOf(text) {
  return new TextEncoder().encode(text);
}

export function latin1BytesOf(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** >20 MiB 的确定性 markdown 探针（文件字节上限；读体/解析前拒绝）。 */
export function buildOversizeFileBytes() {
  const line = "oversize probe: charter D4 section 5 single-file 20 MiB limit (deterministic verify-time generation)\n";
  const target = 20 * 1024 * 1024 + 1;
  const repeats = Math.ceil(target / line.length);
  return utf8BytesOf(line.repeat(repeats).slice(0, target));
}

/** >1,000,000 UTF-16 单元、≤20 MiB 的确定性 markdown 探针（解析后、落库前拒绝）。 */
export function buildOversizeTextUnitsBytes() {
  return utf8BytesOf("字".repeat(1_000_001));
}

/** >200 页的确定性单字体 PDF 探针（页树装载后、内容解释前拒绝）。 */
export function buildOversizePagesPdf(pageCount = 201) {
  const content = "BT /F1 12 Tf 72 700 Td (oversize pages probe) Tj ET";
  const bodies = [];
  bodies.push("<< /Type /Catalog /Pages 2 0 R >>");
  bodies.push("");
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageRefs = [];
  for (let i = 0; i < pageCount; i += 1) {
    const contentNum = bodies.push(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`);
    const pageNum = bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentNum)} 0 R >>`,
    );
    pageRefs.push(`${String(pageNum)} 0 R`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${String(pageRefs.length)} >>`;
  const parts = ["%PDF-1.5\n%\xE2\xE3\xCF\xD3\n"];
  const offsets = [];
  let pos = parts[0].length;
  bodies.forEach((body, i) => {
    offsets.push(pos);
    const chunk = `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    pos += chunk.length;
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  parts.push(xref);
  parts.push(`trailer\n<< /Size ${String(bodies.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`);
  return latin1BytesOf(parts.join(""));
}
