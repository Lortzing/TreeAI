/** fixtures ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  createHash,
} from "node:crypto";
import {
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 冻结集（运行时读取，绝不内嵌副本）                                     */
/* ------------------------------------------------------------------ */

export const B1_MARKDOWN_DIR = ["tests", "fixtures", "d4", "b1-import", "markdown"];


export const B1_ROOT = ["tests", "fixtures", "d4", "b1-import"];


export const B2_SELECTIONS_FILE = ["tests", "fixtures", "d4", "b2-anchors", "markdown-selections.json"];


export const B2_PDF_SELECTIONS_FILE = ["tests", "fixtures", "d4", "b2-anchors", "pdf-selections.json"];


export const B2_INVALID_SELECTIONS_FILE = ["tests", "fixtures", "d4", "b2-anchors", "invalid-selections.json"];

/** 本探针使用的 B1 冻结 fixture（确定性挑选，覆盖中文/emoji/长文懒加载）。 */
export const FIXTURE_IDS = ["md-01", "md-06", "md-11"];

export function loadB1Fixture(root, fixtureId) {
  const dir = join(root, ...B1_MARKDOWN_DIR);
  const bytes = readFileSync(join(dir, `${fixtureId}.md`));
  const truth = JSON.parse(readFileSync(join(dir, `${fixtureId}.expected.json`), "utf8"));
  if (truth.fixtureId !== fixtureId) {
    throw new Error(`fixture truth id mismatch: file says ${String(truth.fixtureId)}, expected ${fixtureId}`);
  }
  return { fixtureId, filename: `${fixtureId}.md`, bytes, truth };
}

export function loadB2Selections(root) {
  const raw = JSON.parse(readFileSync(join(root, ...B2_SELECTIONS_FILE), "utf8"));
  const byId = new Map(raw.items.map((item) => [item.id, item]));
  return byId;
}

/** B2 冻结 PDF 选区（pdf-selections.json；运行时读取，绝不内嵌副本）。 */
export function loadB2PdfSelections(root) {
  const raw = JSON.parse(readFileSync(join(root, ...B2_PDF_SELECTIONS_FILE), "utf8"));
  const byId = new Map(raw.items.map((item) => [item.id, item]));
  return byId;
}

/** B2 冻结负例选区（invalid-selections.json；跨页拒绝镜像的事实源）。 */
export function loadB2InvalidSelections(root) {
  const raw = JSON.parse(readFileSync(join(root, ...B2_INVALID_SELECTIONS_FILE), "utf8"));
  return raw.items;
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
