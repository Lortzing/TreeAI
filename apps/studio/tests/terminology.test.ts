/**
 * 术语三部分（issue #7 C）——①执行器 + ②保存/推广 的离线测试面。
 *
 * 覆盖（echo / 脚本化 runtime + 真实 SQLite）：
 *  - 隔离：解释/提取零树写入、零主 session 文件、主游标不动（issue #7
 *    C ②「关闭 10 次零正式事实/主会话副作用」的机械面）；
 *  - explain 生命周期（echo：解释 = 提示词回声）、去重命中已保存批注时
 *    零模型调用；
 *  - 保存 + 同选区去重 + 锚定完整性（UTF-16 偏移/emoji/跨行/切片全等）；
 *  - 缓存语境（P0 整改）：键含来源身份/选区位置/上下文指纹——bank 复现、
 *    中文同词异位、重复词三连各自调用，同锚点同选区才复用；
 *  - 幂等推广（P0 整改）：单事务原子（键冲突 409 零新增行；注入崩溃于
 *    origin/bind/ledger 写点整体回滚；双击幂等）；首问身份（同键异问
 *    409）；派发账本重放（succeeded 幂等 / failed·pending 重试 /
 *    dispatched 先对账：落库 turn→成功、非终态 Run→unknown 不盲发、
 *    无 Run→重发）；跨重启重放；
 *  - 取消 + 迟到结果丢弃（脚本化 runtime：resolve-after-cancel）；
 *  - 预算（P1 整改）：预留输入+输出上界（budgetTokens=1 零派发）、按
 *    真实 usage 结算、上下文纪律（explain 窗口截断 + 偏移重映射、
 *    selection/source 超限零派发拒绝）、kv 持久化与重启维持；
 *  - 取消记账（P1 整改）：在途取消/超时保留预留、未知成本单列不归零；
 *    落盘失败与 dirty 重启 fail-closed；
 *  - 缓存偏好：同键命中零请求；关闭缓存后重打；
 *  - auto 提取（脚本化 JSON）：机械校验（切片全等/去重/密度/URL+代码
 *    排除）；echo 的非 JSON 回声 → 诚实 failed(terminology-parse)；
 *  - HTTP 面：read model / explain / annotations 201+200 / promote 201+
 *    200+409（含同键异问）/ preferences / cancel / 未装配 503。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PiModelSelector,
  PiRuntime,
  PiSessionInit,
  PiSessionSnapshot,
  PiPromptInput,
  PiPromptResult,
  PiSteerInput,
  PiNavigateTreeTarget,
  PiRuntimeEvent,
  PiRuntimeEventListener,
  PiUnsubscribe,
  SessionReference,
  TreeId,
  TurnId,
  BranchId,
} from "@treeai/contracts";
import { createPiRuntimeFromConfig, classifyPiFailure, TreeAIRuntimeError } from "@treeai/runtime-pi";
import { InvalidArgumentError, TreeRepository } from "@treeai/persistence";
import type { TreeState } from "../src/service.ts";
import { TreeStudioService } from "../src/service.ts";
import { EchoSdkPort, ECHO_FAILURE_MESSAGE } from "../src/echo-port.ts";
import {
  TerminologyExecutor,
  TerminologyPromotionConflictError,
  TerminologyService,
  buildExplainPrompt,
  buildExtractPrompt,
  normalizeExecutorUsage,
  parseCandidates,
  validateCandidates,
  excludedSpans,
  hashSourceText,
  hashFirstQuestionPayload,
  TERMINOLOGY_PROMOTION_TURN_PREFIX,
  USAGE_ACCOUNTING_UNAVAILABLE,
  type TerminologyExecutorUsage,
  type TerminologyTask,
} from "../src/terminology.ts";
import { createStudioServer } from "../src/server.ts";
import { cleanupDir, makeTempDataDir, STUDIO_MODEL } from "./helpers.ts";

function findBranchView(state: TreeState, branchId: BranchId) {
  const view = state.branches.find((v: { branch: { id: string } }) => v.branch.id === branchId);
  assert.ok(view !== undefined, `branch view for ${branchId} must exist`);
  return view as ReturnType<TreeStudioService["getTreeState"]>["branches"][number];
}

/* ---------------- 装配：带术语执行器的完整 studio ---------------- */

interface TerminologyStudio {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly service: TreeStudioService;
  readonly terminology: TerminologyService;
  readonly executor: TerminologyExecutor;
  readonly terminologyEchoPort: EchoSdkPort | null;
  shutdown(): Promise<void>;
}

interface TerminologyStudioOptions {
  /** 覆盖术语 runtime（脚本化场景）；缺省 echo 栈。 */
  readonly terminologyRuntime?: PiRuntime;
  /** 捕获术语 echo 端口（缓存/会话数断言）。 */
  readonly terminologyEcho?: EchoSdkPort;
  /** 预算（估算 token）。 */
  readonly budgetTokens?: number;
  /** 缓存偏好。 */
  readonly cacheEnabled?: boolean;
  /** 预置用量 kv（重启场景）。 */
  readonly persistedUsage?: string;
  /** 模拟记账落盘失败：第 N 次（1 起）起的 onUsage 抛错（fail-closed 回归）。 */
  readonly usagePersistFailsFromCall?: number;
  /** 覆盖主 runtime（失败注入）。 */
  readonly mainRuntime?: PiRuntime;
}

function makeTerminologyStudio(dir: string, options: TerminologyStudioOptions = {}): TerminologyStudio {
  const sessionsDir = join(dir, "sessions");
  const workspace = join(dir, "workspace");
  const terminologySessions = join(dir, "terminology", "sessions");
  const terminologyWorkspace = join(dir, "terminology", "workspace");
  for (const d of [sessionsDir, workspace, terminologySessions, terminologyWorkspace]) {
    mkdirSync(d, { recursive: true });
  }
  const repository = TreeRepository.open({ path: join(dir, "treeai.db") });
  const mainRuntime =
    options.mainRuntime ??
    createPiRuntimeFromConfig({ port: new EchoSdkPort(), defaultCwd: workspace });
  const service = new TreeStudioService({
    repository,
    runtime: mainRuntime,
    model: STUDIO_MODEL,
    sessionDir: sessionsDir,
    cwd: workspace,
  });
  const terminologyEchoPort = options.terminologyEcho ?? null;
  const terminologyRuntime =
    options.terminologyRuntime ??
    createPiRuntimeFromConfig({
      port: options.terminologyEcho ?? new EchoSdkPort(),
      defaultCwd: terminologyWorkspace,
      thinkingLevel: "off",
    });
  let initialUsage: TerminologyExecutorUsage | null = null;
  if (options.persistedUsage !== undefined) {
    repository.setTerminologyState("usage", options.persistedUsage);
    try {
      initialUsage = normalizeExecutorUsage(JSON.parse(options.persistedUsage));
    } catch {
      initialUsage = null;
    }
  }
  let usagePersistCalls = 0;
  const executor = new TerminologyExecutor({
    runtime: terminologyRuntime,
    model: STUDIO_MODEL,
    sessionDir: terminologySessions,
    cwd: terminologyWorkspace,
    budgetTokens: options.budgetTokens ?? 1_000_000,
    cacheEnabled: options.cacheEnabled ?? true,
    initialUsage,
    onUsage: (usage) => {
      usagePersistCalls += 1;
      if (options.usagePersistFailsFromCall !== undefined && usagePersistCalls >= options.usagePersistFailsFromCall) {
        throw new Error("injected usage persistence failure");
      }
      repository.setTerminologyState("usage", JSON.stringify(usage));
    },
  });
  const terminology = new TerminologyService({ repository, executor, studio: service });
  return {
    dir,
    repository,
    service,
    terminology,
    executor,
    terminologyEchoPort,
    async shutdown(): Promise<void> {
      await service.dispose();
      await executor.dispose();
      repository.close();
    },
  };
}

/** 脚本化术语 runtime：createSession 恒成功；prompt 按脚本延迟 resolve（abort 不打断——迟到结果场景）。 */
function scriptedTerminologyRuntime(script: {
  readonly answerFor?: (promptText: string) => string;
  readonly delayMs?: number;
  readonly failOn?: string;
  readonly ignoreAbort?: boolean;
}): PiRuntime & { readonly prompts: string[]; readonly aborts: number } {
  const prompts: string[] = [];
  let aborts = 0;
  const reference = (): SessionReference => ({
    sessionId: "term-scripted" as SessionReference["sessionId"],
    sessionFile: "/nonexistent/terminology-scripted.jsonl",
    entryId: "entry-scripted" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  });
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    prompts,
    aborts: 0,
    get piVersion() {
      return "0.85.1" as PiRuntime["piVersion"];
    },
    get abortCount(): number {
      return aborts;
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
      await delay(script.delayMs ?? 1);
      if (script.failOn !== undefined && input.text.includes(script.failOn)) {
        throw classifyPiFailure(new Error(ECHO_FAILURE_MESSAGE), "Pi run failed");
      }
      const message = script.answerFor !== undefined ? script.answerFor(input.text) : input.text;
      return { message, reference: reference() };
    },
    steer(_input: PiSteerInput): Promise<void> {
      void _input;
      return Promise.resolve();
    },
    abort(): Promise<void> {
      aborts += 1;
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
  } as PiRuntime & { readonly prompts: string[]; readonly aborts: number };
}

/** 标准 fixture：一棵树 + Trunk 一轮 + 锚定分支一轮（返回锚点答案）。 */
async function makeTreeWithAnswer(studio: TerminologyStudio): Promise<{
  treeId: TreeId;
  trunkId: BranchId;
  answer: { readonly id: TurnId; readonly text: string };
}> {
  const created = studio.service.createTree();
  const treeId = created.tree.id;
  const trunkId = created.trunkBranch.id;
  const t1 = await studio.service.prompt(treeId, trunkId, "q1");
  return { treeId, trunkId, answer: { id: t1.assistantTurn.id, text: t1.assistantTurn.text } };
}

/**
 * 取消/超时场景的脚本化术语 runtime：
 * - rejectWith 给出 → prompt 延迟后以该错误拒绝（超时/上游失败注入）；
 * - 否则 prompt 挂起，abort() 以 user-abort 拒绝在途 prompt（真实 Pi 契约语义）。
 */
function abortableTerminologyRuntime(script: {
  readonly rejectWith?: (promptText: string) => Error;
  readonly delayMs?: number;
}): PiRuntime & { readonly prompts: string[]; readonly aborts: number } {
  const prompts: string[] = [];
  let aborts = 0;
  let pendingReject: ((error: Error) => void) | null = null;
  const reference = (): SessionReference => ({
    sessionId: "term-abortable" as SessionReference["sessionId"],
    sessionFile: "/nonexistent/terminology-abortable.jsonl",
    entryId: "entry-abortable" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  });
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    prompts,
    get aborts(): number {
      return aborts;
    },
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
    prompt(input: PiPromptInput): Promise<PiPromptResult> {
      prompts.push(input.text);
      if (script.rejectWith !== undefined) {
        const error = script.rejectWith(input.text);
        return delay(script.delayMs ?? 1).then(
          () => Promise.reject(error),
          () => Promise.reject(error),
        );
      }
      return new Promise<PiPromptResult>((_resolve, reject) => {
        pendingReject = reject;
      });
    },
    steer(_input: PiSteerInput): Promise<void> {
      void _input;
      return Promise.resolve();
    },
    abort(): Promise<void> {
      aborts += 1;
      const reject = pendingReject;
      pendingReject = null;
      if (reject !== null) {
        reject(new TreeAIRuntimeError("user-abort", "the in-flight prompt was aborted by the host"));
      }
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
  } as PiRuntime & { readonly prompts: string[]; readonly aborts: number };
}

/* ------------------------------------------------------------------ */
/* 纯函数面：提示词 / 解析 / 校验 / 排除带                                */
/* ------------------------------------------------------------------ */

test("terminology pure helpers: prompts carry the passage and UTF-16 offsets; candidates are validated against the source (slice equality, dedup, density, code/URL exclusion)", () => {
  const source = "The entropy 🔥 of `npm ci` rises. See https://example.com/docs for entropy details.";
  const explainPrompt = buildExplainPrompt(source, { start: 4, end: 11, text: "entropy" });
  assert.ok(explainPrompt.includes("[Passage]"), "the explain prompt embeds the passage");
  assert.ok(explainPrompt.includes('"entropy" (character offsets 4..11'), "the marked span carries its UTF-16 offsets");
  const extractPrompt = buildExtractPrompt(source, 8);
  assert.ok(extractPrompt.includes("JSON array"), "the extract prompt demands a JSON array");
  assert.ok(extractPrompt.includes("[Passage]"));

  /* 解析：首个平衡 JSON 数组（前后噪声容忍）。 */
  const raw = parseCandidates('Sure! [{"term":"entropy","start":4,"end":11},{"term":"entropy","start":60,"end":67}] hope that helps');
  assert.ok(raw !== null);
  assert.equal(raw.length, 2);
  assert.equal(parseCandidates("no json here"), null);

  /* 校验：切片全等（第二个条目偏移错位 → 剔除）、去重、密度上限。 */
  const validated = validateCandidates(source, raw, 8);
  assert.equal(validated.length, 1, "the slice-mismatched duplicate is dropped");
  assert.deepEqual(validated[0], { term: "entropy", start: 4, end: 11 });
  const many = Array.from({ length: 20 }, (_, i) => ({
    term: `term${String(i)}`,
    start: source.indexOf(`term${String(i)}`),
    end: -1,
  }));
  assert.equal(validateCandidates(source, many, 8).length, 0, "bounds-checked: fabricated spans are dropped");

  /* URL / 反引号围栏排除带。 */
  const spans = excludedSpans(source);
  assert.ok(spans.some((s) => source.slice(s.start, s.end).startsWith("https://")), "URL spans are excluded");
  assert.ok(spans.some((s) => source.slice(s.start, s.end).includes("npm ci")), "backtick-fenced spans are excluded");
  const inUrl = [{ term: "example", start: source.indexOf("example.com"), end: source.indexOf("example.com") + "example".length }];
  assert.equal(validateCandidates(source, inUrl, 8).length, 0, "candidates inside a URL are excluded");
  const inCode = [{ term: "npm ci", start: source.indexOf("npm ci"), end: source.indexOf("npm ci") + 6 }];
  assert.equal(validateCandidates(source, inCode, 8).length, 0, "candidates inside code fences are excluded");

  /* sourceHash：全文指纹。 */
  assert.equal(hashSourceText("abc").length, 64);
  assert.notEqual(hashSourceText("abc"), hashSourceText("abd"));
});

/* ------------------------------------------------------------------ */
/* 隔离 + explain 生命周期                                               */
/* ------------------------------------------------------------------ */

test("terminology explain is isolated: zero tree writes, zero main session files, main cursor untouched; echo task succeeds with the prompt as context", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeTerminologyStudio(dir);
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const mainSessionsBefore = readdirSync(join(dir, "sessions"));
    assert.equal(mainSessionsBefore.length, 1, "one main session file from the trunk prompt");
    const cursorBefore = studio.service.getTreeState(treeId).cursor;
    const turnsBefore = findBranchView(studio.service.getTreeState(treeId), trunkId).turns.length;

    /* 解释 10 次（issue #7 C ②「关闭 10 次零正式事实」的机械面：每次都是
       瞬态任务，不落任何树事实；第 2 次起命中缓存零请求）。 */
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    for (let i = 0; i < 10; i += 1) {
      const outcome = await studio.terminology.explain({
        treeId,
        branchId: trunkId,
        anchorTurnId: answer.id,
        selection,
        mode: "term",
      });
      assert.equal(outcome.annotation, null, "no saved annotation exists yet");
      assert.ok(outcome.task !== null);
      assert.equal(outcome.task.state.kind, "succeeded");
      if (outcome.task.state.kind !== "succeeded") throw new Error("unreachable");
      assert.ok(outcome.task.state.explanation !== null);
      assert.ok(
        outcome.task.state.explanation!.includes(selection.text),
        "the echo answer carries the marked span (deterministic offline)",
      );
    }

    /* 隔离不变量：主 session 目录零新文件；主游标不动；树 turns 零新增；
       术语 session 在独立目录。 */
    assert.deepEqual(
      readdirSync(join(dir, "sessions")),
      mainSessionsBefore,
      "explain never touches the main session directory",
    );
    assert.deepEqual(studio.service.getTreeState(treeId).cursor, cursorBefore, "the main cursor is untouched");
    assert.equal(
      findBranchView(studio.service.getTreeState(treeId), trunkId).turns.length,
      turnsBefore,
      "explain persists no tree turns",
    );
    const terminologySessions = readdirSync(join(dir, "terminology", "sessions"));
    assert.equal(terminologySessions.length, 1, "exactly one terminology session file (10 explains, 9 cache hits)");
    /* 用量：1 次请求（缓存命中零计）+ 字符数精确。 */
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 1, "9 of the 10 explains were cache hits");
    assert.equal(usage.lateResultsDiscarded, 0);
    assert.equal(
      studio.executor.listTasks().filter((task) => task.treeId === treeId).length,
      10,
      "all ten tasks are visible in the task read model",
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology explain dedups against a saved annotation (zero model calls) and enforces UTF-16 slice integrity (emoji / cross-line / duplicate words)", async () => {
  const dir = makeTempDataDir();
  try {
    /* emoji + 跨行 + 重复词的答案：echo 回答 = echo:[q1]，改造不便——直接
       用脚本化主 runtime 产出可控答案。 */
    const scriptedAnswer = "Delta 🔥 is a measure. Delta appears twice.\nSecond line mentions entropy across\nlines.";
    const mainRuntime = scriptedTerminologyRuntime({ answerFor: () => scriptedAnswer });
    const studio = makeTerminologyStudio(dir, { mainRuntime });
    const { treeId, trunkId } = await makeTreeWithAnswer(studio);
    const answerTurn = findBranchView(studio.service.getTreeState(treeId), trunkId).turns.find(
      (t: { role: string }) => t.role === "assistant",
    )!;
    assert.equal(answerTurn.text, scriptedAnswer);

    const emojiStart = scriptedAnswer.indexOf("🔥");
    const selection = { start: emojiStart - 6, end: emojiStart + 2, text: scriptedAnswer.slice(emojiStart - 6, emojiStart + 2) };
    assert.equal(selection.text, "Delta 🔥", "UTF-16 offsets select across a surrogate pair");

    const explain = await studio.terminology.explain({
      treeId,
      branchId: trunkId,
      anchorTurnId: answerTurn.id,
      selection,
      mode: "term",
    });
    assert.equal(explain.task?.state.kind, "succeeded");

    /* 保存批注后：同选区 explain → 去重命中，零模型调用。 */
    const saved = studio.terminology.saveAnnotation({
      treeId,
      branchId: trunkId,
      anchorTurnId: answerTurn.id,
      selection,
      mode: "term",
      term: selection.text,
      explanation: "Saved explanation.",
    });
    assert.equal(saved.created, true);
    const usageBefore = studio.executor.usage().total.requests;
    const dedup = await studio.terminology.explain({
      treeId,
      branchId: trunkId,
      anchorTurnId: answerTurn.id,
      selection,
      mode: "term",
    });
    assert.ok(dedup.annotation !== null, "the saved annotation is returned without a model call");
    assert.equal(dedup.annotation.id, saved.annotation.id);
    assert.equal(dedup.task, null);
    assert.equal(studio.executor.usage().total.requests, usageBefore, "zero model calls on the dedup hit");

    /* 切片完整性：偏移错位 / 越界 / 文本不符 → 400（绝不假定位）。 */
    await assert.rejects(
      () =>
        studio.terminology.explain({
          treeId,
          branchId: trunkId,
          anchorTurnId: answerTurn.id,
          selection: { start: 0, end: 5, text: "XXXXX" },
          mode: "term",
        }),
      InvalidArgumentError,
    );
    assert.throws(
      () =>
        studio.terminology.saveAnnotation({
          treeId,
          branchId: trunkId,
          anchorTurnId: answerTurn.id,
          selection: { start: 0, end: 99999, text: scriptedAnswer },
          mode: "range",
          term: "x",
          explanation: "y",
        }),
      InvalidArgumentError,
    );
    /* 重复词第二处：绝对偏移消歧（第二个 "Delta"）。 */
    const secondDelta = scriptedAnswer.indexOf("Delta", scriptedAnswer.indexOf("Delta") + 1);
    const second = await studio.terminology.explain({
      treeId,
      branchId: trunkId,
      anchorTurnId: answerTurn.id,
      selection: { start: secondDelta, end: secondDelta + 5, text: "Delta" },
      mode: "term",
    });
    assert.ok(second.task !== null && second.task.selection !== null);
    assert.equal(second.task.selection.start, secondDelta, "the second occurrence is anchored by offset, not search");
    /* 跨行选区。 */
    const entropyAt = scriptedAnswer.indexOf("entropy");
    const crossLine = await studio.terminology.explain({
      treeId,
      branchId: trunkId,
      anchorTurnId: answerTurn.id,
      selection: { start: entropyAt, end: entropyAt + 16, text: scriptedAnswer.slice(entropyAt, entropyAt + 16) },
      mode: "range",
    });
    assert.ok(crossLine.task !== null && crossLine.task.selection !== null);
    assert.ok(crossLine.task.selection.text.includes("\n"), "cross-line selections are anchored intact");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 保存（去重）+ 幂等推广                                                */
/* ------------------------------------------------------------------ */

test("terminology save dedups by range; promotion reuses the Anchor/Branch/Origin machinery, dispatches the first question with composed context, and is idempotent across replays and conflicts", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeTerminologyStudio(dir);
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };

    /* 保存 → 201 语义（created true）；同选区再存 → 既有批注（created
       false，零写入）。 */
    const saved = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "Entropy measures uncertainty.",
    });
    assert.equal(saved.created, true);
    assert.equal(saved.annotation.promotedBranchId, null);
    const again = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "A different text that must not overwrite",
    });
    assert.equal(again.created, false);
    assert.equal(again.annotation.id, saved.annotation.id);
    assert.equal(again.annotation.explanation, saved.annotation.explanation, "the dedup replay never overwrites");

    /* 推广：建枝（Anchor/Branch/Origin 复用）+ 首问派发（组合上下文 +
       turn 标记）。 */
    const promotion = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-key-1",
      firstQuestion: "How does this term relate to the passage?",
    });
    assert.equal(promotion.created, true);
    assert.ok(promotion.outcome !== null, "the first question is dispatched and succeeds");
    assert.equal(promotion.outcome!.run.state, "succeeded");
    const promotedBranchId = promotion.branch.id;
    const promotedView = findBranchView(studio.service.getTreeState(treeId), promotedBranchId);
    assert.ok(promotedView.origin !== null, "the promoted branch is anchored via the reused origin machinery");
    assert.deepEqual(promotedView.origin.selection, selection);
    assert.equal(promotedView.turns.length, 2, "first question + answer are on the new branch");
    assert.ok(promotedView.turns[0]!.text.startsWith(TERMINOLOGY_PROMOTION_TURN_PREFIX), "the user turn carries the explicit follow-up marker");
    assert.ok(promotedView.turns[0]!.text.includes("How does this term relate to the passage?"));
    /* 组合上下文进入模型输入（echo 回声含解释与摘录）。 */
    assert.ok(promotion.outcome!.assistantTurn.text.includes("Entropy measures uncertainty."), "the explanation is carried into the model context");
    assert.ok(promotion.outcome!.assistantTurn.text.includes(selection.text), "the source excerpt is carried in");

    /* 同键重放：不重建枝、不重复派发（turns 不变，created false）。 */
    const replay = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-key-1",
      firstQuestion: "How does this term relate to the passage?",
    });
    assert.equal(replay.created, false);
    assert.equal(replay.branch.id, promotedBranchId);
    assert.equal(replay.outcome, null, "the already-dispatched first question is not re-sent");
    assert.equal(
      findBranchView(studio.service.getTreeState(treeId), promotedBranchId).turns.length,
      2,
      "no duplicate turns after the replay",
    );
    assert.equal(studio.repository.listBranches(treeId).length, 2, "exactly one trunk + one promoted branch");

    /* 异键：409 冲突（一个批注至多推广一次；明确另开 = 新批注）。 */
    await assert.rejects(
      () =>
        studio.terminology.promote({
          treeId,
          annotationId: saved.annotation.id,
          idempotencyKey: "promo-key-2",
          firstQuestion: "another follow-up",
        }),
      TerminologyPromotionConflictError,
    );

    /* 同词不同语境（不同选区 → 不同批注）→ 各自推广，互不复用。 */
    const otherSelection = { start: 6, end: 9, text: answer.text.slice(6, 9) };
    const other = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection: otherSelection, mode: "range",
      term: otherSelection.text, explanation: "Another context, another annotation.",
    });
    assert.equal(other.created, true);
    const otherPromotion = await studio.terminology.promote({
      treeId,
      annotationId: other.annotation.id,
      idempotencyKey: "promo-key-other",
      firstQuestion: "Second follow-up",
    });
    assert.equal(otherPromotion.created, true);
    assert.notEqual(otherPromotion.branch.id, promotedBranchId, "same word, different context promotes to its own branch");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("promotion survives a failed first question: the binding and dispatch ledger are durable, and the same-key retry re-dispatches the SAME question without rebuilding the branch", async () => {
  const dir = makeTempDataDir();
  try {
    const FAILURE_SENTINEL = "TRIGGER-UPSTREAM-FAILURE";
    const echoRuntime = createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(dir, "workspace"),
    });
    /* 首问只失败一次（首次派发注入失败，重试经同一 runtime 成功）——
       重试携带同一问题文本（P0-3：同键异问 → 409，不再是静默换问）。 */
    let sentinelFailures = 0;
    const mainRuntime: PiRuntime = {
      get piVersion() {
        return echoRuntime.piVersion;
      },
      createSession: (init) => echoRuntime.createSession(init),
      restoreSession: (reference) => echoRuntime.restoreSession(reference),
      prompt: (input) => {
        if (input.text.includes(FAILURE_SENTINEL)) {
          sentinelFailures += 1;
          if (sentinelFailures === 1) {
            return Promise.reject(classifyPiFailure(new Error(ECHO_FAILURE_MESSAGE), "Pi run failed"));
          }
        }
        return echoRuntime.prompt(input);
      },
      steer: (input) => echoRuntime.steer(input),
      abort: () => echoRuntime.abort(),
      navigateTree: (target) => echoRuntime.navigateTree(target),
      subscribe: (listener) => echoRuntime.subscribe(listener),
      dispose: () => echoRuntime.dispose(),
    };
    const studio = makeTerminologyStudio(dir, { mainRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const saved = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "Explained.",
    });
    const question = `${FAILURE_SENTINEL} the first dispatch of this exact question will fail once`;

    /* 首问注入失败：分支/绑定/账本已是事实（单事务），firstQuestionError
       如实分离，账本结算 failed（可重试）。 */
    const failed = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-retry",
      firstQuestion: question,
    });
    assert.equal(failed.created, true);
    assert.equal(failed.outcome, null, "the failed first question persists no turns");
    assert.ok(failed.firstQuestionError !== null);
    assert.equal(failed.firstQuestionError.code, "upstream");
    assert.equal(failed.dispatch, "failed");
    const promotedBranchId = failed.branch.id;
    assert.equal(findBranchView(studio.service.getTreeState(treeId), promotedBranchId).turns.length, 0);
    const ledgerAfterFailure = studio.repository.findTerminologyDispatchByAnnotation(saved.annotation.id);
    assert.ok(ledgerAfterFailure !== null);
    assert.equal(ledgerAfterFailure.dispatchState, "failed");
    assert.equal(ledgerAfterFailure.attempts, 1);
    assert.equal(ledgerAfterFailure.failure?.code, "upstream");

    /* 同键异问 → 409（首问身份不可变；绝不静默换问重发）。 */
    await assert.rejects(
      () =>
        studio.terminology.promote({
          treeId,
          annotationId: saved.annotation.id,
          idempotencyKey: "promo-retry",
          firstQuestion: "a different question under the same key must conflict",
        }),
      TerminologyPromotionConflictError,
    );

    /* 失败后同键**同问**重试：不重建枝，重新派发（这次成功）。 */
    const retried = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-retry",
      firstQuestion: question,
    });
    assert.equal(retried.created, false);
    assert.equal(retried.dispatch, "succeeded");
    assert.equal(retried.branch.id, promotedBranchId, "the same branch is reused (no rebuild)");
    assert.ok(retried.outcome !== null, "the re-dispatched first question succeeds");
    const view = findBranchView(studio.service.getTreeState(treeId), promotedBranchId);
    assert.equal(view.turns.length, 2);
    assert.ok(view.turns[0]!.text.includes(question));
    assert.equal(studio.repository.listBranches(treeId).length, 2, "still exactly one promoted branch");
    const ledgerAfterRetry = studio.repository.findTerminologyDispatchByAnnotation(saved.annotation.id);
    assert.equal(ledgerAfterRetry?.dispatchState, "succeeded");
    assert.equal(ledgerAfterRetry?.attempts, 2, "attempts counts every real dispatch (the failed one included)");
    assert.equal(ledgerAfterRetry?.runId, retried.outcome!.run.id, "the ledger carries the succeeded run reference");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 取消 + 迟到结果 / 预算 / 缓存偏好 / auto 提取                          */
/* ------------------------------------------------------------------ */

test("terminology cancel: queued cancels immediately; a late result after a running cancel is discarded (usage still recorded — honest cost)", async () => {
  const dir = makeTempDataDir();
  try {
    const runtime = scriptedTerminologyRuntime({ delayMs: 60, ignoreAbort: true });
    const studio = makeTerminologyStudio(dir, { terminologyRuntime: runtime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };

    /* running 中取消：任务标记取消；resolve 后迟到结果被丢弃。 */
    const inFlight: Promise<{ task: TerminologyTask | null; annotation: unknown }> = studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const tasks = studio.executor.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.state.kind, "running");
    studio.executor.cancel(tasks[0]!.id);
    const cancelledTask = studio.executor.findTask(tasks[0]!.id);
    assert.ok(cancelledTask !== null && cancelledTask.state.kind === "cancelled", "the task reports cancelled while the runtime call is still in flight");
    const settled = await inFlight;
    assert.ok(settled.task !== null);
    assert.equal(settled.task.state.kind, "cancelled");
    if (settled.task.state.kind !== "cancelled") throw new Error("unreachable");
    assert.equal(settled.task.state.lateResultDiscarded, true, "the late result was discarded, not used");
    /* 诚实成本：请求已发生 → 用量照记（requests 1，真实 completion），迟到计数 1。 */
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 1);
    assert.equal(usage.lateResultsDiscarded, 1);
    assert.equal(usage.unknownCostRequests, 0, "the late result COMPLETED — real usage, not unknown cost");
    assert.equal(usage.total.completionChars, runtime.prompts[0]!.length, "completion chars are the real answer length");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology cache key carries source identity, position and context: the same word at two semantic positions is explained separately (bank repro + 中文 + repeated word), and only the same anchor reuses", async () => {
  const dir = makeTempDataDir();
  try {
    /* 验收复现：同一句话里的两个 "bank"（河岸 / 银行）——第二处必须独立
       调用（旧键只看词 + 全文指纹，第二处 cached=true 返回第一处解释）。 */
    const answer = "bank is a river edge; bank is a financial institution.";
    const secondBank = answer.indexOf("bank", 1);
    assert.equal(secondBank, 22, "fixture: the second 'bank' starts at offset 22");
    const mainRuntime = scriptedTerminologyRuntime({ answerFor: () => answer });
    const termRuntime = scriptedTerminologyRuntime({});
    const studio = makeTerminologyStudio(dir, { mainRuntime, terminologyRuntime: termRuntime });
    const { treeId, trunkId } = await makeTreeWithAnswer(studio);
    const answerTurn = findBranchView(studio.service.getTreeState(treeId), trunkId).turns.find(
      (t: { role: string }) => t.role === "assistant",
    )!;

    const first = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answerTurn.id,
      selection: { start: 0, end: 4, text: "bank" }, mode: "term",
    });
    assert.ok(first.task !== null && first.task.state.kind === "succeeded" && !first.task.state.cached);
    const second = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answerTurn.id,
      selection: { start: secondBank, end: secondBank + 4, text: "bank" }, mode: "term",
    });
    assert.ok(second.task !== null && second.task.state.kind === "succeeded");
    assert.equal(second.task.state.cached, false, "the same word at a DIFFERENT position is a separate call, never a cache hit");
    assert.equal(termRuntime.prompts.length, 2, "two model calls — one per semantic position");
    assert.notEqual(first.task.state.explanation, second.task.state.explanation, "the two positions get their own explanations");
    assert.ok(first.task.state.explanation!.includes("offsets 0..4"));
    assert.ok(second.task.state.explanation!.includes(`offsets ${String(secondBank)}..${String(secondBank + 4)}`));

    /* 同锚点同选区：复用（cache hit，零新请求）。 */
    const firstAgain = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answerTurn.id,
      selection: { start: 0, end: 4, text: "bank" }, mode: "term",
    });
    assert.ok(firstAgain.task !== null && firstAgain.task.state.kind === "succeeded" && firstAgain.task.state.cached);
    assert.equal(firstAgain.task.state.explanation, first.task.state.explanation);
    assert.equal(termRuntime.prompts.length, 2);

    /* 中文同词不同位置：两个「苹果」（水果 / 公司）各自调用。 */
    const zhAnswer = "苹果是一种水果。苹果公司发布了新的手机。";
    const zhSecond = zhAnswer.indexOf("苹果", 1);
    const zhStudio = makeTerminologyStudio(dir, {
      mainRuntime: scriptedTerminologyRuntime({ answerFor: () => zhAnswer }),
      terminologyRuntime: scriptedTerminologyRuntime({}),
    });
    const zhTree = await makeTreeWithAnswer(zhStudio);
    const zhAnswerTurn = findBranchView(zhStudio.service.getTreeState(zhTree.treeId), zhTree.trunkId).turns.find(
      (t: { role: string }) => t.role === "assistant",
    )!;
    const zhFirst = await zhStudio.terminology.explain({
      treeId: zhTree.treeId, branchId: zhTree.trunkId, anchorTurnId: zhAnswerTurn.id,
      selection: { start: 0, end: 2, text: "苹果" }, mode: "term",
    });
    const zhSecondExplain = await zhStudio.terminology.explain({
      treeId: zhTree.treeId, branchId: zhTree.trunkId, anchorTurnId: zhAnswerTurn.id,
      selection: { start: zhSecond, end: zhSecond + 2, text: "苹果" }, mode: "term",
    });
    assert.ok(zhFirst.task !== null && zhFirst.task.state.kind === "succeeded" && !zhFirst.task.state.cached);
    assert.ok(zhSecondExplain.task !== null && zhSecondExplain.task.state.kind === "succeeded");
    assert.equal(zhSecondExplain.task.state.cached, false, "中文同词不同位置也是独立调用");
    assert.notEqual(zhFirst.task.state.explanation, zhSecondExplain.task.state.explanation);

    /* 重复词三连：每个位置各自调用（绝不共享第一处的解释）。 */
    const repAnswer = "delta delta delta";
    const repStudio = makeTerminologyStudio(dir, {
      mainRuntime: scriptedTerminologyRuntime({ answerFor: () => repAnswer }),
      terminologyRuntime: scriptedTerminologyRuntime({}),
    });
    const repTree = await makeTreeWithAnswer(repStudio);
    const repAnswerTurn = findBranchView(repStudio.service.getTreeState(repTree.treeId), repTree.trunkId).turns.find(
      (t: { role: string }) => t.role === "assistant",
    )!;
    const repRuntime = repStudio.terminologyEchoPort; // unused; prompts counted below via usage
    void repRuntime;
    const explanations: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const at = repAnswer.indexOf("delta", i * 6);
      const outcome = await repStudio.terminology.explain({
        treeId: repTree.treeId, branchId: repTree.trunkId, anchorTurnId: repAnswerTurn.id,
        selection: { start: at, end: at + 5, text: "delta" }, mode: "term",
      });
      assert.ok(outcome.task !== null && outcome.task.state.kind === "succeeded" && !outcome.task.state.cached);
      explanations.push(outcome.task.state.explanation!);
    }
    assert.equal(repStudio.executor.usage().total.requests, 3, "three repeated words → three dispatches");
    assert.equal(new Set(explanations).size, 3, "each position carries its own offsets in the explanation");
    await studio.shutdown();
    await zhStudio.shutdown();
    await repStudio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology cancel accounting: a dispatched request that is aborted keeps its reservation and records UNKNOWN usage (requests >= 1, never zeroed); a timeout likewise; a dirty restart and a failing persistence fail-closed with zero dispatch", async () => {
  const dir = makeTempDataDir();
  try {
    /* 取消在途 prompt（user-abort）：请求已发 → 预留保留、未知成本单列。 */
    const abortRuntime = abortableTerminologyRuntime({});
    const studio = makeTerminologyStudio(dir, { terminologyRuntime: abortRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const inFlight = studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const tasks = studio.executor.listTasks();
    assert.equal(tasks[0]!.state.kind, "running");
    studio.executor.cancel(tasks[0]!.id);
    const settled = await inFlight;
    assert.ok(settled.task !== null && settled.task.state.kind === "cancelled");
    assert.equal(abortRuntime.prompts.length, 1, "the prompt WAS dispatched before the abort");
    /* 验收复现（旧实现此处 requests=0、estTokens=0 被静默清零）。 */
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 1, "an aborted in-flight request is never zeroed");
    assert.ok(usage.total.promptChars > 0);
    assert.ok(usage.estTokens > 0, "the reservation is kept (conservative completion bound counted)");
    assert.equal(usage.unknownCostRequests, 1, "the unknown cost is tracked separately");
    assert.equal(usage.byPurpose.explain.unknownRequests, 1, "the explain bucket carries the unknown request count");
    /* kv 落盘的是同一口径（重启可见），且 dirty 已结算为 false。 */
    const persisted = studio.repository.getTerminologyState("usage");
    assert.ok(persisted !== null);
    const parsed = normalizeExecutorUsage(JSON.parse(persisted));
    assert.equal(parsed?.unknownCostRequests, 1);
    assert.equal(parsed?.dirty, false);
    await studio.shutdown();

    /* 超时（timeout）：已发请求、结果未知 → 同样保留预留、单列未知成本。 */
    const timeoutRuntime = abortableTerminologyRuntime({
      rejectWith: () => new TreeAIRuntimeError("timeout", "the request timed out"),
    });
    const studio2 = makeTerminologyStudio(dir, {
      terminologyRuntime: timeoutRuntime,
      persistedUsage: persisted!,
    });
    const timedOut = await studio2.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id,
      selection: { start: 1, end: 4, text: answer.text.slice(1, 4) }, mode: "term",
    });
    assert.ok(timedOut.task !== null && timedOut.task.state.kind === "failed");
    if (timedOut.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(timedOut.task.state.code, "timeout");
    const usage2 = studio2.executor.usage();
    assert.equal(usage2.total.requests, 2, "the timed-out request is accounted (resumed from the persisted abort + this one)");
    assert.equal(usage2.unknownCostRequests, 2, "timeout cost is unknown, tracked separately");
    await studio2.shutdown();

    /* 记账落盘失败（结算写失败）：本次任务仍完成（内存为准），但后续新
       派发 fail-closed——绝不静默重启清账。 */
    const studio3 = makeTerminologyStudio(dir, {
      terminologyRuntime: scriptedTerminologyRuntime({}),
      usagePersistFailsFromCall: 2, // 1=派发前 dirty（成功），2=结算写（失败）
    });
    const { treeId: treeId3, trunkId: trunkId3, answer: answer3 } = await makeTreeWithAnswer(studio3);
    const sel3 = { start: 0, end: 5, text: answer3.text.slice(0, 5) };
    const first = await studio3.terminology.explain({
      treeId: treeId3, branchId: trunkId3, anchorTurnId: answer3.id, selection: sel3, mode: "term",
    });
    assert.equal(first.task?.state.kind, "succeeded", "the settled task itself succeeds (in-memory accounting)");
    assert.equal(studio3.executor.usage().total.requests, 1);
    const second = await studio3.terminology.explain({
      treeId: treeId3, branchId: trunkId3, anchorTurnId: answer3.id,
      selection: { start: 1, end: 4, text: answer3.text.slice(1, 4) }, mode: "term",
    });
    assert.ok(second.task !== null && second.task.state.kind === "failed");
    if (second.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(second.task.state.code, USAGE_ACCOUNTING_UNAVAILABLE, "a failing persistence fail-closes new dispatches");
    assert.equal(studio3.executor.usage().total.requests, 1, "no new request after the accounting became untrusted");
    await studio3.shutdown();

    /* 重启遇 dirty 持久标记（上次进程派发中途退出）：新派发 fail-closed。 */
    const dirtyUsage = JSON.stringify({
      total: { requests: 3, promptChars: 900, completionChars: 100 },
      lateResultsDiscarded: 0,
      unknownCostRequests: 1,
      buckets: {},
      dirty: true,
    });
    const studio4 = makeTerminologyStudio(dir, {
      terminologyRuntime: scriptedTerminologyRuntime({}),
      persistedUsage: dirtyUsage,
      budgetTokens: 1_000_000,
    });
    const { treeId: treeId4, trunkId: trunkId4, answer: answer4 } = await makeTreeWithAnswer(studio4);
    const afterCrash = await studio4.terminology.explain({
      treeId: treeId4, branchId: trunkId4, anchorTurnId: answer4.id,
      selection: { start: 0, end: 5, text: answer4.text.slice(0, 5) }, mode: "term",
    });
    assert.ok(afterCrash.task !== null && afterCrash.task.state.kind === "failed");
    if (afterCrash.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(afterCrash.task.state.code, USAGE_ACCOUNTING_UNAVAILABLE, "a dirty restart fail-closes new dispatches (no silent restart of the accounting)");
    assert.equal(afterCrash.task.state.message.includes("accounting"), true);
    assert.equal(studio4.executor.usage().total.requests, 3, "the persisted counts are resumed as-is (not reset)");
    await studio4.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology budget reserves input+output bounds before dispatch: an insufficient budget means ZERO dispatch (budgetTokens=1), usage settles by real completion, and the persisted state resumes across restarts", async () => {
  const dir = makeTempDataDir();
  try {
    /* 验收复现：budgetTokens=1、已用 0——预留（输入+输出上界）远超额度
       → 零派发（旧实现只查「过去已用 ≥ 额度」，照发不误）。 */
    const runtime = scriptedTerminologyRuntime({});
    const studio = makeTerminologyStudio(dir, { budgetTokens: 1, terminologyRuntime: runtime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const blocked = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    assert.ok(blocked.task !== null && blocked.task.state.kind === "failed");
    if (blocked.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(blocked.task.state.code, "budget-exceeded");
    assert.ok(
      blocked.task.state.message.includes("zero dispatch") || blocked.task.state.message.includes("Zero dispatch"),
      "the failure message states the zero-dispatch reason clearly",
    );
    assert.equal(runtime.prompts.length, 0, "no request was dispatched at all (budget reserved before dispatch)");
    assert.equal(studio.executor.usage().total.requests, 0);
    assert.equal(studio.executor.usage().estTokens, 0);
    assert.equal(studio.repository.getTerminologyState("usage"), null, "zero dispatches persist no usage");
    await studio.shutdown();

    /* 充足预算：按真实 usage 结算（completion = 真实回声长度，不是预留
       的 4000 字符上界）。 */
    const studioOk = makeTerminologyStudio(dir, { budgetTokens: 100_000 });
    const { treeId: treeId2, trunkId: trunkId2, answer: answer2 } = await makeTreeWithAnswer(studioOk);
    const sel2 = { start: 0, end: 5, text: answer2.text.slice(0, 5) };
    const ok = await studioOk.terminology.explain({
      treeId: treeId2, branchId: trunkId2, anchorTurnId: answer2.id, selection: sel2, mode: "term",
    });
    assert.equal(ok.task?.state.kind, "succeeded");
    const usageAfter = studioOk.executor.usage();
    assert.equal(usageAfter.total.requests, 1);
    const expectedPrompt = buildExplainPrompt(answer2.text, sel2).length;
    assert.equal(usageAfter.total.promptChars, expectedPrompt, "prompt chars are the real dispatched prompt length");
    const echoAnswerLength = expectedPrompt + 7; // echo:[<prompt>]
    assert.equal(usageAfter.total.completionChars, echoAnswerLength, "the reservation's output bound was settled by the REAL completion length");
    assert.equal(usageAfter.estTokens, Math.ceil((expectedPrompt + echoAnswerLength) / 4));
    assert.equal(usageAfter.byPurpose.explain.requests, 1, "usage is bucketed by purpose (explain)");
    assert.equal(usageAfter.byPurpose.extract.requests, 0);
    assert.equal(usageAfter.today.requests, 1, "usage is bucketed per day");
    assert.equal(usageAfter.monthToDate.requests, 1, "usage is bucketed per month");
    assert.equal(usageAfter.unknownCostRequests, 0);

    /* 换一个选区（避开缓存）：预算恰为已用量 → 预留判负 fail-closed。 */
    const spent = studioOk.executor.usage().estTokens;
    const persisted = studioOk.repository.getTerminologyState("usage");
    assert.ok(persisted !== null);
    await studioOk.shutdown();
    const studioTight = makeTerminologyStudio(dir, { budgetTokens: spent, persistedUsage: persisted! });
    const second = await studioTight.terminology.explain({
      treeId: treeId2, branchId: trunkId2, anchorTurnId: answer2.id,
      selection: { start: 1, end: 4, text: answer2.text.slice(1, 4) }, mode: "term",
    });
    assert.ok(second.task !== null && second.task.state.kind === "failed");
    if (second.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(second.task.state.code, "budget-exceeded", "a fresh request cannot fit even at the reservation bound");
    assert.equal(studioTight.executor.usage().total.requests, 1, "the persisted request count is resumed, and no new request is made while over budget");
    await studioTight.shutdown();

    /* 缓存偏好：关闭后同键重打（新请求）；重开后又命中。 */
    const studio3 = makeTerminologyStudio(dir, { budgetTokens: 1_000_000 });
    const a = await studio3.terminology.explain({
      treeId: treeId2, branchId: trunkId2, anchorTurnId: answer2.id, selection: sel2, mode: "term",
    });
    assert.ok(a.task !== null && a.task.state.kind === "succeeded" && !a.task.state.cached);
    const b = await studio3.terminology.explain({
      treeId: treeId2, branchId: trunkId2, anchorTurnId: answer2.id, selection: sel2, mode: "term",
    });
    assert.ok(b.task !== null && b.task.state.kind === "succeeded" && b.task.state.cached, "same key hits the cache");
    studio3.terminology.setCachePreference(false);
    assert.equal(studio3.executor.cacheEnabled, false);
    const c = await studio3.terminology.explain({
      treeId: treeId2, branchId: trunkId2, anchorTurnId: answer2.id, selection: sel2, mode: "term",
    });
    assert.ok(c.task !== null && c.task.state.kind === "succeeded" && !c.task.state.cached, "cache disabled re-requests");
    assert.equal(studio3.executor.usage().total.requests, 2);
    await studio3.shutdown();
    void studio;
  } finally {
    cleanupDir(dir);
  }
});

test("terminology context discipline: explain windows oversized passages honestly (remapped offsets) and refuses unbounded stuffing; extract refuses oversized sources with zero dispatch", async () => {
  const dir = makeTempDataDir();
  try {
    /* 30k 答案 + 中位选区：explain 取 8k+8k 窗口（截断如实标注，偏移重映射）。 */
    const longAnswer = `${"A".repeat(15_000)} signal ${"B".repeat(15_000)}`;
    const termAt = longAnswer.indexOf("signal");
    const mainRuntime = scriptedTerminologyRuntime({ answerFor: () => longAnswer });
    const termRuntime = scriptedTerminologyRuntime({});
    const studio = makeTerminologyStudio(dir, { mainRuntime, terminologyRuntime: termRuntime });
    const { treeId, trunkId } = await makeTreeWithAnswer(studio);
    const answerTurn = findBranchView(studio.service.getTreeState(treeId), trunkId).turns.find(
      (t: { role: string }) => t.role === "assistant",
    )!;
    assert.equal(answerTurn.text, longAnswer);

    const selection = { start: termAt, end: termAt + "signal".length, text: "signal" };
    const windowed = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answerTurn.id, selection, mode: "term",
    });
    assert.equal(windowed.task?.state.kind, "succeeded", "an oversized passage is windowed, not refused");
    assert.equal(termRuntime.prompts.length, 1);
    const sent = termRuntime.prompts[0]!;
    assert.ok(sent.includes("[Passage truncated:"), "the prompt honestly marks the truncation");
    assert.ok(!sent.includes("A".repeat(8_000)), "the A-run is cut at the 8k window edge");
    assert.ok(!sent.includes("B".repeat(8_000)), "the B-run is cut at the 8k window edge");
    assert.ok(sent.length < longAnswer.length, "the prompt stays bounded");
    const windowStart = termAt - 8_000;
    const expectedRemapped = `(character offsets ${String(termAt - windowStart)}..${String(termAt - windowStart + "signal".length)} in the passage)`;
    assert.ok(sent.includes(expectedRemapped), `offsets are remapped into the window: ${expectedRemapped}`);

    /* 超大选区（> MAX_EXPLAIN_SELECTION_CHARS）→ 零派发拒绝。 */
    const hugeSelection = { start: 0, end: 8_001, text: longAnswer.slice(0, 8_001) };
    const tooLarge = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answerTurn.id, selection: hugeSelection, mode: "range",
    });
    assert.ok(tooLarge.task !== null && tooLarge.task.state.kind === "failed");
    if (tooLarge.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(tooLarge.task.state.code, "selection-too-large");
    assert.equal(termRuntime.prompts.length, 1, "still only the windowed dispatch — the oversized selection dispatched nothing");

    /* extract 超限（偏移锚定全文，不截断）→ 零派发拒绝。 */
    const extractTask = await studio.terminology.extract({ treeId, branchId: trunkId, anchorTurnId: answerTurn.id });
    assert.ok(extractTask.state.kind === "failed");
    if (extractTask.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(extractTask.state.code, "source-too-large");
    assert.equal(termRuntime.prompts.length, 1, "the oversized extract dispatched nothing");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology auto extract: validated JSON candidates (slice equality, dedup, density, code/URL exclusion); an unparseable echo answer fails honestly", async () => {
  const dir = makeTempDataDir();
  try {
    const source = "The entropy of `npm ci` matters. See https://example.com/x for more entropy. Latency too.";
    const answerFor = (): string =>
      JSON.stringify([
        { term: "entropy", start: source.indexOf("entropy"), end: source.indexOf("entropy") + 7 },
        { term: "entropy", start: source.lastIndexOf("entropy"), end: source.lastIndexOf("entropy") + 7 },
        { term: "npm ci", start: source.indexOf("npm ci"), end: source.indexOf("npm ci") + 6 },
        { term: "example", start: source.indexOf("example.com"), end: source.indexOf("example.com") + 7 },
        { term: "Latency", start: source.indexOf("Latency"), end: source.indexOf("Latency") + 7 },
        { term: "misplaced", start: 0, end: 9 },
      ]);
    const runtime = scriptedTerminologyRuntime({ answerFor });
    const mainRuntimeScripted = scriptedTerminologyRuntime({ answerFor: () => source });
    const studio = makeTerminologyStudio(dir, { terminologyRuntime: runtime, mainRuntime: mainRuntimeScripted });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    assert.equal(answer.text, source, "the scripted main runtime produced the fixture answer");

    const task = await studio.terminology.extract({ treeId, branchId: trunkId, anchorTurnId: answer.id });
    assert.equal(task.state.kind, "succeeded");
    if (task.state.kind !== "succeeded") throw new Error("unreachable");
    const candidates = task.state.candidates!;
    /* 剔除：重复 entropy（第二个）、代码围栏 npm ci、URL 内 example、
       偏移错位 misplaced；保留首个 entropy + Latency。 */
    assert.deepEqual(
      candidates.map((c) => c.term),
      ["entropy", "Latency"],
    );
    assert.equal(candidates[0]!.start, source.indexOf("entropy"));

    /* auto 结果不落批注（质量门禁未过不开自动保存）。 */
    assert.equal(studio.repository.listTerminologyAnnotations(treeId).length, 0);

    /* echo（非 JSON 回声）→ 诚实 failed(terminology-parse)。 */
    const studio2 = makeTerminologyStudio(dir);
    const t2 = await makeTreeWithAnswer(studio2);
    const echoTask = await studio2.terminology.extract({
      treeId: t2.treeId, branchId: t2.trunkId, anchorTurnId: t2.answer.id,
    });
    assert.ok(echoTask.state.kind === "failed");
    if (echoTask.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(echoTask.state.code, "terminology-parse", "the echo driver's non-JSON answer fails honestly");
    await studio.shutdown();
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 推广原子性（P0-2）+ 首问身份/派发账本（P0-3）                          */
/* ------------------------------------------------------------------ */

/** 数一棵树里带 origin 的分支数（孤儿分支断言用）。 */
function countOrigins(studio: TerminologyStudio, treeId: TreeId): number {
  return studio.repository
    .listBranches(treeId)
    .filter((branch) => studio.repository.findBranchOrigin(branch.id) !== null)
    .length;
}

test("terminology promotion is atomic: a promotion key already held by another annotation is a 409 conflict with ZERO new rows, injected crashes at each write point roll the whole promotion back, and a double-click is idempotent", async () => {
  const dir = makeTempDataDir();
  try {
    const mainRuntime = scriptedTerminologyRuntime({ answerFor: () => "The entropy of a signal rises with noise." });
    const studio = makeTerminologyStudio(dir, { mainRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);

    const saveAt = (start: number, end: number, term: string) =>
      studio.terminology.saveAnnotation({
        treeId, branchId: trunkId, anchorTurnId: answer.id,
        selection: { start, end, text: answer.text.slice(start, end) },
        mode: "term", term, explanation: `Explanation of ${term}.`,
      }).annotation;
    const annotationA = saveAt(0, 5, answer.text.slice(0, 5));
    const annotationB = saveAt(6, 9, answer.text.slice(6, 9));

    /* A 用键 K 推广成功。 */
    const promotedA = await studio.terminology.promote({
      treeId, annotationId: annotationA.id, idempotencyKey: "shared-key", firstQuestion: "question A",
    });
    assert.equal(promotedA.created, true);
    assert.equal(promotedA.dispatch, "succeeded");
    const branchesAfterA = studio.repository.listBranches(treeId).length;
    const originsAfterA = countOrigins(studio, treeId);
    assert.equal(branchesAfterA, 2);

    /* 验收复现：B 用同树同键 K → 409 且零新增行（旧实现先建枝后绑定，
       UNIQUE 异常抛出但 Branch 已从 2 变 3，遗留孤儿分支）。 */
    await assert.rejects(
      () =>
        studio.terminology.promote({
          treeId, annotationId: annotationB.id, idempotencyKey: "shared-key", firstQuestion: "question B",
        }),
      (error: unknown) =>
        error instanceof TerminologyPromotionConflictError && /shared-key/.test(error.message),
    );
    assert.equal(studio.repository.listBranches(treeId).length, branchesAfterA, "no orphan Branch was left behind");
    assert.equal(countOrigins(studio, treeId), originsAfterA, "no orphan BranchOrigin was left behind");
    const bAfter = studio.repository.getTerminologyAnnotation(annotationB.id);
    assert.equal(bAfter.promotedBranchId, null, "annotation B is not bound");
    assert.equal(studio.repository.findTerminologyDispatchByAnnotation(annotationB.id), null, "no dispatch ledger row for B");
    assert.equal(mainRuntime.prompts.length, 2, "q1 + A's first question only — B's conflict dispatched nothing");

    /* 注入崩溃于每个写点（origin / bind / ledger）：整体回滚，零新增行。 */
    const injectionPoints = [
      { method: "setBranchOrigin", label: "crash at the origin write" },
      { method: "bindTerminologyPromotion", label: "crash at the promotion binding write" },
      { method: "createTerminologyDispatch", label: "crash at the dispatch ledger write" },
    ] as const;
    let keySeq = 0;
    for (const point of injectionPoints) {
      const annotationC = saveAt(10, 13, answer.text.slice(10, 13));
      const repo = studio.repository as unknown as Record<string, unknown>;
      const original = (repo[point.method] as (...args: unknown[]) => unknown).bind(studio.repository);
      try {
        repo[point.method] = () => {
          throw new Error(`injected ${point.label}`);
        };
        await assert.rejects(
          () =>
            studio.terminology.promote({
              treeId,
              annotationId: annotationC.id,
              idempotencyKey: `injected-${String((keySeq += 1))}`,
              firstQuestion: "question under injection",
            }),
          (error: unknown) => error instanceof Error && error.message.includes(`injected ${point.label}`),
        );
      } finally {
        repo[point.method] = original;
      }
      assert.equal(
        studio.repository.listBranches(treeId).length,
        branchesAfterA,
        `${point.label}: the whole promotion transaction rolled back (no orphan branch)`,
      );
      assert.equal(countOrigins(studio, treeId), originsAfterA, `${point.label}: no orphan origin`);
      const cAfter = studio.repository.getTerminologyAnnotation(annotationC.id);
      assert.equal(cAfter.promotedBranchId, null, `${point.label}: the annotation is not bound`);
      assert.equal(
        studio.repository.findTerminologyDispatchByAnnotation(annotationC.id),
        null,
        `${point.label}: no ledger row`,
      );
    }

    /* 双击（同一请求重发两次）：幂等——同分支、不重复派发。 */
    const doubleClick = await studio.terminology.promote({
      treeId, annotationId: annotationA.id, idempotencyKey: "shared-key", firstQuestion: "question A",
    });
    assert.equal(doubleClick.created, false);
    assert.equal(doubleClick.dispatch, "succeeded");
    assert.equal(doubleClick.outcome, null, "the landed first question is not re-sent");
    assert.equal(doubleClick.branch.id, promotedA.branch.id);
    assert.equal(mainRuntime.prompts.length, 2, "no additional dispatch for the double-click replay");
    assert.equal(studio.repository.listBranches(treeId).length, branchesAfterA);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology promotion first-question identity: the same key with a different question is a 409 conflict (not a replay); an unknown-result dispatch is reconciled against the ledger evidence and never blind-resent", async () => {
  const dir = makeTempDataDir();
  try {
    const mainRuntime = scriptedTerminologyRuntime({ answerFor: () => "The entropy of a signal rises with noise." });
    const studio = makeTerminologyStudio(dir, { mainRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const saved = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "Explained.",
    });

    /* payload hash 纯函数面：同问同 hash、异问异 hash。 */
    const annotation = saved.annotation;
    assert.equal(
      hashFirstQuestionPayload(annotation, "question A"),
      hashFirstQuestionPayload(annotation, "question A"),
    );
    assert.notEqual(hashFirstQuestionPayload(annotation, "question A"), hashFirstQuestionPayload(annotation, "different question B"));

    /* 首问 "question A" 成功落地。 */
    const promoted = await studio.terminology.promote({
      treeId, annotationId: annotation.id, idempotencyKey: "q-key", firstQuestion: "question A",
    });
    assert.equal(promoted.dispatch, "succeeded");
    const branchId = promoted.branch.id;
    assert.equal(mainRuntime.prompts.length, 2);

    /* 验收复现：同键换问 "different question B" → 409 冲突（旧实现按
       turns.length>0 当成功重放）。 */
    await assert.rejects(
      () =>
        studio.terminology.promote({
          treeId, annotationId: annotation.id, idempotencyKey: "q-key", firstQuestion: "different question B",
        }),
      (error: unknown) =>
        error instanceof TerminologyPromotionConflictError && /different first question/.test(error.message),
    );
    assert.equal(mainRuntime.prompts.length, 2, "the conflicting question was never dispatched");
    assert.equal(findBranchView(studio.service.getTreeState(treeId), branchId).turns.length, 2, "the branch turns are untouched");

    /* 同键同问重放：幂等成功（账本 succeeded）。 */
    const replay = await studio.terminology.promote({
      treeId, annotationId: annotation.id, idempotencyKey: "q-key", firstQuestion: "question A",
    });
    assert.equal(replay.created, false);
    assert.equal(replay.dispatch, "succeeded");
    assert.equal(replay.dispatchRunId, promoted.outcome!.run.id, "the ledger run reference is surfaced");
    assert.equal(mainRuntime.prompts.length, 2);

    /* —— 结果未知（账本 dispatched）的三条对账路径（以直接 SQL 模拟
       「派发在途时进程退出」的崩溃窗口）—— */
    const flipLedger = (state: string): void => {
      const raw = new DatabaseSync(join(dir, "treeai.db"));
      raw.prepare("UPDATE terminology_promotion_dispatches SET dispatch_state = ? WHERE annotation_id = ?").run(
        state,
        annotation.id,
      );
      raw.close();
    };

    /* ① 账本 dispatched + 首问 turn 已落库 → 对账判「已送达」，补结算，
       不重发。 */
    flipLedger("dispatched");
    const reconciledSuccess = await studio.terminology.promote({
      treeId, annotationId: annotation.id, idempotencyKey: "q-key", firstQuestion: "question A",
    });
    assert.equal(reconciledSuccess.dispatch, "succeeded", "reconciliation finds the landed turn and settles succeeded");
    assert.equal(reconciledSuccess.outcome, null, "no re-dispatch happened");
    assert.equal(mainRuntime.prompts.length, 2);
    assert.equal(
      studio.repository.findTerminologyDispatchByAnnotation(annotation.id)?.dispatchState,
      "succeeded",
      "the ledger was settled by the reconciliation",
    );

    /* ② 账本 dispatched + 无落库 turn + 分支有非终态 Run（在途/未收敛）
       → 对账不决：不盲发，surface dispatch "unknown"。
       以仓储 API 直接构造崩溃窗口状态（建枝 + 绑定 + 账本 + markSent +
       非终态 Run——与真实「派发在途时进程退出」留下的库内状态一致）。 */
    const hangSelection = { start: 6, end: 9, text: answer.text.slice(6, 9) };
    const hangAnnotation = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection: hangSelection, mode: "term",
      term: hangSelection.text, explanation: "Hanging context.",
    }).annotation;
    const hangQuestion = "the question that was in flight when the process died";
    const hangCreation = studio.service.createBranchFromSelection(treeId, trunkId, answer.id, hangSelection);
    assert.equal(
      studio.repository.bindTerminologyPromotion(hangAnnotation.id, "hang-key", hangCreation.branch.id),
      true,
    );
    studio.repository.createTerminologyDispatch({
      annotationId: hangAnnotation.id,
      treeId,
      promotionKey: "hang-key",
      branchId: hangCreation.branch.id,
      firstQuestionHash: hashFirstQuestionPayload(hangAnnotation, hangQuestion),
    });
    studio.repository.markTerminologyDispatchSent(hangAnnotation.id);
    const hangEpisode = studio.repository.createEpisode(hangCreation.branch.id);
    const hungRun = studio.repository.createRun(hangEpisode.id, {
      sessionId: "hang-fixture",
      sessionFile: "/nonexistent/hang.jsonl",
      entryId: "entry-hang",
      piVersion: "0.85.1",
      availability: { status: "available" },
    } as never);
    const unknownOutcome = await studio.terminology.promote({
      treeId, annotationId: hangAnnotation.id, idempotencyKey: "hang-key", firstQuestion: hangQuestion,
    });
    assert.equal(unknownOutcome.dispatch, "unknown", "an undecidable reconciliation does NOT blind-resent");
    assert.ok(unknownOutcome.firstQuestionError !== null);
    assert.equal(unknownOutcome.firstQuestionError.code, "dispatch-unknown");
    assert.equal(mainRuntime.prompts.length, 2, "nothing was dispatched while the result was unknown");
    assert.equal(unknownOutcome.created, false);
    assert.equal(
      studio.repository.findTerminologyDispatchByAnnotation(hangAnnotation.id)?.dispatchState,
      "dispatched",
      "the undecidable ledger state is preserved for the caller to reconcile",
    );
    /* 该 Run 收敛终态后重试：对账判「明确未送达」→ 允许重发（同问）。 */
    studio.repository.updateRunState(hungRun.id, "failed", {
      failure: { code: "unknown", message: "swept by the test to unblock reconciliation" },
    });
    const resent = await studio.terminology.promote({
      treeId, annotationId: hangAnnotation.id, idempotencyKey: "hang-key", firstQuestion: hangQuestion,
    });
    assert.equal(resent.dispatch, "succeeded", "after the run converged, the retry re-dispatches and succeeds");
    assert.ok(resent.outcome !== null);
    assert.equal(mainRuntime.prompts.length, 3);
    assert.equal(
      studio.repository.findTerminologyDispatchByAnnotation(hangAnnotation.id)?.attempts,
      2,
      "attempts counts both real dispatches",
    );

    /* ③ 账本 dispatched + 无落库 turn + 无 Run（派发在建 Run 前崩溃）→
       对账判「明确未送达」→ 重发（同问）。 */
    const noRunSelection = { start: 10, end: 13, text: answer.text.slice(10, 13) };
    const noRunAnnotation = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection: noRunSelection, mode: "term",
      term: noRunSelection.text, explanation: "No-run context.",
    }).annotation;
    const noRunQuestion = "the question dispatched before any run existed";
    const noRunCreation = studio.service.createBranchFromSelection(treeId, trunkId, answer.id, noRunSelection);
    studio.repository.bindTerminologyPromotion(noRunAnnotation.id, "no-run-key", noRunCreation.branch.id);
    studio.repository.createTerminologyDispatch({
      annotationId: noRunAnnotation.id,
      treeId,
      promotionKey: "no-run-key",
      branchId: noRunCreation.branch.id,
      firstQuestionHash: hashFirstQuestionPayload(noRunAnnotation, noRunQuestion),
    });
    studio.repository.markTerminologyDispatchSent(noRunAnnotation.id);
    assert.equal(studio.repository.listEpisodes(noRunCreation.branch.id).length, 0, "no run was ever created");
    const recovered = await studio.terminology.promote({
      treeId, annotationId: noRunAnnotation.id, idempotencyKey: "no-run-key", firstQuestion: noRunQuestion,
    });
    assert.equal(recovered.dispatch, "succeeded", "no-run evidence reconciles to 'not landed' and re-dispatches");
    assert.ok(recovered.outcome !== null);
    assert.equal(mainRuntime.prompts.length, 4);
    assert.equal(
      findBranchView(studio.service.getTreeState(treeId), noRunCreation.branch.id).turns.length,
      2,
    );
    assert.equal(
      studio.repository.findTerminologyDispatchByAnnotation(noRunAnnotation.id)?.attempts,
      2,
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology promotion replay across a process restart: the binding and dispatch ledger are durable — a landed first question is never re-dispatched, and a different question under the same key stays a 409", async () => {
  const dir = makeTempDataDir();
  try {
    /* 同一计数 runtime 跨两个 studio 生命周期（= 进程重启的记账面）。 */
    const sharedMainRuntime = scriptedTerminologyRuntime({ answerFor: () => "The entropy of a signal rises with noise." });
    const studio1 = makeTerminologyStudio(dir, { mainRuntime: sharedMainRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio1);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const saved = studio1.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "Explained.",
    });
    const promoted = await studio1.terminology.promote({
      treeId, annotationId: saved.annotation.id, idempotencyKey: "restart-key", firstQuestion: "the one and only first question",
    });
    assert.equal(promoted.dispatch, "succeeded");
    assert.equal(sharedMainRuntime.prompts.length, 2); // q1 + first question
    await studio1.shutdown();

    /* 「重启」：同库新 service/terminology 装配。 */
    const studio2 = makeTerminologyStudio(dir, { mainRuntime: sharedMainRuntime });
    const replay = await studio2.terminology.promote({
      treeId, annotationId: saved.annotation.id, idempotencyKey: "restart-key", firstQuestion: "the one and only first question",
    });
    assert.equal(replay.created, false);
    assert.equal(replay.dispatch, "succeeded");
    assert.equal(replay.outcome, null, "the landed first question is not re-dispatched after the restart");
    assert.equal(replay.branch.id, promoted.branch.id);
    assert.equal(sharedMainRuntime.prompts.length, 2, "zero new dispatches across the restart replay");
    /* 重启后同键异问 → 仍是 409。 */
    await assert.rejects(
      () =>
        studio2.terminology.promote({
          treeId, annotationId: saved.annotation.id, idempotencyKey: "restart-key", firstQuestion: "an edited question after restart",
        }),
      TerminologyPromotionConflictError,
    );
    assert.equal(sharedMainRuntime.prompts.length, 2);
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* HTTP 面                                                              */
/* ------------------------------------------------------------------ */

test("terminology HTTP surface: read model, explain, annotations 201/200, promote 201/200/409 (incl. same-key different-question), preferences, cancel, and an honest 503 when unwired", async () => {
  const dir = makeTempDataDir();
  const running: Array<{ close(): Promise<void> }> = [];
  try {
    const studio = makeTerminologyStudio(dir);
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
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
    const treePath = (rest: string): string =>
      `/api/trees/${encodeURIComponent(treeId)}/terminology${rest === "" ? "" : `/${rest}`}`;
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };

    /* read model（空态如实）。 */
    const empty = await call(treePath(""), "GET");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.annotations, []);
    assert.equal(empty.body.cacheEnabled, true);
    assert.ok(Array.isArray(empty.body.tasks));
    assert.equal(empty.body.usage.budgetTokens, 1_000_000);

    /* explain → 200 {task, annotation:null}。 */
    const explained = await call(treePath("explain"), "POST", {
      branchId: trunkId,
      anchorTurnId: answer.id,
      selection,
      mode: "term",
    });
    assert.equal(explained.status, 200);
    assert.equal(explained.body.task.state.kind, "succeeded");

    /* annotations：201 新建 → 200 去重重放。 */
    const created = await call(treePath("annotations"), "POST", {
      branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "HTTP-saved explanation.",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    const replayed = await call(treePath("annotations"), "POST", {
      branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "different text, same range",
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.created, false);
    assert.equal(replayed.body.annotation.id, created.body.annotation.id);

    /* read model 现在有一条批注。 */
    const afterSave = await call(treePath(""), "GET");
    assert.equal(afterSave.body.annotations.length, 1);

    /* promote：201（首问派发成功）→ 200 同键重放 → 409 异键 → 409 同键异问。 */
    const annotationId: string = created.body.annotation.id;
    const promoted = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-1", firstQuestion: "HTTP promotion question" },
    );
    assert.equal(promoted.status, 201);
    assert.ok(promoted.body.outcome !== null);
    assert.equal(promoted.body.dispatch, "succeeded", "the promote response carries the dispatch ledger verdict");
    assert.ok(typeof promoted.body.dispatchRunId === "string", "the ledger run reference is surfaced");
    assert.equal(promoted.body.state.branches.length, 2, "the response carries the refreshed tree state");
    const replay = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-1", firstQuestion: "HTTP promotion question" },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.dispatch, "succeeded");
    assert.equal(replay.body.branch.id, promoted.body.branch.id);
    const conflict = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-2", firstQuestion: "conflicting key" },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "terminology-promotion-conflict");
    const questionConflict = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-1", firstQuestion: "a DIFFERENT question under the same key" },
    );
    assert.equal(questionConflict.status, 409, "the same key with a different question is a conflict, not a replay");
    assert.equal(questionConflict.body.error.code, "terminology-promotion-conflict");
    assert.equal(
      findBranchView(studio.service.getTreeState(treeId), promoted.body.branch.id).turns.length,
      2,
      "the conflicting question dispatched nothing",
    );

    /* preferences：PUT {cacheEnabled:false}。 */
    const pref = await call(treePath("preferences"), "PUT", { cacheEnabled: false });
    assert.equal(pref.status, 200);
    assert.equal(pref.body.cacheEnabled, false);
    const prefInvalid = await call(treePath("preferences"), "PUT", { cacheEnabled: "yes" });
    assert.equal(prefInvalid.status, 400);

    /* 任务取消：未知任务 404。 */
    const cancelUnknown = await call(treePath("tasks/task-nope/cancel"), "POST");
    assert.equal(cancelUnknown.status, 404);

    /* 校验面：非 assistant 锚点（user turn）→ 400；未知树 404。 */
    const userTurn = findBranchView(studio.service.getTreeState(treeId), trunkId).turns.find(
      (t: { role: string }) => t.role === "user",
    )!;
    const badAnchor = await call(treePath("explain"), "POST", {
      branchId: trunkId, anchorTurnId: userTurn.id, selection: { start: 0, end: 1, text: userTurn.text.slice(0, 1) }, mode: "term",
    });
    assert.equal(badAnchor.status, 400);
    const unknownTree = await call(
      `/api/trees/tree-nope/terminology`,
      "GET",
    );
    assert.equal(unknownTree.status, 404);

    /* 未装配（terminology === null）→ 503 如实说明。 */
    const bare = createStudioServer({ service: studio.service, staticDir });
    const barePort = await bare.listen(0);
    running.push({ close: () => bare.close() });
    const bareRes = await fetch(`http://127.0.0.1:${String(barePort)}/api/trees/${encodeURIComponent(treeId)}/terminology`);
    assert.equal(bareRes.status, 503);
    assert.equal((await bareRes.json() as any).error.code, "terminology-not-wired");

    await studio.shutdown();
  } finally {
    for (const r of running) await r.close().catch(() => undefined);
    cleanupDir(dir);
  }
});
