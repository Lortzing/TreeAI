/**
 * 消费方编译示例（compile-time usage examples）。
 *
 * 目的：证明冻结契约对 Wave 1 各实现方（Agent B–F 与 runtime-smoke）
 * 是可实现、可消费的最小接口。本文件只编译、不执行（noEmit）。
 * 对应的"必须编译失败"反例见 tests/negatives/。
 */
import type {
  AllowedRunStateTransition,
  Branch,
  BranchId,
  Episode,
  EpisodeId,
  Forest,
  ForestId,
  PiEntryId,
  PiModelSelector,
  PiPromptInput,
  PiPromptResult,
  PiRuntime,
  PiRuntimeEvent,
  PiRuntimeEventListener,
  PiSessionId,
  PiSessionInit,
  PiSessionSnapshot,
  PiSteerInput,
  PiNavigateTreeTarget,
  PiUnsubscribe,
  PiVersion,
  PinnedPiVersion,
  Run,
  RunId,
  RunState,
  SessionReference,
  Tree,
  TreeAIEvent,
  TreeAIEventType,
  TreeId,
  ToolDecision,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* 示例 A（Agent B / runtime-pi）：以 fake 实现 PiRuntime              */
/* ------------------------------------------------------------------ */

/**
 * fake 实现说明 contracts 不泄漏 Pi 类型：实现体不 import 任何 Pi 包，
 * 只依赖契约类型。真实实现由 packages/runtime-pi 提供。
 */
class FakePiRuntime implements PiRuntime {
  readonly piVersion: PiVersion = "0.85.1" as PiVersion;

  async createSession(init: PiSessionInit): Promise<PiSessionSnapshot> {
    void init;
    return {
      reference: makeReference("sess-1", "/tmp/treeai-fixtures/s.jsonl", "e-1"),
    };
  }

  async restoreSession(reference: SessionReference): Promise<PiSessionSnapshot> {
    return { reference };
  }

  async prompt(input: PiPromptInput): Promise<PiPromptResult> {
    void input;
    return {
      message: "final normalized assistant message",
      reference: makeReference("sess-1", "/tmp/treeai-fixtures/s.jsonl", "e-2"),
    };
  }

  async steer(input: PiSteerInput): Promise<void> {
    void input;
  }

  async abort(): Promise<void> {
    /* 幂等 no-op */
  }

  async navigateTree(
    target: PiNavigateTreeTarget,
  ): Promise<SessionReference> {
    return makeReference("sess-1", "/tmp/treeai-fixtures/s.jsonl", target.entryId);
  }

  subscribe(listener: PiRuntimeEventListener): PiUnsubscribe {
    void listener;
    return () => undefined;
  }

  async dispose(): Promise<void> {
    /* 幂等 */
  }
}

function makeReference(
  sessionId: string,
  sessionFile: string,
  entryId: string,
): SessionReference {
  return {
    sessionId: sessionId as PiSessionId,
    sessionFile,
    entryId: entryId as PiEntryId,
    piVersion: "0.85.1" as PiVersion,
    availability: { status: "available" },
  };
}

/* 实现侧版本校验：编译期即钉住 0.85.1（运行时再校验实际版本）。 */
const pinned: PinnedPiVersion = "0.85.1";

/* ------------------------------------------------------------------ */
/* 示例 B（Agent C / persistence）：域数据与引用分离                    */
/* ------------------------------------------------------------------ */

const forest: Forest = {
  id: "forest-1" as ForestId,
  createdAt: "2026-09-21T00:00:00.000Z",
};

const tree: Tree = {
  id: "tree-1" as TreeId,
  forestId: forest.id,
  createdAt: "2026-09-21T00:00:01.000Z",
};

const mainBranch: Branch = {
  id: "branch-main" as BranchId,
  treeId: tree.id,
  parentBranchId: null,
  createdAt: "2026-09-21T00:00:02.000Z",
};

const secondBranch: Branch = {
  id: "branch-2" as BranchId,
  treeId: tree.id,
  parentBranchId: mainBranch.id,
  createdAt: "2026-09-21T00:00:03.000Z",
};

const episode: Episode = {
  id: "episode-1" as EpisodeId,
  branchId: mainBranch.id,
  createdAt: "2026-09-21T00:00:04.000Z",
};

const run: Run = {
  id: "run-1" as RunId,
  episodeId: episode.id,
  state: "queued",
  session: makeReference("sess-1", "/tmp/treeai-fixtures/s.jsonl", "e-1"),
  createdAt: "2026-09-21T00:00:05.000Z",
  terminalAt: null,
};

/* session 丢失：只把引用标记为 unavailable，域数据保持完整。 */
const degradedReference: SessionReference = {
  ...run.session,
  availability: {
    status: "unavailable",
    reason: "missing-file",
    detail: "session file removed; domain data retained",
  },
};

/* 终态 Run：terminalAt 非空 + failure 存在（state === "failed"）。 */
const failedRun: Run = {
  ...run,
  state: "failed",
  terminalAt: "2026-09-21T00:01:00.000Z",
  failure: {
    code: "upstream",
    message: "model request failed after retries",
    details: { attemptCount: 2 },
  },
};

/* ------------------------------------------------------------------ */
/* 示例 C（Agent D / tool-policy）：构造结构化决定                      */
/* ------------------------------------------------------------------ */

const allowFixtureRead: ToolDecision = {
  outcome: "allow",
  category: "read",
  risk: "low",
  reason: "path is inside approved fixtures root",
  ruleId: "allow-read-fixtures",
  scope: { roots: ["/tmp/treeai-fixtures"] },
};

const denyShellByDefault: ToolDecision = {
  outcome: "deny",
  category: "shell",
  risk: "high",
  reason: "shell is denied by default; no explicit rule configured",
  ruleId: null,
  scope: { roots: [] },
};

const writeNeedsApproval: ToolDecision = {
  outcome: "require-approval",
  category: "write",
  risk: "high",
  reason: "write inside approved workspace requires per-operation approval",
  ruleId: "write-workspace-with-approval",
  scope: { roots: ["/tmp/treeai-workspace"] },
};

/* ------------------------------------------------------------------ */
/* 示例 D（Agent E / event-journal）：runtime 事件 → 领域事件          */
/* ------------------------------------------------------------------ */

/** 由实现持有的下一个 seq（演示同一 run 内严格递增）。 */
function toTreeAIEvent(
  runtimeEvent: PiRuntimeEvent,
  runId: RunId,
  previousSeq: number,
): TreeAIEvent {
  return {
    eventId: runtimeEvent.eventId,
    runId,
    seq: previousSeq + 1,
    occurredAt: runtimeEvent.occurredAt,
    type: mapKindToType(runtimeEvent.kind),
    payload: { note: "redacted-by-journal-before-persist" },
    evidence: [
      { source: "pi-runtime", refId: runtimeEvent.eventId as string },
    ],
  };
}

function mapKindToType(kind: PiRuntimeEvent["kind"]): TreeAIEventType {
  if (kind === "message.updated" || kind === "message.completed") {
    return kind;
  }
  if (kind === "tree.navigated") {
    return "tree.navigated";
  }
  return "pi.unknown";
}

/* 状态投影器：用类型级迁移表拒绝非法迁移。
 * 非法迁移的返回类型是错误标记元组（而不是 never——never 可赋给一切，
 * 拒绝不了任何东西），使赋值处编译失败。
 * 对应反例：tests/negatives/run-state-illegal-via-helper/。 */
type NextRunState<From extends RunState, To extends RunState> =
  AllowedRunStateTransition<From, To> extends true
    ? To
    : readonly ["ILLEGAL_RUN_STATE_TRANSITION", From, To];

function transitionRunState<From extends RunState, To extends RunState>(
  current: From,
  next: To,
): NextRunState<From, To> {
  void current;
  return next as NextRunState<From, To>;
}

const projected: RunState = transitionRunState("running", "aborting");
const converged: RunState = transitionRunState(projected, "aborted");

/* ------------------------------------------------------------------ */
/* 示例 E（Integrator / runtime-smoke）：面向接口编排                  */
/* ------------------------------------------------------------------ */

async function smokeFlow(runtime: PiRuntime): Promise<void> {
  const unsubscribe: PiUnsubscribe = runtime.subscribe((event) => {
    void event.seq;
  });

  const model: PiModelSelector = {
    providerId: "fixture-provider",
    modelId: "fixture-model",
  };
  const init: PiSessionInit = {
    model,
    sessionDir: "/tmp/treeai-fixtures/sessions",
    cwd: "/tmp/treeai-fixtures",
  };

  const created: PiSessionSnapshot = await runtime.createSession(init);
  void created.reference.entryId;

  const result: PiPromptResult = await runtime.prompt({
    text: "what is the answer?",
  });
  void result.message;

  await runtime.steer({ text: "also show your reasoning" });
  await runtime.abort();

  const navigated: SessionReference = await runtime.navigateTree({
    entryId: result.reference.entryId,
  });
  void navigated.sessionId;

  await runtime.restoreSession(created.reference);
  unsubscribe();
  await runtime.dispose();
}
