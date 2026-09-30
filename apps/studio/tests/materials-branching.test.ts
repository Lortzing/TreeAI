/**
 * D4-3 材料建枝闭环测试（issue #8 charter §3.3 / ADR-003 §4/§5 / ADR-004；
 * 离线 echo 驱动、真实服务栈、临时数据目录）。
 *
 * 覆盖（服务层为主，HTTP 面见最后一个 test；ADR-004 §9 测试义务全量）：
 * - 建枝（零 Run/Turn）：Branch + 材料来源 + (tree, intent_key) 绑定原子
 *   落库；同键重放同枝零新行；同键不同选区 → 409 语义；组合上下文视图
 *   确定性（建枝响应与首问派发的 composedPrefix 逐字节相同）；
 * - 文字层 PDF 建枝（真实 d4-pdf-v1 管线 + B1 冻结 fixture pdf-01）；
 * - 上下文边界（ADR-003 §4 的 24,000 上限）：大材料窗口截断标记如实
 *   （truncated + truncationNote + composedUnits ≤ 上限）；选区超
 *   20,000 直接拒绝（零派发零建枝）；
 * - 首问：独立 session（≠库内任何其他 run 的 session）、可审计前缀
 *   （只含 versionId）、组合上下文进入模型输入（echo 断言）；幂等重放
 *   （不重复建枝/派发）；进程重启后重放确定性；同分支首问异问 → 409；
 * - 对账纪律（先对账后行动）：非终态 Run → dispatch "unknown" 不盲发；
 *   全终态无落库 turn → 可重派发（失败重试是显式新尝试）；
 * - 恢复/另开：同来源恢复既有 Branch；显式另开新 Branch；同摘录不同
 *   材料/不同版本不误复用；跨树隔离（讨论/Return 按 Tree）；
 * - 材料 Return：落所属 Tree 主线、targetAnchor null（不伪造主线锚点）、
 *   来源卡（标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump）、幂等
 *   重放、主干 prompt 后采用尝试记录；
 * - 缺 session：普通续聊 fail-closed；显式新探索成功且材料上下文随行；
 *   session 可用时新探索 409（前置条件）；
 * - 非 ready 版本建枝拒绝（MaterialNotReadyError，不伪装成功）；
 * - HTTP 面（真实 node:http + fetch）：from-material（201/200/409/恢复/
 *   另开/400/405）、material-first-question、material-return、
 *   material-new-exploration、未装配 503。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaterialId, MaterialSelection, MaterialVersionId, PiRuntime, SessionReference, TreeId } from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError } from "@treeai/persistence";
import { classifyPiFailure, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { NewExplorationConflictError, type TreeStudioService } from "../src/service.ts";
import { EchoSdkPort, ECHO_FAILURE_MESSAGE } from "../src/echo-port.ts";
import { MaterialImportService } from "../src/materials/import-service.ts";
import { MaterialRangeResolver } from "../src/materials/range-resolver.ts";
import {
  MATERIAL_CONTEXT_LIMIT_UNITS,
  MATERIAL_MAX_SELECTION_UNITS,
  MaterialBranchConflictError,
  MaterialBranchingService,
  MaterialFirstQuestionConflictError,
  materialExplorationTurnPrefix,
} from "../src/materials/branching.ts";
import { createStudioServer } from "../src/server.ts";
import {
  cleanupDir,
  makeStudioInstance,
  makeTempDataDir,
  STUDIO_MODEL,
  type StudioInstance,
} from "./helpers.ts";

const ENCODER = new TextEncoder();
const staticDir = fileURLToPath(new URL("../public/", import.meta.url));
const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function b1Bytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(`${B1_ROOT}${rel}`));
}

/** B1 冻结真值（pdf-01：2 页中文笔记）。 */
const PDF_01 = JSON.parse(readFileSync(`${B1_ROOT}pdf/pdf-01.expected.json`, "utf8")) as {
  canonicalText: string;
  blocks: readonly { blockId: string; start: number; end: number; page: number; text: string }[];
};

/** 轮询等待条件成立（解析任务是微任务/近即时，留足余量）。 */
async function until(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** 对账测试用的最小合法 SessionReference（进程死亡模拟：runs 悬置非终态）。 */
function fakeSessionReference(): SessionReference {
  return {
    sessionId: "session_b3_fake" as SessionReference["sessionId"],
    sessionFile: "b3-fake-session.jsonl",
    entryId: "entry_b3_fake" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  };
}

/** 装配材料建枝服务（与 server.ts 同一装配纪律）。 */
function makeBranching(studio: StudioInstance): MaterialBranchingService {
  return new MaterialBranchingService({
    treeRepository: studio.repository,
    materialRepository: studio.materialRepository,
    studio: studio.service,
  });
}

interface ReadyMaterial {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly canonicalText: string;
}

/** 导入 markdown 并等到 ready（确定性文本在调用方构造）。 */
async function importReadyMarkdown(
  studio: StudioInstance,
  treeId: TreeId,
  filename: string,
  text: string,
): Promise<ReadyMaterial> {
  const result = await studio.materials.importMaterial(treeId, { filename, bytes: utf8(text) });
  await until(
    () => studio.materials.getMaterialDetail(treeId, result.material.id).versions[0]!.parseStatus === "ready",
    "the markdown version to become ready",
  );
  const content = studio.materialRepository.getVersionContent(result.version.id);
  return {
    treeId,
    materialId: result.material.id,
    versionId: result.version.id,
    canonicalText: content.canonicalText,
  };
}

/** 经真实区间解析层取规范选区（text-occurrence 定位）。 */
function resolveOccurrence(
  studio: StudioInstance,
  material: ReadyMaterial,
  needle: string,
  occurrence = 1,
): MaterialSelection {
  const resolver = new MaterialRangeResolver({ repository: studio.materialRepository });
  const resolution = resolver.resolve({
    materialId: material.materialId,
    versionId: material.versionId,
    locator: { kind: "text-occurrence", needle, occurrence },
  });
  if (!resolution.ok) {
    assert.fail(`selection resolution failed: ${resolution.rejection.code} — ${resolution.rejection.message}`);
  }
  return resolution.result.selection;
}

/* 三块 markdown：blk-0 Alpha / blk-1 Beta（含中英混排）/ blk-2 Gamma。 */
const THREE_BLOCKS = "Alpha 开篇 baseline。\n\nBeta context block 中英混排。\n\nGamma 收尾 tail。";

test("material branching: creation lands branch/origin/binding with zero runs/turns; the context view is deterministic and byte-identical at dispatch time (charter §3.3 rule 1/3, ADR-004 §4)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const material = await importReadyMarkdown(studio, tree.id, "notes.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const branching = makeBranching(studio);

    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "intent-a" });
    assert.equal(creation.created, true);
    assert.equal(creation.branch.parentBranchId, studio.service.getTreeState(tree.id).trunkBranchId);
    assert.equal(creation.branch.treeId, tree.id);
    assert.deepEqual(creation.origin.selection, selection);
    assert.equal(creation.origin.treeId, tree.id);

    /* 浏览/建枝不创建 Turn：零 Run、零 Turn（首问是独立显式提交）。 */
    const view = studio.service.getTreeState(tree.id).branches.find((v) => v.branch.id === creation.branch.id)!;
    assert.equal(view.turns.length, 0, "branching creates zero turns");
    assert.equal(studio.repository.listEpisodes(creation.branch.id).length, 0, "branching creates zero episodes");

    /* 组合上下文视图：材料范围声明（窗口/块/上限/截断标记/组合文本）。 */
    const context = creation.context;
    assert.equal(context.composedUnits, context.composed.length);
    assert.ok(context.composedUnits <= MATERIAL_CONTEXT_LIMIT_UNITS);
    assert.equal(context.truncated, false, "the three-block material fits without truncation");
    assert.equal(context.truncationNote, null);
    assert.ok(context.composed.includes("Beta context block"), "the selected excerpt enters the composed context");
    assert.ok(context.composed.includes("Alpha 开篇"), "the neighboring block enters the window");
    assert.ok(context.composed.includes("Gamma 收尾"), "the other neighboring block enters the window");
    assert.ok(
      context.contextBlocks.some((block) => block.blockId === selection.blockId),
      "the selection's block is inside the declared window",
    );

    /* 同键重放：同枝零新行；context 逐字节相同（确定性——与派发时相同）。 */
    const replay = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "intent-a" });
    assert.equal(replay.created, false);
    assert.equal(replay.branch.id, creation.branch.id);
    assert.equal(replay.context.composed, creation.context.composed, "the composed context is deterministic");

    /* 同键不同选区 → 409 语义（一次逻辑提交不得静默换源）。 */
    const other = resolveOccurrence(studio, material, "Gamma 收尾");
    assert.throws(
      () => branching.createMaterialBranch({ treeId: tree.id, selection: other, intentKey: "intent-a" }),
      MaterialBranchConflictError,
    );

    /* 换键同选区 = 显式另开的新提交（新 Branch，同一来源）。 */
    const secondKey = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "intent-b" });
    assert.equal(secondKey.created, true);
    assert.notEqual(secondKey.branch.id, creation.branch.id);

    /* 未知树 / 未链接材料 → 404 语义；空 intentKey → 400 语义。 */
    assert.throws(
      () => branching.createMaterialBranch({ treeId: "tree_missing" as TreeId, selection, intentKey: "k" }),
      EntityNotFoundError,
    );
    assert.throws(
      () => branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "  " }),
      InvalidArgumentError,
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("material branching: a text-layer PDF selection branches through the real d4-pdf-v1 pipeline with page-bearing blocks (B1 pdf-01)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const imported = await studio.materials.importMaterial(tree.id, {
      filename: "pdf-01.pdf",
      bytes: b1Bytes("pdf/pdf-01.pdf"),
    });
    await until(
      () => studio.materials.getMaterialDetail(tree.id, imported.material.id).versions[0]!.parseStatus === "ready",
      "the pdf version to become ready",
    );
    const resolver = new MaterialRangeResolver({ repository: studio.materialRepository });
    /* 第 2 页的中文片段（冻结真值：page-1 块内）。 */
    const target = PDF_01.blocks.find((block) => block.page === 2)!;
    const needle = target.text.slice(Math.floor(target.text.length / 2), Math.floor(target.text.length / 2) + 6);
    const resolution = resolver.resolve({
      materialId: imported.material.id,
      versionId: imported.version.id,
      locator: { kind: "text-occurrence", needle, occurrence: 1 },
    });
    assert.ok(resolution.ok, `pdf selection must resolve: ${resolution.ok ? "" : resolution.rejection.code}`);
    const branching = makeBranching(studio);
    const creation = branching.createMaterialBranch({
      treeId: tree.id,
      selection: resolution.result.selection,
      intentKey: "pdf-intent-1",
    });
    assert.equal(creation.created, true);
    assert.equal(creation.origin.selection.blockId, "page-2");
    /* page 元信息经版本块图进入建枝面（Return 卡的页展示来源）。 */
    const content = studio.materialRepository.getVersionContent(imported.version.id);
    const block = content.blocks.find((entry) => entry.blockId === creation.origin.selection.blockId)!;
    assert.equal(block.page, 2);

    /* PDF 材料的首问照常派发（echo 驱动），来源卡携带页码。 */
    const dispatch = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "pdf-intent-1",
      firstQuestion: "这一页在讲什么？",
    });
    assert.equal(dispatch.dispatch, "succeeded");
    const ret = await branching.submitMaterialReturn({
      treeId: tree.id,
      fromBranchId: creation.branch.id,
      text: "收获：第二页主题确认。",
      idempotencyKey: "pdf-ret-1",
    });
    assert.equal(ret.card.page, 2, "the return card carries the pdf page number");
    assert.equal(ret.card.parserKind, "pdf");
    assert.equal(ret.card.parserVersion, "d4-pdf-v1");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("material context bounds: a large material truncates the window honestly; an oversized selection is refused with zero dispatch (ADR-003 §4 / ADR-004 §7)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    /* 确定性大材料：61 块 × ~1000 单元 ≈ 61,000 单元（> 24,000 上限）。 */
    const paragraphs: string[] = [];
    for (let index = 0; index < 61; index += 1) {
      paragraphs.push(`Block ${String(index).padStart(2, "0")}: ${"探索段落内容。".repeat(160)}`);
    }
    const bigText = paragraphs.join("\n\n");
    const material = await importReadyMarkdown(studio, tree.id, "big.md", bigText);
    const selection = resolveOccurrence(studio, material, "Block 30:");
    const branching = makeBranching(studio);

    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "big-1" });
    const context = creation.context;
    assert.equal(context.truncated, true, "the window cannot cover the whole material");
    assert.ok(context.truncationNote !== null, "an explicit truncation marker is embedded");
    assert.ok(
      context.truncationNote.includes("Context truncated"),
      "the marker states the truncation honestly",
    );
    assert.ok(context.composedUnits <= MATERIAL_CONTEXT_LIMIT_UNITS, "the composed text stays within the frozen cap");
    assert.ok(
      context.composed.includes(selection.excerpt),
      "the user's own selection always enters the composed context in full",
    );
    /* 截断标记进入组合文本（UI 预览与模型输入同一份）。 */
    assert.ok(context.composed.includes("[Context truncated:"), "the marker is part of the composed text");
    /* 窗口有界：远端块不得进入。 */
    assert.ok(!context.composed.includes("Block 00:"), "the window excludes distant head blocks");
    assert.ok(!context.composed.includes("Block 60:"), "the window excludes distant tail blocks");
    assert.ok(context.composed.includes("Block 30:"), "the containing block is in the window");

    /* 选区超限：直接拒绝（零派发零建枝——截断用户选区是不诚实的锚定）。 */
    const singleHugeBlock = `超限选区材料。${"长".repeat(MATERIAL_MAX_SELECTION_UNITS + 500)}`;
    const hugeMaterial = await importReadyMarkdown(studio, tree.id, "huge-selection.md", singleHugeBlock);
    const hugeResolver = new MaterialRangeResolver({ repository: studio.materialRepository });
    const hugeResolution = hugeResolver.resolve({
      materialId: hugeMaterial.materialId,
      versionId: hugeMaterial.versionId,
      locator: { kind: "utf16-range", start: 0, end: MATERIAL_MAX_SELECTION_UNITS + 100 },
    });
    assert.ok(hugeResolution.ok, "the oversized range itself is a valid utf16 range");
    const before = studio.repository.listBranches(tree.id).length;
    assert.throws(
      () =>
        branching.createMaterialBranch({
          treeId: tree.id,
          selection: hugeResolution.result.selection,
          intentKey: "huge-1",
        }),
      InvalidArgumentError,
    );
    assert.equal(studio.repository.listBranches(tree.id).length, before, "the refusal creates zero branches");
    assert.equal(studio.materialRepository.findFirstQuestion(tree.id, "huge-1"), null, "zero intent binding");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("material first question: independent session, audited versionId prefix, composed context enters the model input; replay and post-restart replay are deterministic (ADR-004 §2/§4/§5)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const material = await importReadyMarkdown(studio, tree.id, "loop.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const branching = makeBranching(studio);
    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "fq-1" });

    /* 独立 session（ADR-003 §5.4）：先在 Trunk 上制造一次真实运行。 */
    const trunkPrompt = await studio.service.prompt(tree.id, studio.service.getTreeState(tree.id).trunkBranchId!, "trunk 主线提问");
    const dispatch = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "fq-1",
      firstQuestion: "Beta 上下文在讲什么？",
    });
    assert.equal(dispatch.dispatch, "succeeded");
    assert.ok(dispatch.outcome !== null);
    assert.notEqual(
      dispatch.outcome.run.session.sessionId,
      trunkPrompt.run.session.sessionId,
      "the material branch's first run starts on an independent session",
    );

    /* 可审计前缀（只含 versionId——标题可编辑，不是身份）+ 问题原文。 */
    const prefix = materialExplorationTurnPrefix(creation.origin);
    assert.equal(prefix, `[exploration from material ${material.versionId}]`);
    assert.equal(dispatch.outcome.userTurn.text, `${prefix}\n\nBeta 上下文在讲什么？`);
    assert.ok(dispatch.outcome.userTurn.text.includes(material.versionId));
    assert.ok(!dispatch.outcome.userTurn.text.includes("loop.md"), "the editable title never enters the turn prefix");

    /* 组合上下文进入模型输入（echo 回答 = 该 session 上全部 user 文本）。 */
    assert.ok(
      dispatch.outcome.assistantTurn.text.includes("[Exploration context from material"),
      "the composed material context entered the model input",
    );
    assert.ok(dispatch.outcome.assistantTurn.text.includes("Alpha 开篇"), "the neighboring window entered the model input");
    /* 首个用户 Turn 之前不存在任何伪造历史 Turn（首问是该 session 的第一条）。 */
    const branchTurns = studio.repository.listTurns(creation.branch.id);
    assert.equal(branchTurns[0]!.id, dispatch.outcome.userTurn.id, "the first question is the branch's first turn");

    /* 幂等重放：同键同问 → succeeded、不重发、不重建枝。 */
    const replay = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "fq-1",
      firstQuestion: "Beta 上下文在讲什么？",
    });
    assert.equal(replay.dispatch, "succeeded");
    assert.equal(replay.outcome, null, "a replay never re-sends");
    assert.equal(replay.landed!.userTurnId, dispatch.landed!.userTurnId, "the landed first question is the same turn");
    assert.equal(replay.landed!.assistantTurnId, dispatch.landed!.assistantTurnId);
    assert.equal(studio.repository.listTurns(creation.branch.id).length, 2, "replay adds zero turns");
    assert.equal(studio.repository.listBranches(tree.id).length, 2, "replay adds zero branches (trunk + material)");

    /* 同分支首问异问 → 409（首问不可变；改问走普通续聊）。 */
    await assert.rejects(
      () => branching.firstQuestion({ treeId: tree.id, intentKey: "fq-1", firstQuestion: "换一个问题" }),
      MaterialFirstQuestionConflictError,
    );

    /* 未注册的键 → 400（先建枝再首问）。 */
    await assert.rejects(
      () => branching.firstQuestion({ treeId: tree.id, intentKey: "nope", firstQuestion: "问题" }),
      InvalidArgumentError,
    );

    /* 进程重启后重放确定性（同一目录重建实例 = 模拟重启）。 */
    const sessionFileCountBefore = readdirSync(join(dir, "sessions")).length;
    await studio.shutdown();
    const studio2 = makeStudioInstance(dir);
    const branching2 = makeBranching(studio2);
    const replay2 = await branching2.firstQuestion({
      treeId: tree.id,
      intentKey: "fq-1",
      firstQuestion: "Beta 上下文在讲什么？",
    });
    assert.equal(replay2.dispatch, "succeeded", "post-restart replay reconciles from the landed turn");
    assert.equal(replay2.outcome, null);
    assert.equal(replay2.landed!.userTurnId, dispatch.landed!.userTurnId);
    assert.equal(replay2.landed!.runId, dispatch.landed!.runId);
    assert.equal(
      studio2.repository.listBranches(tree.id).length,
      2,
      "restart replay creates no duplicate branches",
    );
    assert.equal(
      readdirSync(join(dir, "sessions")).length,
      sessionFileCountBefore,
      "restart replay creates no new sessions",
    );
    await studio2.shutdown();
  } finally {
    await studio.shutdown().catch(() => {});
    cleanupDir(dir);
  }
});

test("material first question reconciliation: a non-terminal run blocks re-dispatch (unknown, no blind send); an explicit failure allows the retry (ADR-004 §5 rules 3/4)", async () => {
  const dir = makeTempDataDir();
  /* 哨兵运行时：真实 echo 栈外包一层代理（service.test.ts 同款），命中文
     本以真实 /fail 同款的上游错误拒绝——用于确定性制造「明确失败的派发」。 */
  const FAILURE_SENTINEL = "TRIGGER-B3-UPSTREAM-FAILURE";
  const echoRuntime = createPiRuntimeFromConfig({
    port: new EchoSdkPort(),
    defaultCwd: join(dir, "workspace"),
  });
  const runtime: PiRuntime = {
    get piVersion() {
      return echoRuntime.piVersion;
    },
    createSession: (init) => echoRuntime.createSession(init),
    restoreSession: (reference) => echoRuntime.restoreSession(reference),
    prompt: (input) =>
      input.text.includes(FAILURE_SENTINEL)
        ? Promise.reject(classifyPiFailure(new Error(ECHO_FAILURE_MESSAGE), "Pi run failed"))
        : echoRuntime.prompt(input),
    steer: (input) => echoRuntime.steer(input),
    abort: () => echoRuntime.abort(),
    navigateTree: (target) => echoRuntime.navigateTree(target),
    subscribe: (listener) => echoRuntime.subscribe(listener),
    dispose: () => echoRuntime.dispose(),
  };
  const studio = makeStudioInstance(dir, { runtime });
  try {
    const { tree } = studio.service.createTree();
    const material = await importReadyMarkdown(studio, tree.id, "recon.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const branching = makeBranching(studio);
    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "recon-1" });

    /* 场景一（进程在派发中退出）：episode + run 悬置非终态（queued），
       无落库 turn → 先对账后行动：结果未知，不盲发。 */
    const episode = studio.repository.createEpisode(creation.branch.id);
    studio.repository.createRun(episode.id, fakeSessionReference());
    const blocked = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-1",
      firstQuestion: "悬置后的问题",
    });
    assert.equal(blocked.dispatch, "unknown", "an in-flight (non-terminal) run makes the outcome unknown");
    assert.equal(blocked.outcome, null, "the first question is NOT re-sent");
    assert.equal(blocked.error!.code, "dispatch-unknown");
    assert.equal(studio.repository.listTurns(creation.branch.id).length, 0, "zero turns were landed");

    /* 对账不决期间换问题内容：本分支尚无落库首问——阻断（unknown）而非 409
       （409 只对「已落库的异问」生效）。 */
    const blockedAgain = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-1",
      firstQuestion: "另一个问题",
    });
    assert.equal(blockedAgain.dispatch, "unknown");

    /* 宿主把悬置 run 收敛为明确失败（failNonTerminalRuns 同纪律）。 */
    const [hungRun] = studio.repository.listRuns(episode.id);
    studio.repository.updateRunState(hungRun!.id, "failed", {
      failure: { code: "unknown", message: "swept by the test to unblock reconciliation" },
    });

    /* 场景二（明确失败的派发）：另开一枝，首问带哨兵 → 真实失败收敛。 */
    const second = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "recon-2" });
    const failed = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-2",
      firstQuestion: `${FAILURE_SENTINEL} 会失败的首问`,
    });
    assert.equal(failed.dispatch, "failed", "an explicit upstream failure reports dispatch 'failed'");
    assert.equal(failed.outcome, null);
    assert.equal(failed.error!.code, "upstream");
    assert.equal(studio.repository.listTurns(second.branch.id).length, 0, "the failed dispatch landed zero turns");
    const failedRun = studio.repository.listRuns(studio.repository.listEpisodes(second.branch.id)[0]!.id)[0]!;
    assert.equal(failedRun.state, "failed");

    /* 失败重试是显式允许的新尝试：同键同问重发 → 成功派发。 */
    const retried = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-2",
      firstQuestion: `${FAILURE_SENTINEL} 会失败的首问`,
    });
    assert.equal(retried.dispatch, "failed", "the retry carries the same sentinel and fails the same honest way");

    const clean = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-2",
      firstQuestion: "去掉哨兵后的重试",
    });
    /* 首问内容已变且尚无落库 turn——仍属「从未送达」，重派发允许。 */
    assert.equal(clean.dispatch, "succeeded", "a changed first question re-dispatches while nothing has landed");
    assert.ok(clean.outcome !== null);

    /* 落库后回到幂等路径（landed turn 对账优先于一切推断）。 */
    const settled = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "recon-2",
      firstQuestion: "去掉哨兵后的重试",
    });
    assert.equal(settled.dispatch, "succeeded");
    assert.equal(settled.outcome, null);
    assert.equal(settled.landed!.userTurnId, clean.landed!.userTurnId);
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("restore-or-open: same source restores the existing branch, explicit new opens a second one; look-alike selections in other materials/versions are never reused; cross-tree isolation holds (charter §3.3 rule 5/6)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const treeA = studio.service.createTree().tree;
    const treeB = studio.service.createTree().tree;
    const material = await importReadyMarkdown(studio, treeA.id, "shared.md", THREE_BLOCKS);
    /* 同一材料显式链接到第二棵树（tree_material_links——材料身份是全局的，
       导入去重才是树作用域；一材料多树 = 显式链接）。 */
    studio.materialRepository.linkTreeMaterial(treeB.id, material.materialId);
    /* 改版材料（同材料新版本）与同摘录的另一份材料。 */
    const revised = await studio.materials.addMaterialVersion(treeA.id, material.materialId, {
      filename: "shared.md",
      bytes: utf8("Alpha 开篇 baseline。\n\nBeta context block 改版后。\n\nGamma 收尾 tail。"),
    });
    await until(
      () =>
        studio.materials
          .getMaterialDetail(treeA.id, material.materialId)
          .versions.some((v) => v.id === revised.version.id && v.parseStatus === "ready"),
      "the revised version to become ready",
    );
    const twin = await studio.materials.importMaterial(treeA.id, {
      filename: "twin.md",
      bytes: utf8("另一份材料。\n\nBeta context block 中英混排。\n\n完全不同的首尾。"),
    });
    await until(
      () => studio.materials.getMaterialDetail(treeA.id, twin.material.id).versions[0]!.parseStatus === "ready",
      "the twin material to become ready",
    );

    const branching = makeBranching(studio);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const created = branching.createMaterialBranch({ treeId: treeA.id, selection, intentKey: "src-1" });
    await branching.firstQuestion({ treeId: treeA.id, intentKey: "src-1", firstQuestion: "首问 src-1" });

    /* 同来源恢复：返回既有 Branch（不新建、不重注入）。 */
    const restored = await branching.restoreOrOpen({ treeId: treeA.id, selection, mode: "restore" });
    assert.equal(restored.mode, "restored");
    assert.equal(restored.branch.id, created.branch.id);
    assert.equal(restored.created, false);
    assert.equal(restored.navigation!.status, "navigated", "the session is alive and the cursor aligns");
    assert.equal(restored.sessionAvailability, "available");

    /* 显式另开：新 Branch + 新 session（同一来源的第二条探索）。 */
    const reopened = await branching.restoreOrOpen({
      treeId: treeA.id,
      selection,
      mode: "new",
      intentKey: "src-2",
    });
    assert.equal(reopened.mode, "created");
    assert.notEqual(reopened.branch.id, created.branch.id);

    /* 同摘录文本、不同版本 → 不是同一来源（选区身份含 versionId）。 */
    const resolver = new MaterialRangeResolver({ repository: studio.materialRepository });
    const revisedResolution = resolver.resolve({
      materialId: material.materialId,
      versionId: revised.version.id,
      locator: { kind: "text-occurrence", needle: "Beta context block", occurrence: 1 },
    });
    assert.ok(revisedResolution.ok);
    await assert.rejects(
      () =>
        branching.restoreOrOpen({
          treeId: treeA.id,
          selection: revisedResolution.result.selection,
          mode: "restore",
        }),
      EntityNotFoundError,
      "a different version is a different source even with the same excerpt text",
    );

    /* 同摘录文本、不同材料 → 不是同一来源。 */
    const twinMaterial: ReadyMaterial = {
      treeId: treeA.id,
      materialId: twin.material.id,
      versionId: twin.version.id,
      canonicalText: "",
    };
    const twinSelection = resolveOccurrence(studio, twinMaterial, "Beta context block");
    assert.equal(twinSelection.excerpt, selection.excerpt, "the twin material carries the same excerpt text");
    await assert.rejects(
      () => branching.restoreOrOpen({ treeId: treeA.id, selection: twinSelection, mode: "restore" }),
      EntityNotFoundError,
      "a different material is a different source even with the same excerpt text",
    );

    /* 跨树隔离：材料已链接树 B，但树 B 无该来源的探索（恢复 404）——
       树 A 的探索不外溢。 */
    await assert.rejects(
      () => branching.restoreOrOpen({ treeId: treeB.id, selection, mode: "restore" }),
      EntityNotFoundError,
      "explorations are scoped to their tree",
    );
    /* 树 B 上从同一选区新建属于树 B（讨论/运行按 Tree 隔离）。 */
    const treeBCreation = branching.createMaterialBranch({ treeId: treeB.id, selection, intentKey: "src-tree-b" });
    assert.equal(treeBCreation.branch.treeId, treeB.id);
    assert.notEqual(treeBCreation.branch.id, created.branch.id);
    const treeBDispatch = await branching.firstQuestion({
      treeId: treeB.id,
      intentKey: "src-tree-b",
      firstQuestion: "树 B 的首问",
    });
    assert.equal(treeBDispatch.dispatch, "succeeded");
    /* 树 B 恢复只找到树 B 的探索；树 A 的分支数不含树 B 的。 */
    const treeBRestored = await branching.restoreOrOpen({ treeId: treeB.id, selection, mode: "restore" });
    assert.equal(treeBRestored.branch.id, treeBCreation.branch.id);
    assert.equal(
      studio.repository.listBranches(treeA.id).length,
      3,
      "tree A keeps trunk + 2 material branches (src-1, src-2)",
    );
    assert.equal(
      studio.repository.listBranches(treeB.id).length,
      2,
      "tree B has trunk + its own material branch",
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("material return: lands on the owning tree's trunk with targetAnchor null, a full material source card, idempotent replay, and adoption attempts recorded after the trunk prompt (charter §3.3 rule 7, ADR-004 §8)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const material = await importReadyMarkdown(studio, tree.id, "ret.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const branching = makeBranching(studio);
    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "ret-1" });
    await branching.firstQuestion({ treeId: tree.id, intentKey: "ret-1", firstQuestion: "ret 首问" });

    const trunkId = studio.service.getTreeState(tree.id).trunkBranchId!;
    const submission = await branching.submitMaterialReturn({
      treeId: tree.id,
      fromBranchId: creation.branch.id,
      text: "收获：Beta 是窗口的中心块。",
      idempotencyKey: "ret-key-1",
    });
    assert.equal(submission.created, true);
    /* 落所属 Tree 主线（Trunk 的 return turn）。 */
    assert.equal(submission.returnTurn.branchId, trunkId);
    assert.equal(submission.returnTurn.role, "return");
    assert.equal(submission.returnTurn.fromBranchId, creation.branch.id);
    /* targetAnchor 恒 null——材料来源没有主线对话锚点，绝不伪造。 */
    assert.equal(submission.returnTurn.targetAnchor, null);
    /* 保存先于导航：Trunk 尚无 session → no-session（Return 已保存）。 */
    assert.equal(submission.navigation.status, "no-session");

    /* 来源卡：从不可变材料来源 + return turn 派生。 */
    const card = submission.card;
    assert.equal(card.materialId, material.materialId);
    assert.equal(card.versionId, material.versionId);
    assert.equal(card.blockId, selection.blockId);
    assert.equal(card.excerpt, selection.excerpt);
    assert.deepEqual(card.sourceJump, {
      materialId: selection.materialId,
      versionId: selection.versionId,
      blockId: selection.blockId,
      start: selection.start,
      end: selection.end,
      sourceHash: selection.sourceHash,
    });
    assert.equal(card.confirmTime, submission.returnTurn.createdAt);
    assert.deepEqual(card.adoption, { attempts: 0, deliveredRunId: null, status: "saved" });

    /* 幂等重放：同键同内容 → 同一 return turn，零新写入。 */
    const replay = await branching.submitMaterialReturn({
      treeId: tree.id,
      fromBranchId: creation.branch.id,
      text: "收获：Beta 是窗口的中心块。",
      idempotencyKey: "ret-key-1",
    });
    assert.equal(replay.created, false);
    assert.equal(replay.returnTurn.id, submission.returnTurn.id);

    /* 主干 prompt 组装 pending Return → 采用尝试记录 + 首次成功采用。 */
    await studio.service.prompt(tree.id, trunkId, "主线消化这份收获");
    const attempts = studio.repository.listReturnAdoptionAttempts(submission.returnTurn.id);
    assert.equal(attempts.length, 1, "the trunk prompt records one adoption attempt");
    const delivered = studio.repository.listTurns(trunkId).find((t) => t.id === submission.returnTurn.id)!;
    assert.equal(delivered.deliveredRunId, attempts[0]!.runId, "the first successful adoption is recorded");

    /* 非 Turn 来源/非材料分支 → 400（材料 Return 只服务材料分支）。 */
    await assert.rejects(
      () =>
        branching.submitMaterialReturn({
          treeId: tree.id,
          fromBranchId: trunkId,
          text: "x",
          idempotencyKey: "ret-key-2",
        }),
      InvalidArgumentError,
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("missing session: normal continuation fails closed; explicit new material exploration succeeds with the material context carried; an available session refuses the new exploration (W1 §3.4 + ADR-004 §3c)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const material = await importReadyMarkdown(studio, tree.id, "lost.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const branching = makeBranching(studio);
    const creation = branching.createMaterialBranch({ treeId: tree.id, selection, intentKey: "lost-1" });
    const first = await branching.firstQuestion({
      treeId: tree.id,
      intentKey: "lost-1",
      firstQuestion: "丢失前的首问",
    });
    assert.equal(first.dispatch, "succeeded");

    /* session 可用时：显式新探索拒绝（应走普通续聊），零写入。 */
    await assert.rejects(
      () => branching.promptNewMaterialExploration(tree.id, creation.branch.id, "提前换轨"),
      NewExplorationConflictError,
    );

    /* 模拟 session 丢失（删除 session 文件后重启实例）。 */
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.ok(sessionFiles.length >= 1);
    await studio.shutdown();
    for (const file of sessionFiles) rmSync(join(sessionsDir, file));
    const studio2 = makeStudioInstance(dir);
    const branching2 = makeBranching(studio2);

    /* fail-closed：普通续聊拒绝（绝不静默重建 session）。 */
    await assert.rejects(
      () => studio2.service.prompt(tree.id, creation.branch.id, "普通续聊必须拒绝"),
      (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "session-corrupt",
    );

    /* 显式新探索：成功，且材料上下文随行进入新 session 的模型输入。 */
    const outcome = await branching2.promptNewMaterialExploration(tree.id, creation.branch.id, "换轨后的新问题");
    assert.equal(outcome.run.state, "succeeded");
    assert.ok(outcome.userTurn.text.includes("[new exploration from saved content"), "the audited new-exploration marker is present");
    assert.ok(
      outcome.assistantTurn.text.includes("[Exploration context from material"),
      "the material context travels into the new exploration",
    );
    assert.ok(outcome.assistantTurn.text.includes("换轨后的新问题"));
    /* 旧历史保持可读（来源关系不动）。 */
    const turns = studio2.repository.listTurns(creation.branch.id);
    assert.ok(
      turns.some((t) => t.role === "user" && t.text.endsWith("丢失前的首问")),
      "the old first-question turn stays readable after the loss",
    );

    /* 首问重放仍幂等（landed turn 对账不受 session 丢失影响）。 */
    const replay = await branching2.firstQuestion({
      treeId: tree.id,
      intentKey: "lost-1",
      firstQuestion: "丢失前的首问",
    });
    assert.equal(replay.dispatch, "succeeded");
    assert.equal(replay.outcome, null, "session loss does not re-send the landed first question");
    await studio2.shutdown();
  } finally {
    await studio.shutdown().catch(() => {});
    cleanupDir(dir);
  }
});

test("non-ready versions refuse branching with the honest reason (charter §3.2 — never disguise unsupported as an empty success)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    /* B1 冻结负例：corrupt pdf → 版本 failed（原因码入 parseError）。 */
    const imported = await studio.materials.importMaterial(tree.id, {
      filename: "neg-pdf-corrupt.pdf",
      bytes: b1Bytes("negative/neg-pdf-corrupt.pdf"),
    });
    await until(
      () =>
        studio.materials.getMaterialDetail(tree.id, imported.material.id).versions[0]!.parseStatus !== "parsing" &&
        studio.materials.getMaterialDetail(tree.id, imported.material.id).versions[0]!.parseStatus !== "pending",
      "the corrupt version to settle",
    );
    const detail = studio.materials.getMaterialDetail(tree.id, imported.material.id);
    assert.equal(detail.versions[0]!.parseStatus, "failed");

    const branching = makeBranching(studio);
    const resolver = new MaterialRangeResolver({ repository: studio.materialRepository });
    const resolution = resolver.resolve({
      materialId: imported.material.id,
      versionId: imported.version.id,
      locator: { kind: "utf16-range", start: 0, end: 4 },
    });
    /* 解析层已拒绝（material-not-ready）——建枝服务同样拒绝。 */
    if (resolution.ok) {
      assert.throws(
        () =>
          branching.createMaterialBranch({ treeId: tree.id, selection: resolution.result.selection, intentKey: "neg-1" }),
        (err: unknown) => err instanceof Error && err.message.includes("not ready"),
      );
    } else {
      assert.equal(resolution.rejection.code, "material-not-ready");
    }
    assert.equal(studio.repository.listBranches(tree.id).length, 1, "only the trunk exists — zero branching rows");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* HTTP 面（真实 node:http + fetch；与 materials-api.test.ts 同纪律） */
/* ------------------------------------------------------------------ */

interface HttpOutcome {
  status: number;
  body: any;
}

async function call(url: string, method: string, body?: unknown): Promise<HttpOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* 204 等无 body 响应 */
  }
  return { status: response.status, body: parsed };
}

test("material branching HTTP API: from-material create/replay/conflict/restore/new + first-question + return + new-exploration + 503 unwired (D4-contracts §3 D4-3 rows)", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  const server = createStudioServer({
    service: studio.service,
    staticDir,
    materials: studio.materials,
  });
  const port = await server.listen(0);
  try {
    const base = `http://127.0.0.1:${port}`;
    const created = await call(`${base}/api/trees`, "POST");
    const treeId = created.body.tree.id as TreeId;
    const material = await importReadyMarkdown(studio, treeId, "http.md", THREE_BLOCKS);
    const selection = resolveOccurrence(studio, material, "Beta context block");
    const other = resolveOccurrence(studio, material, "Gamma 收尾");

    /* from-material：新建 201（零 Run/Turn 的上下文声明）。 */
    const create1 = await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
      selection,
      intentKey: "http-1",
      mode: "new",
    });
    assert.equal(create1.status, 201);
    assert.equal(create1.body.mode, "created");
    assert.equal(create1.body.created, true);
    assert.ok(create1.body.context.composed.includes("Beta context block"));
    const branchId = create1.body.branch.id;

    /* 同键重放 200。 */
    const replay1 = await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
      selection,
      intentKey: "http-1",
      mode: "new",
    });
    assert.equal(replay1.status, 200);
    assert.equal(replay1.body.branch.id, branchId);
    assert.equal(replay1.body.created, false);

    /* 同键不同选区 409 material-branch-conflict。 */
    const conflict = await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
      selection: other,
      intentKey: "http-1",
      mode: "new",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "material-branch-conflict");

    /* resume-or-create：已有探索 → 200 restored（同一来源恢复）。 */
    const resumed = await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
      selection,
      intentKey: "unused-key",
      mode: "resume-or-create",
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.mode, "restored");
    assert.equal(resumed.body.branch.id, branchId);

    /* resume-or-create：无探索 → 201 created。 */
    const fresh = await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
      selection: other,
      intentKey: "http-2",
      mode: "resume-or-create",
    });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.mode, "created");

    /* 非法 mode / 缺 intentKey / 缺 selection → 400；未知树 → 404。 */
    assert.equal(
      (await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", {
        selection,
        intentKey: "http-3",
        mode: "bogus",
      })).status,
      400,
    );
    assert.equal(
      (await call(`${base}/api/trees/${treeId}/branches/from-material`, "POST", { selection })).status,
      400,
    );
    assert.equal(
      (await call(`${base}/api/trees/tree_missing/branches/from-material`, "POST", {
        selection,
        intentKey: "http-4",
      })).status,
      404,
    );
    assert.equal(
      (await call(`${base}/api/trees/${treeId}/branches/from-material`, "GET")).status,
      405,
    );

    /* material-first-question：派发 200 succeeded → 重放 → 异问 409。 */
    const dispatch = await call(`${base}/api/trees/${treeId}/material-first-question`, "POST", {
      intentKey: "http-1",
      firstQuestion: "HTTP 首问",
    });
    assert.equal(dispatch.status, 200);
    assert.equal(dispatch.body.dispatch, "succeeded");
    assert.equal(dispatch.body.branch.id, branchId);
    assert.ok(dispatch.body.landed.userTurnId);

    const replayDispatch = await call(`${base}/api/trees/${treeId}/material-first-question`, "POST", {
      intentKey: "http-1",
      firstQuestion: "HTTP 首问",
    });
    assert.equal(replayDispatch.status, 200);
    assert.equal(replayDispatch.body.dispatch, "succeeded");
    assert.equal(replayDispatch.body.outcome, null);
    assert.equal(replayDispatch.body.landed.userTurnId, dispatch.body.landed.userTurnId);

    const conflictDispatch = await call(`${base}/api/trees/${treeId}/material-first-question`, "POST", {
      intentKey: "http-1",
      firstQuestion: "HTTP 异问",
    });
    assert.equal(conflictDispatch.status, 409);
    assert.equal(conflictDispatch.body.error.code, "material-first-question-conflict");

    /* material-return：201 + 卡片；重放 200。 */
    const ret = await call(`${base}/api/trees/${treeId}/material-return`, "POST", {
      fromBranchId: branchId,
      text: "HTTP 收获",
      idempotencyKey: "http-ret-1",
    });
    assert.equal(ret.status, 201);
    assert.equal(ret.body.returnTurn.targetAnchor, null);
    assert.equal(ret.body.card.excerpt, selection.excerpt);
    const retReplay = await call(`${base}/api/trees/${treeId}/material-return`, "POST", {
      fromBranchId: branchId,
      text: "HTTP 收获",
      idempotencyKey: "http-ret-1",
    });
    assert.equal(retReplay.status, 200);
    assert.equal(retReplay.body.created, false);

    /* material-new-exploration：session 可用 → 409。 */
    const early = await call(`${base}/api/trees/${treeId}/branches/${branchId}/material-new-exploration`, "POST", {
      text: "提前换轨",
    });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "new-exploration-conflict");
  } finally {
    await server.close();
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("material branching HTTP API: unwired materials → 503 material-branching-not-wired for every D4-3 route", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  const server = createStudioServer({ service: studio.service, staticDir });
  const port = await server.listen(0);
  try {
    const base = `http://127.0.0.1:${port}`;
    const created = await call(`${base}/api/trees`, "POST");
    const treeId = created.body.tree.id;
    for (const [path, body] of [
      ["/branches/from-material", { selection: {}, intentKey: "k" }],
      ["/material-first-question", { intentKey: "k", firstQuestion: "q" }],
      ["/material-return", { fromBranchId: "b", text: "t", idempotencyKey: "k" }],
      ["/branches/branch_x/material-new-exploration", { text: "t" }],
    ] as const) {
      const outcome = await call(`${base}/api/trees/${treeId}${path}`, "POST", body);
      assert.equal(outcome.status, 503, `${path} must report 503 when unwired`);
      assert.equal(outcome.body.error.code, "material-branching-not-wired");
    }
  } finally {
    await server.close();
    await studio.shutdown();
    cleanupDir(dir);
  }
});
