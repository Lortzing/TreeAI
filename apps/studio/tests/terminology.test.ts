/**
 * 术语三部分（issue #7 C）——①执行器 + ②保存/推广 的离线测试面。
 *
 * 覆盖（echo / 脚本化 runtime + 真实 SQLite）：
 *  - 隔离：解释/提取零树写入、零主 session 文件、主游标不动（issue #7
 *    C ②「关闭 10 次零正式事实/主会话副作用」的机械面）；
 *  - explain 生命周期（echo：解释 = 提示词回声）、去重命中已保存批注时
 *    零模型调用；
 *  - 保存 + 同选区去重 + 锚定完整性（UTF-16 偏移/emoji/跨行/切片全等）；
 *  - 幂等推广：复用 Anchor/Branch/Origin 建枝 + 首问派发（组合上下文 +
 *    turn 标记）；同键重放不重建枝、不重复派发；异键 409；首问失败后
 *    同键重试重新派发（不重建枝）；
 *  - 取消 + 迟到结果丢弃（脚本化 runtime：resolve-after-cancel）；
 *  - 预算：fail-closed（budget-exceeded）、用量 kv 持久化、重启后维持；
 *  - 缓存偏好：同 (mode, term, sourceHash) 命中零请求；关闭缓存后重打；
 *  - auto 提取（脚本化 JSON）：机械校验（切片全等/去重/密度/URL+代码
 *    排除）；echo 的非 JSON 回声 → 诚实 failed(terminology-parse)；
 *  - HTTP 面：read model / explain / annotations 201+200 / promote 201+
 *    200+409 / preferences / cancel / 未装配 503。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { createPiRuntimeFromConfig, classifyPiFailure } from "@treeai/runtime-pi";
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
  parseCandidates,
  validateCandidates,
  excludedSpans,
  hashSourceText,
  TERMINOLOGY_PROMOTION_TURN_PREFIX,
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
  let initialUsage: { total: { requests: number; promptChars: number; completionChars: number }; lateResultsDiscarded: number } | null = null;
  if (options.persistedUsage !== undefined) {
    repository.setTerminologyState("usage", options.persistedUsage);
    try {
      initialUsage = JSON.parse(options.persistedUsage);
    } catch {
      initialUsage = null;
    }
  }
  const executor = new TerminologyExecutor({
    runtime: terminologyRuntime,
    model: STUDIO_MODEL,
    sessionDir: terminologySessions,
    cwd: terminologyWorkspace,
    budgetTokens: options.budgetTokens ?? 1_000_000,
    cacheEnabled: options.cacheEnabled ?? true,
    initialUsage,
    onUsage: (usage) => {
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

test("promotion survives a failed first question: the binding is durable, and the same-key retry re-dispatches without rebuilding the branch", async () => {
  const dir = makeTempDataDir();
  try {
    const FAILURE_SENTINEL = "TRIGGER-UPSTREAM-FAILURE";
    const echoRuntime = createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(dir, "workspace"),
    });
    const mainRuntime: PiRuntime = {
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
    const studio = makeTerminologyStudio(dir, { mainRuntime });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const saved = studio.terminology.saveAnnotation({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
      term: selection.text, explanation: "Explained.",
    });

    /* 首问注入失败：分支与绑定已是事实，firstQuestionError 如实分离。 */
    const failed = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-retry",
      firstQuestion: `${FAILURE_SENTINEL} this first dispatch will fail`,
    });
    assert.equal(failed.created, true);
    assert.equal(failed.outcome, null, "the failed first question persists no turns");
    assert.ok(failed.firstQuestionError !== null);
    assert.equal(failed.firstQuestionError.code, "upstream");
    const promotedBranchId = failed.branch.id;
    assert.equal(findBranchView(studio.service.getTreeState(treeId), promotedBranchId).turns.length, 0);

    /* 响应丢失/失败后同键重试：不重建枝，重新派发（这次成功）。 */
    const retried = await studio.terminology.promote({
      treeId,
      annotationId: saved.annotation.id,
      idempotencyKey: "promo-retry",
      firstQuestion: "the retried first question",
    });
    assert.equal(retried.created, false);
    assert.equal(retried.branch.id, promotedBranchId, "the same branch is reused (no rebuild)");
    assert.ok(retried.outcome !== null, "the re-dispatched first question succeeds");
    const view = findBranchView(studio.service.getTreeState(treeId), promotedBranchId);
    assert.equal(view.turns.length, 2);
    assert.ok(view.turns[0]!.text.includes("the retried first question"));
    assert.equal(studio.repository.listBranches(treeId).length, 2, "still exactly one promoted branch");
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
    /* 诚实成本：请求已发生 → 用量照记（requests 1），迟到计数 1。 */
    const usage = studio.executor.usage();
    assert.equal(usage.total.requests, 1);
    assert.equal(usage.lateResultsDiscarded, 1);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("terminology budget: fail-closed at the cap, usage persists across executor restarts (kv), and the cache preference toggles re-requesting", async () => {
  const dir = makeTempDataDir();
  try {
    /* 预算 1 token：第一次请求后即超限（估算口径 chars/4 ≥ 1）。 */
    const studio = makeTerminologyStudio(dir, { budgetTokens: 1 });
    const { treeId, trunkId, answer } = await makeTreeWithAnswer(studio);
    const selection = { start: 0, end: 5, text: answer.text.slice(0, 5) };
    const first = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    assert.equal(first.task?.state.kind, "succeeded");
    /* 换一个选区（避开缓存）：预算已尽 → fail-closed。 */
    const second = await studio.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id,
      selection: { start: 1, end: 4, text: answer.text.slice(1, 4) }, mode: "term",
    });
    assert.ok(second.task !== null && second.task.state.kind === "failed");
    if (second.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(second.task.state.code, "budget-exceeded");

    /* 用量 kv 已持久化；重启（新执行器，同库）后仍被预算拦住。 */
    const persisted = studio.repository.getTerminologyState("usage");
    assert.ok(persisted !== null);
    await studio.shutdown();
    const studio2 = makeTerminologyStudio(dir, { budgetTokens: 1, persistedUsage: persisted! });
    const third = await studio2.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id,
      selection: { start: 1, end: 4, text: answer.text.slice(1, 4) }, mode: "term",
    });
    assert.ok(third.task !== null && third.task.state.kind === "failed");
    if (third.task.state.kind !== "failed") throw new Error("unreachable");
    assert.equal(third.task.state.code, "budget-exceeded", "the restarted executor resumes the persisted budget state");
    assert.equal(studio2.executor.usage().total.requests, 1, "the persisted request count is resumed, and no new request is made while over budget");

    /* 缓存偏好：关闭后同键重打（新请求）；重开后又命中。 */
    const studio3 = makeTerminologyStudio(dir, { budgetTokens: 1_000_000 });
    const a = await studio3.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    assert.ok(a.task !== null && a.task.state.kind === "succeeded" && !a.task.state.cached);
    const b = await studio3.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    assert.ok(b.task !== null && b.task.state.kind === "succeeded" && b.task.state.cached, "same key hits the cache");
    studio3.terminology.setCachePreference(false);
    assert.equal(studio3.executor.cacheEnabled, false);
    const c = await studio3.terminology.explain({
      treeId, branchId: trunkId, anchorTurnId: answer.id, selection, mode: "term",
    });
    assert.ok(c.task !== null && c.task.state.kind === "succeeded" && !c.task.state.cached, "cache disabled re-requests");
    assert.equal(studio3.executor.usage().total.requests, 2);
    await studio3.shutdown();
    void studio2.shutdown;
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
/* HTTP 面                                                              */
/* ------------------------------------------------------------------ */

test("terminology HTTP surface: read model, explain, annotations 201/200, promote 201/200/409, preferences, cancel, and an honest 503 when unwired", async () => {
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

    /* promote：201（首问派发成功）→ 200 同键重放 → 409 异键。 */
    const annotationId: string = created.body.annotation.id;
    const promoted = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-1", firstQuestion: "HTTP promotion question" },
    );
    assert.equal(promoted.status, 201);
    assert.ok(promoted.body.outcome !== null);
    assert.equal(promoted.body.state.branches.length, 2, "the response carries the refreshed tree state");
    const replay = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-1", firstQuestion: "HTTP promotion question" },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.branch.id, promoted.body.branch.id);
    const conflict = await call(
      treePath(`annotations/${encodeURIComponent(annotationId)}/promote`),
      "POST",
      { idempotencyKey: "http-promo-2", firstQuestion: "conflicting key" },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "terminology-promotion-conflict");

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
