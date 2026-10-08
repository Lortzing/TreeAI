/**
 * 术语①阅读模式（issue #7 术语①，2026-10-01）——服务端/HTTP 测试面。
 *
 * 覆盖（脚本化主 runtime（固定多段答案）+ 脚本化术语 runtime（按 passage
 * 生成切片精确的 JSON 候选）+ 真实 SQLite）：
 *  - 纯函数：段落切分（空行分段口径）、密度上限（每段/每回答，先到先得 +
 *    hiddenCount）、来源投影（锚点缺失/漂移 → source-invalid）；
 *  - 阅读模式持久化：默认 manual-only、枚举校验、kv 跨重启、损坏 kv
 *    降级为缺省；
 *  - 质量门禁 gate=false（生产缺省，含宿主不传装配路径）：模式可保存可
 *    切换，但 assistant 回答完成后**零自动派发**——术语 runtime 零 prompt、
 *    任务表零、用量/记账零变动；readModel 如实暴露
 *    autoSuggestions.enabled=false + reason "quality-gate-pending"；
 *  - gate=true（测试强开）：
 *      · 触发范围：仅 assistant 回答完成触发（一次 extract 派发）；
 *        浏览/读模型/树列表零追加派发；run 失败/中止零派发；
 *      · 密度上限：少量提示档（每段 ≤3、每回答 ≤6）截断 → partial +
 *        hiddenCount；辅助阅读档（每段 ≤6、每回答 ≤12）不截断 → ready；
 *      · 零候选 → no-suggestions；
 *      · 预算不足 → budget-paused（零派发、用量零）+ 显式重试入口
 *        （重试后仍如实 budget-paused）；
 *      · 来源失效 → source-invalid（纯函数投影：锚点缺失/全文指纹失配/
 *        分支不符——append-only 仓内无真实漂移路径，如实以投影函数覆盖）；
 *      · 自动保存**永不发生**：管线全程 annotations 零新增、分支零新增；
 *  - HTTP 面：GET/PUT settings/reading-mode（枚举 400 / 未知树 404 /
 *    readModel 带模式与 autoSuggestions 状态）、suggestions/:id/retry
 *    （200 / 404 / 400 gate 未过 / 400 manual-only）。
 *
 * 密度数值（3/6、6/12）与段落切分（空行分段）均为工程占位参数——v2 精确
 * 数值待负责人确认（见 terminology.ts 常量注释）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  BranchId,
  PiRuntime,
  PiSessionInit,
  PiSessionSnapshot,
  PiPromptInput,
  PiPromptResult,
  PiSteerInput,
  PiNavigateTreeTarget,
  PiRuntimeEventListener,
  PiUnsubscribe,
  SessionReference,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import { TreeAIRuntimeError } from "@treeai/runtime-pi";
import { EntityNotFoundError, InvalidArgumentError, TreeRepository } from "@treeai/persistence";
import { TreeStudioService } from "../src/service.ts";
import {
  TerminologyExecutor,
  TerminologyService,
  applySuggestionDensity,
  paragraphRangesOf,
  projectSuggestionSet,
  TERMINOLOGY_AUTO_QUALITY_GATE,
  type TerminologySuggestionSet,
} from "../src/terminology.ts";
import { createStudioServer } from "../src/server.ts";
import { cleanupDir, makeTempDataDir, STUDIO_MODEL } from "./helpers.ts";

/* ---------------- 固定答案（多段——密度上限的段维度测试面） ---------------- */

const ANSWER = "Alpha beta gamma delta epsilon zeta.\n\nEta theta iota kappa lambda mu.";

/** 与 src/terminology.ts hashSourceText 同口径（SHA-256 hex）。 */
function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 脚本化主 runtime：prompt 恒返回固定答案（createSession 恒成功）。 */
function scriptedMainRuntime(options: {
  readonly answer?: string;
  readonly failWith?: Error;
}): PiRuntime & { readonly prompts: string[] } {
  const prompts: string[] = [];
  const reference = (): SessionReference => ({
    sessionId: "main-scripted" as SessionReference["sessionId"],
    sessionFile: "/nonexistent/modes-main.jsonl",
    entryId: "entry-main" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  });
  return {
    prompts,
    get piVersion() {
      return "0.85.1" as PiRuntime["piVersion"];
    },
    createSession(_init: PiSessionInit): Promise<PiSessionSnapshot> {
      void _init;
      return Promise.resolve({ reference: reference() });
    },
    restoreSession(ref: SessionReference): Promise<PiSessionSnapshot> {
      void ref;
      return Promise.resolve({ reference: reference() });
    },
    async prompt(input: PiPromptInput): Promise<PiPromptResult> {
      prompts.push(input.text);
      if (options.failWith !== undefined) throw options.failWith;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { message: options.answer ?? ANSWER, reference: reference() };
    },
    steer(_input: PiSteerInput): Promise<void> {
      void _input;
      return Promise.resolve();
    },
    abort(): Promise<void> {
      return Promise.resolve();
    },
    navigateTree(_target: PiNavigateTreeTarget): Promise<SessionReference> {
      void _target;
      return Promise.resolve(reference());
    },
    subscribe(_listener: PiRuntimeEventListener): PiUnsubscribe {
      void _listener;
      return () => undefined;
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  } as PiRuntime & { readonly prompts: string[] };
}

/**
 * 脚本化术语 runtime：从 extract 提示词的 [Passage] 段生成**切片精确**的
 * JSON 候选（词序 = 文档序；validateCandidates 的切片全等校验恒通过）。
 * empty=true → 恒回 []（no-suggestions 面）。
 */
function candidateTermRuntime(options: {
  readonly empty?: boolean;
  readonly delayMs?: number;
}): PiRuntime & { readonly prompts: string[] } {
  return termRuntimeWithAnswer((passage) => {
    if (options.empty === true) return "[]";
    const seen = new Set<string>();
    const out: Array<{ term: string; start: number; end: number }> = [];
    for (const match of passage.matchAll(/\p{L}+/gu)) {
      const term = match[0];
      const start = match.index ?? 0;
      if (seen.has(term)) continue;
      seen.add(term);
      out.push({ term, start, end: start + term.length });
    }
    return JSON.stringify(out);
  }, options.delayMs);
}

/** 脚本化术语 runtime（答案 = answerFor(passage)；记录全部 prompt 文本）。 */
function termRuntimeWithAnswer(
  answerFor: (passage: string) => string,
  delayMs = 1,
): PiRuntime & { readonly prompts: string[] } {
  const prompts: string[] = [];
  const reference = (): SessionReference => ({
    sessionId: "term-modes" as SessionReference["sessionId"],
    sessionFile: "/nonexistent/term-modes.jsonl",
    entryId: "entry-term-modes" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  });
  return {
    prompts,
    get piVersion() {
      return "0.85.1" as PiRuntime["piVersion"];
    },
    createSession(_init: PiSessionInit): Promise<PiSessionSnapshot> {
      void _init;
      return Promise.resolve({ reference: reference() });
    },
    restoreSession(ref: SessionReference): Promise<PiSessionSnapshot> {
      void ref;
      return Promise.resolve({ reference: reference() });
    },
    async prompt(input: PiPromptInput): Promise<PiPromptResult> {
      prompts.push(input.text);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const at = input.text.lastIndexOf("[Passage]\n");
      const passage = at >= 0 ? input.text.slice(at + "[Passage]\n".length) : input.text;
      return { message: answerFor(passage), reference: reference() };
    },
    steer(_input: PiSteerInput): Promise<void> {
      void _input;
      return Promise.resolve();
    },
    abort(): Promise<void> {
      return Promise.resolve();
    },
    navigateTree(_target: PiNavigateTreeTarget): Promise<SessionReference> {
      void _target;
      return Promise.resolve(reference());
    },
    subscribe(_listener: PiRuntimeEventListener): PiUnsubscribe {
      void _listener;
      return () => undefined;
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  } as PiRuntime & { readonly prompts: string[] };
}

/* ---------------- 装配 ---------------- */

interface ModesStudio {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly service: TreeStudioService;
  readonly terminology: TerminologyService;
  readonly executor: TerminologyExecutor;
  readonly mainRuntime: PiRuntime & { readonly prompts: string[] };
  readonly termRuntime: PiRuntime & { readonly prompts: string[] };
  shutdown(): Promise<void>;
}

interface ModesStudioOptions {
  /** 质量门禁（缺省不传 = false = 生产路径）。 */
  readonly gate?: boolean;
  readonly budgetTokens?: number;
  readonly mainRuntime?: PiRuntime & { readonly prompts: string[] };
  readonly termRuntime?: PiRuntime & { readonly prompts: string[] };
}

function makeModesStudio(dir: string, options: ModesStudioOptions = {}): ModesStudio {
  const sessionsDir = join(dir, "sessions");
  const workspace = join(dir, "workspace");
  const terminologySessions = join(dir, "terminology", "sessions");
  const terminologyWorkspace = join(dir, "terminology", "workspace");
  for (const d of [sessionsDir, workspace, terminologySessions, terminologyWorkspace]) {
    mkdirSync(d, { recursive: true });
  }
  const repository = TreeRepository.open({ path: join(dir, "treeai.db") });
  const mainRuntime = options.mainRuntime ?? scriptedMainRuntime({});
  const service = new TreeStudioService({
    repository,
    runtime: mainRuntime,
    model: STUDIO_MODEL,
    sessionDir: sessionsDir,
    cwd: workspace,
  });
  const termRuntime = options.termRuntime ?? candidateTermRuntime({});
  const executor = new TerminologyExecutor({
    runtime: termRuntime,
    model: STUDIO_MODEL,
    sessionDir: terminologySessions,
    cwd: terminologyWorkspace,
    budgetTokens: options.budgetTokens ?? 1_000_000,
    cacheEnabled: true,
    onUsage: (usage) => {
      repository.setTerminologyState("usage", JSON.stringify(usage));
    },
  });
  const terminology = new TerminologyService({
    repository,
    executor,
    studio: service,
    ...(options.gate === undefined ? {} : { autoQualityGate: options.gate }),
  });
  return {
    dir,
    repository,
    service,
    terminology,
    executor,
    mainRuntime,
    termRuntime,
    async shutdown(): Promise<void> {
      terminology.dispose();
      await service.dispose();
      await executor.dispose();
      repository.close();
    },
  };
}

/** 轮询至该锚点 turn 的建议集达到期望状态（自动管线 fire-and-forget）。 */
async function awaitSuggestionSet(
  terminology: TerminologyService,
  treeId: TreeId,
  anchorTurnId: TurnId,
  predicate: (set: TerminologySuggestionSet) => boolean,
): Promise<TerminologySuggestionSet> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const set =
      terminology.autoSuggestionsState(treeId).sets.find((entry) => entry.anchorTurnId === anchorTurnId) ??
      null;
    if (set !== null && predicate(set)) return set;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the suggestion set did not reach the expected state in time");
}

async function makeTree(studio: ModesStudio): Promise<{
  treeId: TreeId;
  trunkId: BranchId;
  turnId: TurnId;
}> {
  const created = studio.service.createTree();
  const outcome = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "question one");
  return {
    treeId: created.tree.id,
    trunkId: created.trunkBranch.id,
    turnId: outcome.assistantTurn.id,
  };
}

/* ---------------- 纯函数：段落 / 密度 / 投影 ---------------- */

test("reading modes pure helpers: blank-line paragraphs, per-paragraph/per-answer density caps (first-come, hiddenCount), and source-invalid projection", () => {
  /* 段落切分：空行分段、连续空行一段边界、单换行不分段、区间闭开。 */
  const single = "one line only";
  assert.deepEqual(paragraphRangesOf(single), [{ start: 0, end: single.length }]);
  const multi = "first para.\n\nsecond para spans\nmultiple lines.\n\n\nthird para.";
  const ranges = paragraphRangesOf(multi);
  assert.equal(ranges.length, 3);
  assert.equal(multi.slice(ranges[0]!.start, ranges[0]!.end), "first para.");
  assert.equal(multi.slice(ranges[1]!.start, ranges[1]!.end), "second para spans\nmultiple lines.");
  assert.equal(multi.slice(ranges[2]!.start, ranges[2]!.end), "third para.");
  /* 前缀空行不产生空段；空文本零段。 */
  assert.deepEqual(paragraphRangesOf("\n\nx"), [{ start: 2, end: 3 }]);
  assert.deepEqual(paragraphRangesOf(""), []);

  /* 候选全集：6 词在段 1、6 词在段 2（文档序，共 12）。 */
  const all: Array<{ term: string; start: number; end: number }> = [];
  for (const match of ANSWER.matchAll(/\p{L}+/gu)) {
    const start = match.index ?? 0;
    all.push({ term: match[0], start, end: start + match[0].length });
  }
  assert.equal(all.length, 12);

  /* 段上限先绑（minimal 3/6）：两段各截 3 → kept 6 / hidden 6。 */
  const minimal = applySuggestionDensity(ANSWER, all, { perParagraph: 3, perAnswer: 6 });
  assert.deepEqual(
    minimal.kept.map((entry) => entry.term),
    ["Alpha", "beta", "gamma", "Eta", "theta", "iota"],
  );
  assert.equal(minimal.hiddenCount, 6);

  /* assisted（6/12）：全量保留。 */
  const assisted = applySuggestionDensity(ANSWER, all, { perParagraph: 6, perAnswer: 12 });
  assert.equal(assisted.kept.length, 12);
  assert.equal(assisted.hiddenCount, 0);

  /* 回答上限先绑（段上限放宽到 10、回答 6）：kept = 前 6 词、hidden 6。 */
  const answerCapped = applySuggestionDensity(ANSWER, all, { perParagraph: 10, perAnswer: 6 });
  assert.deepEqual(
    answerCapped.kept.map((entry) => entry.term),
    ["Alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
  );
  assert.equal(answerCapped.hiddenCount, 6);

  /* 投影：锚点缺失 / 全文指纹失配 / 分支不符 → source-invalid；完好维持
     存储状态（含 budget-paused）。 */
  const base: TerminologySuggestionSet = {
    treeId: "tree-x" as TreeId,
    branchId: "branch-x" as BranchId,
    anchorTurnId: "turn-x" as TurnId,
    readingMode: "minimal-hints",
    status: "ready",
    suggestions: [{ term: "Alpha", start: 0, end: 5 }],
    hiddenCount: 0,
    sourceHash: hashOf(ANSWER),
    createdAt: "2026-10-01T00:00:00.000Z",
    error: null,
  };
  assert.equal(projectSuggestionSet(base, null).status, "source-invalid");
  assert.equal(
    projectSuggestionSet(base, { branchId: "branch-x" as BranchId, text: `${ANSWER} drifted` }).status,
    "source-invalid",
  );
  assert.equal(
    projectSuggestionSet(base, { branchId: "branch-other" as BranchId, text: ANSWER }).status,
    "source-invalid",
  );
  assert.equal(projectSuggestionSet(base, { branchId: "branch-x" as BranchId, text: ANSWER }).status, "ready");
  assert.equal(
    projectSuggestionSet(
      { ...base, status: "budget-paused", error: { code: "budget-exceeded", message: "no room" } },
      { branchId: "branch-x" as BranchId, text: ANSWER },
    ).status,
    "budget-paused",
  );
});

/* ---------------- 阅读模式持久化（gate 无关） ---------------- */

test("reading mode persistence: default manual-only, enum validation, unknown tree 404, kv round-trip across a restart, corrupt kv degrades to the default", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir);
    const { treeId } = await makeTree(studio);
    assert.equal(studio.terminology.getReadingMode(treeId), "manual-only");
    studio.terminology.setReadingMode(treeId, "assisted-reading");
    assert.equal(studio.terminology.getReadingMode(treeId), "assisted-reading");
    studio.terminology.setReadingMode(treeId, "minimal-hints");
    assert.equal(studio.terminology.getReadingMode(treeId), "minimal-hints");
    /* 非法枚举 → InvalidArgumentError（HTTP 400 语义）。 */
    assert.throws(
      () => studio.terminology.setReadingMode(treeId, "auto" as never),
      InvalidArgumentError,
    );
    assert.throws(() => studio.terminology.getReadingMode("tree-nope" as TreeId), EntityNotFoundError);
    assert.throws(
      () => studio.terminology.setReadingMode("tree-nope" as TreeId, "manual-only"),
      EntityNotFoundError,
    );
    await studio.shutdown();

    /* 跨重启：同一 DB 新装配读到保存的模式。 */
    const reopened = makeModesStudio(dir);
    assert.equal(reopened.terminology.getReadingMode(treeId), "minimal-hints");
    /* 损坏 kv（非法 JSON）→ 展示偏好降级为缺省 manual-only（与用量
       fail-closed 是两类语义——见 terminology.ts getReadingMode 注释）。 */
    reopened.repository.setTerminologyState(`reading-mode:${treeId}`, "this is not json at all");
    assert.equal(reopened.terminology.getReadingMode(treeId), "manual-only");
    await reopened.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ---------------- gate=false（生产缺省）：零自动派发 ---------------- */

test("quality gate OFF (production default): modes save and switch, but assistant answer completions dispatch NOTHING — zero term-runtime prompts, zero tasks, zero usage, honest autoSuggestions state", async () => {
  assert.equal(TERMINOLOGY_AUTO_QUALITY_GATE, false, "the production default gate must be false");
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir); /* 不传 gate → 生产路径 */
    const { treeId, trunkId, turnId } = await makeTree(studio);
    assert.equal(studio.mainRuntime.prompts.length, 1, "the main prompt ran");
    /* 模式可保存可切换（gate 不拦截保存）。 */
    studio.terminology.setReadingMode(treeId, "minimal-hints");
    const second = await studio.service.prompt(treeId, trunkId, "question two");
    /* 管线 fire-and-forget：等待足够久后仍零派发（gate=false 处理器第一行即返回）。 */
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(studio.termRuntime.prompts.length, 0, "zero dispatch on the terminology runtime");
    assert.deepEqual(studio.executor.listTasks(), [], "the task table stays empty");
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 0, "zero requests");
    assert.equal(usage.estTokens, 0, "zero estimated tokens — the accounting is untouched");
    /* readModel 如实暴露未生效原因 + 零建议集。 */
    const read = studio.terminology.readModel(treeId);
    assert.equal(read.readingMode, "minimal-hints");
    assert.deepEqual(read.autoSuggestions, {
      enabled: false,
      reason: "quality-gate-pending",
      sets: [],
    });
    assert.equal(read.autoSuggestions.sets.length, 0);
    void second;
    void turnId;
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ---------------- gate=true：触发范围 / 密度 / 四状态 ---------------- */

test("gate ON (test-forced): only an assistant answer completion triggers exactly one extract; browsing adds nothing; failed and aborted runs dispatch nothing; auto-saving never happens", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir, { gate: true });
    const { treeId, trunkId, turnId } = await makeTree(studio);
    /* 第一答完成时模式还是 manual-only（缺省）——同时覆盖「仅手动零派发」。 */
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(studio.termRuntime.prompts.length, 0, "manual-only: zero dispatch");
    assert.equal(
      studio.terminology.autoSuggestionsState(treeId).reason,
      "manual-only",
      "manual-only surfaces its honest reason while the gate is open",
    );

    studio.terminology.setReadingMode(treeId, "minimal-hints");
    const second = await studio.service.prompt(treeId, trunkId, "question two");
    const set = await awaitSuggestionSet(studio.terminology, treeId, second.assistantTurn.id, (entry) =>
      entry.status !== "pending",
    );
    /* v2 minimal 1/段、3/回答：首段候选按序只保留 1 个，其余诚实截断。 */
    assert.equal(set.status, "partial");
    assert.equal(set.suggestions.length, 1);
    assert.equal(set.hiddenCount, 2);
    assert.equal(set.readingMode, "minimal-hints");
    assert.equal(set.suggestions[0]!.term, "Alpha");
    assert.equal(ANSWER.slice(set.suggestions[0]!.start, set.suggestions[0]!.end), "Alpha");
    assert.equal(studio.termRuntime.prompts.length, 1, "exactly one extract dispatch");
    assert.equal(
      studio.termRuntime.prompts[0]!.includes("up to 3 specialized terms"),
      true,
      "the extract prompt is sized by the minimal per-answer cap",
    );
    /* 第一答（manual-only 期间完成）没有建议集——触发以完成时刻的模式为准。 */
    assert.equal(
      studio.terminology
        .autoSuggestionsState(treeId)
        .sets.some((entry) => entry.anchorTurnId === turnId),
      false,
    );

    /* 浏览零派发：树态/读模型/树列表只读操作不追加任何 extract。 */
    studio.service.getTreeState(treeId);
    studio.terminology.readModel(treeId);
    studio.terminology.readModel(treeId);
    studio.service.listTrees();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(studio.termRuntime.prompts.length, 1, "browsing dispatches nothing");

    /* 自动保存永不发生：批注零、分支零新增（建议只是展示面）。 */
    assert.equal(studio.repository.listTerminologyAnnotations(treeId).length, 0);
    assert.equal(studio.service.getTreeState(treeId).branches.length, 1);
    await studio.shutdown();

    /* 失败 run / 中止 run 零派发（run-terminal 非 succeeded 不触发）。 */
    const failStudio = makeModesStudio(join(dir, "fail"), {
      gate: true,
      mainRuntime: scriptedMainRuntime({ failWith: new Error("scripted main failure") }),
    });
    const failTree = failStudio.service.createTree();
    failStudio.terminology.setReadingMode(failTree.tree.id, "minimal-hints");
    await assert.rejects(() => failStudio.service.prompt(failTree.tree.id, failTree.trunkBranch.id, "x"));
    const abortStudio = makeModesStudio(join(dir, "abort"), {
      gate: true,
      mainRuntime: scriptedMainRuntime({
        failWith: new TreeAIRuntimeError("user-abort", "scripted abort"),
      }),
    });
    const abortTree = abortStudio.service.createTree();
    abortStudio.terminology.setReadingMode(abortTree.tree.id, "minimal-hints");
    await assert.rejects(() => abortStudio.service.prompt(abortTree.tree.id, abortTree.trunkBranch.id, "x"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(failStudio.termRuntime.prompts.length, 0, "a failed run dispatches nothing");
    assert.equal(abortStudio.termRuntime.prompts.length, 0, "an aborted run dispatches nothing");
    await failStudio.shutdown();
    await abortStudio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("gate ON + assisted reading: v2 per-paragraph 2 / per-answer 6 caps are enforced honestly", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir, { gate: true });
    const created = studio.service.createTree();
    await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q");
    studio.terminology.setReadingMode(created.tree.id, "assisted-reading");
    const second = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q2");
    const set = await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status !== "pending",
    );
    assert.equal(set.status, "partial", "v2 caps keep at most two candidates per paragraph and six overall");
    assert.equal(set.suggestions.length, 2);
    assert.equal(set.hiddenCount, 4);
    assert.equal(
      studio.termRuntime.prompts[0]!.includes("up to 6 specialized terms"),
      true,
      "the extract prompt is sized by the assisted per-answer cap",
    );
    assert.equal(studio.repository.listTerminologyAnnotations(created.tree.id).length, 0);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("gate ON: zero validated candidates surface as no-suggestions; one suggestion set per completed answer", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir, {
      gate: true,
      termRuntime: candidateTermRuntime({ empty: true }),
    });
    const created = studio.service.createTree();
    await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q");
    studio.terminology.setReadingMode(created.tree.id, "minimal-hints");
    const second = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q2");
    const third = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q3");
    const secondSet = await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status !== "pending",
    );
    assert.equal(secondSet.status, "no-suggestions");
    assert.deepEqual(secondSet.suggestions, []);
    await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      third.assistantTurn.id,
      (entry) => entry.status !== "pending",
    );
    assert.equal(
      studio.terminology.autoSuggestionsState(created.tree.id).sets.length,
      2,
      "one suggestion set per completed answer",
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("gate ON + exhausted budget: budget-paused with zero dispatch and untouched accounting; the explicit retry stays honestly paused; no annotation is ever written", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeModesStudio(dir, { gate: true, budgetTokens: 1 });
    const created = studio.service.createTree();
    await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q");
    studio.terminology.setReadingMode(created.tree.id, "minimal-hints");
    const second = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q2");
    const set = await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status !== "pending",
    );
    assert.equal(set.status, "budget-paused");
    assert.equal(set.error !== null && set.error.code, "budget-exceeded");
    assert.equal(set.suggestions.length, 0);
    assert.equal(studio.termRuntime.prompts.length, 0, "the preflight refused before any dispatch");
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 0, "zero-dispatch: the accounting is untouched");
    assert.equal(usage.estTokens, 0);
    /* 可恢复入口（显式重试）：预算未变 → 仍如实 budget-paused。 */
    await studio.terminology.retrySuggestions(created.tree.id, second.assistantTurn.id);
    await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status === "budget-paused",
    );
    assert.equal(studio.termRuntime.prompts.length, 0);
    assert.equal(studio.repository.listTerminologyAnnotations(created.tree.id).length, 0);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("gate ON + unparseable model answer: the set lands on failed honestly; the explicit retry re-runs and recovers", async () => {
  const dir = makeTempDataDir();
  try {
    /* 第一次 extract 回非 JSON（terminology-parse failed）；重试后回好答案。 */
    let call = 0;
    const studio = makeModesStudio(dir, {
      gate: true,
      termRuntime: termRuntimeWithAnswer((passage) => {
        call += 1;
        if (call === 1) return "this is not a JSON array of candidates";
        const seen = new Set<string>();
        const out: Array<{ term: string; start: number; end: number }> = [];
        for (const match of passage.matchAll(/\p{L}+/gu)) {
          const start = match.index ?? 0;
          if (seen.has(match[0])) continue;
          seen.add(match[0]);
          out.push({ term: match[0], start, end: start + match[0].length });
        }
        return JSON.stringify(out);
      }),
    });
    const created = studio.service.createTree();
    await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q");
    studio.terminology.setReadingMode(created.tree.id, "minimal-hints");
    const second = await studio.service.prompt(created.tree.id, created.trunkBranch.id, "q2");
    const failed = await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status !== "pending",
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.error !== null && failed.error.code, "terminology-parse");
    /* 显式重试（可恢复入口）：重跑后按好答案收敛（partial/ready 皆可）。 */
    await studio.terminology.retrySuggestions(created.tree.id, second.assistantTurn.id);
    const recovered = await awaitSuggestionSet(
      studio.terminology,
      created.tree.id,
      second.assistantTurn.id,
      (entry) => entry.status === "ready" || entry.status === "partial",
    );
    assert.ok(recovered.suggestions.length > 0);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ---------------- HTTP 面 ---------------- */

test("reading-mode HTTP surface: GET/PUT settings/reading-mode (enum 400 / unknown tree 404), read model carries mode + autoSuggestions, retry 200/404/400(gate)/400(manual-only)", async () => {
  const dir = makeTempDataDir();
  const running: Array<{ close(): Promise<void> }> = [];
  try {
    const studio = makeModesStudio(dir, { gate: true });
    const { treeId, trunkId } = await makeTree(studio);
    const staticDir = join(dir, "static");
    mkdirSync(staticDir, { recursive: true });
    const server = createStudioServer({
      service: studio.service,
      staticDir,
      terminology: studio.terminology,
    });
    const port = await server.listen(0);
    running.push({ close: () => server.close() });
    const base = `http://127.0.0.1:${String(port)}`;
    const call = async (
      path: string,
      method: string,
      body?: unknown,
    ): Promise<{ status: number; body: any }> => {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: payload };
    };
    const termPath = (rest: string): string =>
      `/api/trees/${encodeURIComponent(treeId)}/terminology${rest === "" ? "" : `/${rest}`}`;

    /* gate=false 的服务器（缺省装配——宿主 index.ts 同路径）。 */
    const defaultDir = join(dir, "default-gate");
    const defaultStudio = makeModesStudio(defaultDir);
    const defaultTree = defaultStudio.service.createTree();
    await defaultStudio.service.prompt(defaultTree.tree.id, defaultTree.trunkBranch.id, "q");
    const defaultServer = createStudioServer({
      service: defaultStudio.service,
      staticDir,
      terminology: defaultStudio.terminology,
    });
    const defaultPort = await defaultServer.listen(0);
    running.push({ close: () => defaultServer.close() });
    const defaultBase = `http://127.0.0.1:${String(defaultPort)}`;
    const defaultCall = async (
      path: string,
      method: string,
      body?: unknown,
    ): Promise<{ status: number; body: any }> => {
      const res = await fetch(defaultBase + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: payload };
    };

    /* retry：manual-only（PUT 之前的缺省模式）→ 400。 */
    const manualRetry = await call(termPath("suggestions/turn-nope/retry"), "POST");
    assert.equal(manualRetry.status, 400, "manual-only refuses the retry honestly");

    /* GET/PUT 阅读模式（gate=true 实例）。 */
    const initial = await call(termPath("settings/reading-mode"), "GET");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.readingMode, "manual-only");
    const put = await call(termPath("settings/reading-mode"), "PUT", { mode: "minimal-hints" });
    assert.equal(put.status, 200);
    assert.equal(put.body.readingMode, "minimal-hints");
    const afterPut = await call(termPath("settings/reading-mode"), "GET");
    assert.equal(afterPut.body.readingMode, "minimal-hints");
    const badMode = await call(termPath("settings/reading-mode"), "PUT", { mode: "auto" });
    assert.equal(badMode.status, 400);
    const missingMode = await call(termPath("settings/reading-mode"), "PUT", {});
    assert.equal(missingMode.status, 400);
    const unknownTreeMode = await call(`/api/trees/tree-nope/terminology/settings/reading-mode`, "GET");
    assert.equal(unknownTreeMode.status, 404);

    /* readModel 带模式与 autoSuggestions 状态（gate=false 实例）。 */
    const defaultRead = await defaultCall(
      `/api/trees/${encodeURIComponent(defaultTree.tree.id)}/terminology`,
      "GET",
    );
    assert.equal(defaultRead.status, 200);
    assert.equal(defaultRead.body.readingMode, "manual-only");
    assert.deepEqual(defaultRead.body.autoSuggestions, {
      enabled: false,
      reason: "quality-gate-pending",
      sets: [],
    });

    /* retry：gate 未过 → 400（建议管线整体关闭，绝不旁路）。 */
    const gatedRetry = await defaultCall(
      `/api/trees/${encodeURIComponent(defaultTree.tree.id)}/terminology/suggestions/turn-nope/retry`,
      "POST",
    );
    assert.equal(gatedRetry.status, 400);

    /* gate=true + minimal-hints：一答完成后 readModel 携带建议集。 */
    const second = await studio.service.prompt(treeId, trunkId, "question two");
    await awaitSuggestionSet(studio.terminology, treeId, second.assistantTurn.id, (entry) =>
      entry.status !== "pending",
    );
    const read = await call(termPath(""), "GET");
    assert.equal(read.status, 200);
    assert.equal(read.body.readingMode, "minimal-hints");
    assert.equal(read.body.autoSuggestions.enabled, true);
    assert.equal(read.body.autoSuggestions.reason, null);
    const httpSet = read.body.autoSuggestions.sets.find(
      (entry: { anchorTurnId: string }) => entry.anchorTurnId === second.assistantTurn.id,
    );
    assert.ok(httpSet !== undefined, "the read model carries the per-turn suggestion set");
    assert.equal(httpSet.status, "partial");

    /* retry：404（无既有集）/ 200（有集，响应带最新 autoSuggestions）。 */
    const unknownRetry = await call(termPath("suggestions/turn-nope/retry"), "POST");
    assert.equal(unknownRetry.status, 404);
    const retry = await call(
      termPath(`suggestions/${encodeURIComponent(second.assistantTurn.id)}/retry`),
      "POST",
    );
    assert.equal(retry.status, 200);
    assert.ok(Array.isArray(retry.body.autoSuggestions.sets));
    assert.equal(
      studio.repository.listTerminologyAnnotations(treeId).length,
      0,
      "the whole suggestion surface never writes an annotation",
    );
    await defaultStudio.shutdown();
    await studio.shutdown();
  } finally {
    for (const r of running) await r.close().catch(() => undefined);
    cleanupDir(dir);
  }
});
