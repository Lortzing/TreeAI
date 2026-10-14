/** probe ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  assertNoPageErrors,
} from "../material-probes.mjs";
import {
  runTerminologyCleanBoot,
} from "./clean-boot.mjs";
import {
  closePanel,
  openBranchPanelViaTab,
  panelFollowUp,
  sendTrunkPrompt,
  submitTermReturn,
} from "./conversation.mjs";
import {
  runTerminologyCopyOverlay,
} from "./copy-overlay.mjs";
import {
  closeDrawer,
  modeButtonSelector,
  openDrawer,
} from "./drawer.mjs";
import {
  runTerminologyExplorationRecovery,
} from "./exploration-recovery.mjs";
import {
  readingModeViaApi,
  terminologySessionFiles,
  terminologyViaApi,
  treeStateViaApi,
  trunkViewOf,
} from "./facts.mjs";
import {
  runTerminologyFirstAnswer,
} from "./first-answer.mjs";
import {
  assertHits,
  domClick,
  domDoubleClick,
  pressKey,
  setViewport,
} from "./input.mjs";
import {
  runTerminologyLayout,
} from "./layout.mjs";
import {
  runTerminologyManualExtract,
} from "./manual-extract.mjs";
import {
  DEFAULT_VIEWPORT,
  GATE_NOTE_SNIPPET,
  NARROW_VIEWPORT,
  OVERFLOW_X_TOLERANCE_PX,
  SCROLL_TOLERANCE_PX,
  TERM_MARKERS,
  TRUNK_Q1,
  TRUNK_Q2,
  WIDE_VIEWPORT,
} from "./policy.mjs";
import {
  runTerminologyRangeEntry,
} from "./range-entry.mjs";
import {
  runTerminologyReadingModes,
} from "./reading-modes.mjs";
import {
  runTerminologyRestart,
} from "./restart.mjs";
import {
  asciiWordsOf,
  dragSelectOnTurn,
  pickRange,
  pickTerm,
  trunkTurnSelector,
  TURN_BODY_WALKER,
  turnSelectExpr,
  waitForArmedToolbar,
} from "./selection.mjs";
import {
  runTerminologyTermEntry,
} from "./term-entry.mjs";
import {
  withDroppedResponses,
  withObservedRequests,
} from "./transport.mjs";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 探针：terminology-path                                               */
/* ------------------------------------------------------------------ */

export async function probeTerminologyPath(ctx) {
  const modeNote = ctx.MODE === "selftest"
    ? "echo driver (deterministic answers) — mechanism evidence for the probe/UI code path, NOT real-Pi evidence"
    : "real Pi answers (trunk prompts, terminology explanations, promotion first questions, follow-ups)";
  const answerTimeoutMs = ctx.MODE === "selftest" ? 30_000 : Math.max(60_000, ctx.promptTimeoutMs());
  const dataDir = mkdtempSync(join(tmpdir(), "treeai-term-browser-"));
  const record = {
    readingModes: {},
    entryVertical: { term: {}, range: {} },
    idempotency: {},
    restart: {},
    recovery: {},
    frontendInvariants: {},
  };
  const honestyNotes = [];

  try {
const terminologyCleanBoot = await runTerminologyCleanBoot({
  get ctx() { return ctx; },
  get dataDir() { return dataDir; },
});
const { treeId } = terminologyCleanBoot;

const terminologyReadingModes = await runTerminologyReadingModes({
  get openDrawer() { return openDrawer; },
  get ctx() { return ctx; },
  get GATE_NOTE_SNIPPET() { return GATE_NOTE_SNIPPET; },
  get record() { return record; },
  get withObservedRequests() { return withObservedRequests; },
  get modeButtonSelector() { return modeButtonSelector; },
  get readingModeViaApi() { return readingModeViaApi; },
  get treeId() { return treeId; },
  get closeDrawer() { return closeDrawer; },
});

const terminologyFirstAnswer = await runTerminologyFirstAnswer({
  get sendTrunkPrompt() { return sendTrunkPrompt; },
  get ctx() { return ctx; },
  get treeId() { return treeId; },
  get TRUNK_Q1() { return TRUNK_Q1; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get terminologyViaApi() { return terminologyViaApi; },
  get terminologySessionFiles() { return terminologySessionFiles; },
  get dataDir() { return dataDir; },
  get record() { return record; },
});


    /* ============ 3) ① minimal-hints 下回答后零自动派发（被测语义） ============ */
    let answerText = null;
    let anchorTurnId = null;
const terminologyManualExtract = await runTerminologyManualExtract({
  get openDrawer() { return openDrawer; },
  get ctx() { return ctx; },
  get withObservedRequests() { return withObservedRequests; },
  get modeButtonSelector() { return modeButtonSelector; },
  get closeDrawer() { return closeDrawer; },
  get sendTrunkPrompt() { return sendTrunkPrompt; },
  get treeId() { return treeId; },
  get TRUNK_Q2() { return TRUNK_Q2; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get terminologyViaApi() { return terminologyViaApi; },
  get terminologySessionFiles() { return terminologySessionFiles; },
  get dataDir() { return dataDir; },
  get modeNote() { return modeNote; },
  get answerText() { return answerText; },
  set answerText(value) { answerText = value; },
  get anchorTurnId() { return anchorTurnId; },
  set anchorTurnId(value) { anchorTurnId = value; },
  get record() { return record; },
  get honestyNotes() { return honestyNotes; },
});


    /* ============ 4) ② term 纵向：武装 → 解释卡 → 保存 → 双击推广 → 2 追问 → Return ============ */
    let termPick = null;
    let termBranchId = null;
const terminologyTermEntry = await runTerminologyTermEntry({
  get termPick() { return termPick; },
  set termPick(value) { termPick = value; },
  get pickTerm() { return pickTerm; },
  get answerText() { return answerText; },
  get dragSelectOnTurn() { return dragSelectOnTurn; },
  get ctx() { return ctx; },
  get anchorTurnId() { return anchorTurnId; },
  get waitForArmedToolbar() { return waitForArmedToolbar; },
  get record() { return record; },
  get domClick() { return domClick; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get modeNote() { return modeNote; },
  get trunkTurnSelector() { return trunkTurnSelector; },
  get terminologyViaApi() { return terminologyViaApi; },
  get treeId() { return treeId; },
  get TERM_MARKERS() { return TERM_MARKERS; },
  get domDoubleClick() { return domDoubleClick; },
  get treeStateViaApi() { return treeStateViaApi; },
  get termBranchId() { return termBranchId; },
  set termBranchId(value) { termBranchId = value; },
  get panelFollowUp() { return panelFollowUp; },
  get submitTermReturn() { return submitTermReturn; },
  get trunkViewOf() { return trunkViewOf; },
});


    /* ============ 5) ② range 纵向：武装 → 解释卡 → 保存 → 响应丢失推广 → 恢复 → 2 追问 → Return ============ */
    let rangePick = null;
    let rangeBranchId = null;
const terminologyRangeEntry = await runTerminologyRangeEntry({
  get rangePick() { return rangePick; },
  set rangePick(value) { rangePick = value; },
  get pickRange() { return pickRange; },
  get answerText() { return answerText; },
  get termPick() { return termPick; },
  get dragSelectOnTurn() { return dragSelectOnTurn; },
  get ctx() { return ctx; },
  get anchorTurnId() { return anchorTurnId; },
  get waitForArmedToolbar() { return waitForArmedToolbar; },
  get record() { return record; },
  get domClick() { return domClick; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get asciiWordsOf() { return asciiWordsOf; },
  get modeNote() { return modeNote; },
  get trunkTurnSelector() { return trunkTurnSelector; },
  get terminologyViaApi() { return terminologyViaApi; },
  get treeId() { return treeId; },
  get TERM_MARKERS() { return TERM_MARKERS; },
  get treeStateViaApi() { return treeStateViaApi; },
  get withDroppedResponses() { return withDroppedResponses; },
  get rangeBranchId() { return rangeBranchId; },
  set rangeBranchId(value) { rangeBranchId = value; },
  get panelFollowUp() { return panelFollowUp; },
  get submitTermReturn() { return submitTermReturn; },
  get closePanel() { return closePanel; },
});

const terminologyCopyOverlay = await runTerminologyCopyOverlay({
  get ctx() { return ctx; },
  get TURN_BODY_WALKER() { return TURN_BODY_WALKER; },
  get trunkTurnSelector() { return trunkTurnSelector; },
  get anchorTurnId() { return anchorTurnId; },
  get answerText() { return answerText; },
  get honestyNotes() { return honestyNotes; },
  get record() { return record; },
  get turnSelectExpr() { return turnSelectExpr; },
  get rangePick() { return rangePick; },
  get waitForArmedToolbar() { return waitForArmedToolbar; },
  get domClick() { return domClick; },
  get pressKey() { return pressKey; },
  get SCROLL_TOLERANCE_PX() { return SCROLL_TOLERANCE_PX; },
});

const terminologyLayout = await runTerminologyLayout({
  get setViewport() { return setViewport; },
  get ctx() { return ctx; },
  get WIDE_VIEWPORT() { return WIDE_VIEWPORT; },
  get turnSelectExpr() { return turnSelectExpr; },
  get anchorTurnId() { return anchorTurnId; },
  get rangePick() { return rangePick; },
  get waitForArmedToolbar() { return waitForArmedToolbar; },
  get assertHits() { return assertHits; },
  get domClick() { return domClick; },
  get trunkTurnSelector() { return trunkTurnSelector; },
  get pressKey() { return pressKey; },
  get openDrawer() { return openDrawer; },
  get modeButtonSelector() { return modeButtonSelector; },
  get closeDrawer() { return closeDrawer; },
  get NARROW_VIEWPORT() { return NARROW_VIEWPORT; },
  get OVERFLOW_X_TOLERANCE_PX() { return OVERFLOW_X_TOLERANCE_PX; },
  get record() { return record; },
  get DEFAULT_VIEWPORT() { return DEFAULT_VIEWPORT; },
});


    /* ============ 8) ② SIGTERM 重启 → 新进程 → 批注/支线历史可读 + 继续追问 ============ */
    const oldPort = ctx.studioPort();
const terminologyRestart = await runTerminologyRestart({
  get ctx() { return ctx; },
  get dataDir() { return dataDir; },
  get TERM_MARKERS() { return TERM_MARKERS; },
  get trunkTurnSelector() { return trunkTurnSelector; },
  get anchorTurnId() { return anchorTurnId; },
  get openDrawer() { return openDrawer; },
  get termPick() { return termPick; },
  get closeDrawer() { return closeDrawer; },
  get record() { return record; },
  get openBranchPanelViaTab() { return openBranchPanelViaTab; },
  get termBranchId() { return termBranchId; },
  get panelFollowUp() { return panelFollowUp; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get oldPort() { return oldPort; },
  get closePanel() { return closePanel; },
});

const terminologyExplorationRecovery = await runTerminologyExplorationRecovery({
  get ctx() { return ctx; },
  get turnSelectExpr() { return turnSelectExpr; },
  get anchorTurnId() { return anchorTurnId; },
  get termPick() { return termPick; },
  get domClick() { return domClick; },
  get treeStateViaApi() { return treeStateViaApi; },
  get treeId() { return treeId; },
  get TERM_MARKERS() { return TERM_MARKERS; },
  get record() { return record; },
  get closePanel() { return closePanel; },
  get waitForArmedToolbar() { return waitForArmedToolbar; },
  get termBranchId() { return termBranchId; },
  get rangeBranchId() { return rangeBranchId; },
  get panelFollowUp() { return panelFollowUp; },
  get answerTimeoutMs() { return answerTimeoutMs; },
  get terminologyViaApi() { return terminologyViaApi; },
});


    /* ============ 收尾：纪律 + sidecar ============ */
    const excludedCount = assertNoPageErrors(ctx, {
      exclude: (entry) =>
        entry.text.includes(`http://127.0.0.1:${String(oldPort)}`) ||
        /* 本探针注入的传输层响应丢弃（Fetch.failRequest）——预期的副产物。 */
        (entry.text.includes("promote") && entry.text.includes("ERR_CONNECTION_RESET")),
      label: "terminology-path",
    });
    await ctx.screenshot("terminology-path-final");
    await ctx.sidecar("terminology-path", {
      check: "terminology-path",
      mode: ctx.MODE,
      modeNote,
      treeId,
      terminologyPath: record,
      markers: TERM_MARKERS,
      selections: { term: termPick, range: rangePick },
      branches: { term: termBranchId, range: rangeBranchId },
      environment: {
        node: process.version,
        platform: process.platform,
        dataDirPolicy: "dedicated mkdtemp data dir (bootStudioOn); removed in the probe's finally",
      },
      pageErrorsExcluded: excludedCount,
      honestyNotes: [
        ...honestyNotes,
        "③ exact scroll-position restoration across renderAll is NOT asserted (disclosed): transient content states (card close → content shrink → browser clamp) can enter the branch reading-position memory as a stale value that later renders restore — observed as 401→0 and 220→0 round trips in the full-sequence environment; the deterministically assertable product invariant (no force-to-bottom on re-render while scrolled up, issue #3) IS asserted; the reconcileTopLevel insert-before-remove fix removes the transient content-collapse window; full causal chain (scroll-event delivery timing) left for owner follow-up",
      ],
    });
    return {
      detail:
        `reading modes: 3-way drawer selector switched for real with PUT payloads observed at the transport layer and read back from the server; ` +
        `gate-off honest note present; manual-only AND minimal-hints answers produced ZERO auto dispatch (no tasks/usage/suggestion sets, no strip, ` +
        `zero isolated-executor session files — the production gate-off semantics); term + range entries via real mouse drags armed the toolbar ` +
        `(term/span labels), explain cards landed (${ctx.MODE === "selftest" ? "echo — NOT real-Pi evidence" : "real Pi, non-empty and containing the source word"}), ` +
        `annotations saved with live overlays; term promotion via double-click dispatched exactly once, range promotion survived a dropped response ` +
        `honestly (refresh reveals the promotion → resume, exactly 1 first-question user turn, +1 branch); ≥2 follow-ups per branch; Returns landed ` +
        `on the Trunk with the terminology source cards (excerpt + saved time + from-branch); SIGTERM restart → new process → annotations/overlays/` +
        `histories readable + continuation follow-up landed; existing exploration resumed (branch count unchanged) and the generic branch entry ` +
        `opened a separate exploration with the promotion binding unchanged; frontend invariants: whole-answer copy byte-equal via ${record.frontendInvariants.copyInvariance?.mode ?? "copy"}, ` +
        `armed selection stable across a real renderAll (node identities kept), draft+focus round trip, reading-position no-force-to-bottom on re-render, Esc focus restore, wide 1600 / narrow 390 hit-tested`,
    };
  } finally {
    /* 还原缺省视口 + 切断页面轮询 + 停进程 + 清理专用数据目录（探针纪律）。 */
    try {
      await setViewport(ctx, DEFAULT_VIEWPORT);
    } catch { /* 尽力而为 */ }
    try {
      await ctx.navigate("about:blank");
    } catch { /* 尽力而为 */ }
    try {
      await ctx.stopStudio();
    } catch { /* 尽力而为 */ }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch { /* 尽力而为 */ }
  }
}
