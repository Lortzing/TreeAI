/**
 * scripts/d4/browser/material-probes.mjs — D4 材料路径浏览器探针
 * （issue #8 §8 验收入口的 B1/B2 浏览器面；D4-2 前端落地后翻绿）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程（selftest 模式为 echo 驱动——离线确定性，永远不是
 * 真实 Pi 证据）。探针沿 owner 2026-09-30 增量验收要求的用户路径：
 *
 *   导入 → 阅读 → 精确选区（含真实连续拖选）→ 来源揭示 → 复制不变
 *   → 重启续读 → B1 全分母（24 ready + 11 负例）→ B5 导出/恢复/找回
 *
 * 冻结真值（绝不在本文件内复制、运行时直接读取冻结文件）：
 *   - tests/fixtures/d4/b1-import/markdown/md-XX.md + md-XX.expected.json
 *     （canonicalText / blocks / textUnits）；
 *   - tests/fixtures/d4/b1-import/md-registry.json / pdf-registry.json
 *     （全分母登记：24 ready + 8 文件负例；3 个超限负例按 manifest 配方
 *     确定性生成——生成器与 tests/support/verifier/d4-b1-import.ts 同源）；
 *   - tests/fixtures/d4/b2-anchors/markdown-selections.json /
 *     pdf-selections.json（选区语义：blockId / 绝对 UTF-16 区间 / 摘录；
 *     B2 浏览器面在真实阅读器里铺满两份冻结分母——45 markdown + 30 PDF）；
 *   - tests/fixtures/d4/b2-anchors/invalid-selections.json（冻结负例；
 *     cross-page 条目是浏览器面跨页拒绝镜像的事实源）；
 *
 * 探针纪律：
 *   - 页面内的操作全部是真实 DOM/输入事件（CDP Input.dispatchMouseEvent
 *     的真实点击、真实鼠标两击选区（click 置 caret → Shift+click 扩展）、
 *     真实连续拖选（mousePressed → mouseMoved×N → mouseReleased）；
 *     DOM Selection + 阅读器自身的
 *     selectionchange/mouseup 武装路径）；绝不在页面里 fetch-shim 应用
 *     自身的行为——导入走真实 HTTP API（D4-1 契约面；导入 UI 属后续
 *     增量），阅读/选区/复制/位置保存全部走 app.js 自己的路径；
 *   - 来源揭示 = 把捕获载荷送回真实后端的 resolve-selection（D4-2 契约
 *     面）复核，selection 必须与冻结真值逐项全等（含 sourceHash ===
 *     SHA-256(冻结 canonicalText)——服务端规范文本与冻结集字节一致的
 *     结构性证明）；
 *   - 截图/JSON sidecar 写入 artifacts 目录（现有约定）；凭据零接触；
 *   - 失败如实：label + 具体 mismatch，绝不吞错。
 */

/** Stable public native browser probe entrypoint. */
export {
  loadB1Fixture,
} from "./material/fixtures.mjs";
export {
  sleep,
  waitFor,
  inputClickAt,
  materialButtonSelector,
} from "./material/input.mjs";
export {
  pageSelectCanonical,
  pageReaderLoadedExpr,
  readCaptureBar,
  waitForArmedBar,
  assertNoPageErrors,
} from "./material/selection.mjs";
export {
  loadB1Registries,
  loadB1RegistryFixture,
} from "./material/fixture-api.mjs";
export {
  switchTreeInUi,
  openMaterialInReader,
  readDomBlocks,
} from "./material/markdown-reader.mjs";
export {
  pdfReaderLoadedExpr,
} from "./material/pdf-reader.mjs";
export {
  importMaterialViaHttp,
  waitForVersionReady,
} from "./material/import-api.mjs";
export {
  probeImportMaterial,
} from "./material/import-probe.mjs";
export {
  probeReadAndSelect,
} from "./material/selection-probe.mjs";
export {
  probeRestartContinue,
} from "./material/restart.mjs";
export {
  probeSearchRecover,
} from "./material/search.mjs";
export {
  probeImportDenominator,
} from "./material/denominator.mjs";
export {
  probeExportRestoreRecover,
} from "./material/restore.mjs";
