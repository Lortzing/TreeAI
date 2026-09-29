/**
 * TreeStudioService — D3 Core MVP 产品服务（studio app 的领域核心）。
 *
 * 职责：把 D2 包（contracts / runtime-pi / persistence）组装成产品行为——
 *   - 创建/打开 Tree（Trunk = 根分支）；
 *   - 在 Trunk/Branch 上对话（Episode + Run + Turn 三层落库）；
 *   - 从“锚定的答案选区”创建 Branch：Pi 会话树内在锚点条目处分叉
 *     （navigateTree，不新建 session 文件——D2 已验证的分叉方式）；
 *   - 继续分支、切回 Trunk（同一 session 文件内移动叶指针）；
 *   - 编辑并显式提交 Return：记录在 Trunk 上（含出处分支），
 *     并在下一次 Trunk prompt 时送入 Pi 上下文（可送达、只送达一次）；
 *   - 全部产品状态即时写入 TreeAI DB（事实源）；重启后由 DB 重建。
 *
 * 会话连续性模型（全部可从 DB 重建，cursor 只是缓存）：
 *   分支的“续聊点” =
 *     该分支最新 Run 的 SessionReference（Run 落库时更新到该 Run 完成后的叶）；
 *     无 Run 但有 BranchOrigin → 锚点 Run 的引用三元组 + anchorEntryId；
 *     Trunk 且无 Run → 首次 prompt 时新建 session。
 *   进程内活动会话 cursor 与续聊点不一致时：
 *     同 session 文件 → navigateTree（D2 回归能力，同 session 不换文件）；
 *     不同文件/无活动会话 → restoreSession。
 *
 * 诊断面（A5，最小诚实）：getTreeDiagnostics 提供安全投影——运行面状态
 *   （idle/streaming/aborting）、在途 run 定位、DB 全量 run 行
 *   （runId/branchId/episodeId/state/failure code+message/createdAt/
 *   terminalAt）。session 引用（sessionFile/sessionId/entryId/piVersion/
 *   availability）、failure.details、原始 cause、命令、主机与目标路径
 *   一律不外泄；Studio 无工具执行器（prompt 以空工具 allowlist 运行），
 *   如实报告“未观测策略决策”，绝不伪造 policy 判定。
 *   abort(treeId, runId) 只接受该树当前在途的 run（否则按操作冲突拒绝），
 *   调用 runtime.abort()，由 prompt 的收敛路径把 run 落库为 aborted
 *   （user-abort 绝不改写为 failed）。
 *
 * 已知范围（诚实声明）：不做流式 UI 推送（prompt 请求同步等待收敛；
 *   UI 在 prompt 在途时轮询诊断面）、并发 prompt 以冲突拒绝不排队
 *   （TypeError → 409，单用户语义）、不做 event-journal 集成
 *   （D2 审计面留待后续接入）。
 */

import type {
  Branch,
  BranchId,
  BranchOrigin,
  EpisodeId,
  Forest,
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  Run,
  RunId,
  RunState,
  SessionReference,
  Tree,
  TreeAIError,
  TreeAIErrorCode,
  TreeId,
  Turn,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  TreeRepository,
} from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 读模型（服务 → HTTP/UI 的形状）                                      */
/* ------------------------------------------------------------------ */

export interface BranchView {
  readonly branch: Branch;
  readonly origin: BranchOrigin | null;
  readonly originStatus: AnchorStatus | null;
  readonly turns: readonly Turn[];
}

export interface SessionCursorInfo {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly entryId: string;
}

export interface TreeState {
  readonly tree: Tree;
  readonly trunkBranchId: BranchId | null;
  readonly branches: readonly BranchView[];
  readonly cursor: SessionCursorInfo | null;
}

export interface PromptOutcome {
  readonly run: Run;
  readonly userTurn: Turn;
  readonly assistantTurn: Turn;
  /** 本次 prompt 送入 Pi 上下文的未送达 return 数。 */
  readonly deliveredReturns: number;
}

export interface BranchCreation {
  readonly branch: Branch;
  readonly origin: BranchOrigin;
}

export type AnchorStatus = "available" | "changed" | "unavailable";

export interface AnchorLocation {
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly status: AnchorStatus;
  readonly selection: TurnSelection;
}

/* ------------------------------------------------------------------ */
/* 诊断读模型（A5：安全投影，只含可安全外泄的字段）                     */
/* ------------------------------------------------------------------ */

/** 运行面状态：idle（无在途 prompt）/ streaming（在途）/ aborting（已请求中止）。 */
export type StudioRuntimeState = "idle" | "streaming" | "aborting";

/** 在途 run 的定位（不含任何 Pi 会话细节）。 */
export interface ActiveRunInfo {
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
}

/**
 * Run 行的诊断投影。刻意只保留定位 + 状态 + 失败码与消息 + 时间戳；
 * session 引用、failure.details、原始 cause、命令、主机与目标路径
 * 一律不进入本形状（防字段外泄回归由测试锁定键集合）。
 */
export interface RunDiagnostics {
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
  readonly state: RunState;
  readonly failure: { readonly code: TreeAIErrorCode; readonly message: string } | null;
  readonly createdAt: IsoTimestamp;
  readonly terminalAt: IsoTimestamp | null;
}

/**
 * 策略决策观测（诚实边界）：Studio 的 prompt 以空工具 allowlist 运行
 * （runtime-pi 默认零工具），没有工具执行器——因此没有工具执行事件，
 * 也就没有任何策略决策可观测。诊断面绝不伪造 policy 判定。
 */
export interface PolicyDiagnostics {
  readonly observed: false;
  readonly reason: string;
}

export const NO_POLICY_DECISIONS_REASON =
  "studio prompts run with an empty tool allowlist; no tool executions occur, so no policy decisions are observed";

/** 一棵树的诊断读模型（只读、安全投影）。 */
export interface TreeDiagnostics {
  readonly treeId: TreeId;
  readonly runtimeState: StudioRuntimeState;
  readonly activeRun: ActiveRunInfo | null;
  readonly runs: readonly RunDiagnostics[];
  readonly policyDecisions: PolicyDiagnostics;
}

/** abort 目标不是该树当前在途的 run（已终态/无在途/另有在途）→ 操作冲突（409）。 */
export class RunNotActiveError extends Error {
  constructor(runId: RunId, state: RunState) {
    super(
      `run ${runId} is not the active in-flight run (state: ${state}); only the active run of a tree can be aborted`,
    );
    this.name = "RunNotActiveError";
  }
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export interface TreeStudioServiceOptions {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  /** Pi session 存储目录（由宿主创建与拥有；测试/CLI 用专用目录）。 */
  readonly sessionDir: string;
  /** 工具执行工作目录（trusted-local 工作区）。 */
  readonly cwd: string;
}

interface Cursor {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly reference: SessionReference;
}

/** 在途 prompt 的服务侧簿记（诊断面与 abort 校验的事实源；进程内即失效）。 */
interface ActiveRunRecord extends ActiveRunInfo {
  readonly treeId: TreeId;
  /** 已通过 abort() 请求中止（运行面状态 → aborting）。 */
  abortRequested: boolean;
}

type Continuation =
  | { readonly kind: "new-session" }
  | { readonly kind: "reference"; readonly reference: SessionReference };

function toTreeAIError(err: unknown): TreeAIError {
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as TreeAIError["code"], message: candidate.message };
    }
  }
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** 把未送达的 return 拼进下一次 prompt 文本（送入 Pi 上下文的载体）。 */
export function composePromptText(pendingReturns: readonly Turn[], text: string): string {
  if (pendingReturns.length === 0) return text;
  const blocks = pendingReturns.map(
    (turn) => `[Return from branch ${turn.fromBranchId}]\n${turn.text}`,
  );
  return `${blocks.join("\n\n")}\n\n${text}`;
}

export class TreeStudioService {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  readonly sessionDir: string;
  readonly cwd: string;
  #cursor: Cursor | null = null;
  #forest: Forest | null = null;
  /** 单 prompt 操作锁：同一时刻至多一个 prompt 操作（含会话对准阶段）。 */
  #promptInFlight: boolean = false;
  /** 当前在途的 run（run 落库并置 running 后才有值；收敛即清除）。 */
  #activeRun: ActiveRunRecord | null = null;

  constructor(options: TreeStudioServiceOptions) {
    this.repository = options.repository;
    this.runtime = options.runtime;
    this.model = options.model;
    this.sessionDir = options.sessionDir;
    this.cwd = options.cwd;
    this.recoverInterruptedRuns();
  }

  /**
   * I6 重启恢复：宿主退出时仍非终态的 Run 收敛为 failed
   * （宿主中断语义）。DB 是事实源，重复调用安全（无则空转）。
   */
  recoverInterruptedRuns(): readonly Run[] {
    return this.repository.failNonTerminalRuns({
      code: "unknown",
      message: "host process interrupted before the run reached a terminal state",
      details: { hostInterrupted: true },
    });
  }

  /* ------------------------------ Forest / Tree ------------------------------ */

  /** 受信任本地库：单 Forest，首次访问时创建。 */
  ensureForest(): Forest {
    if (this.#forest !== null) return this.#forest;
    const existing = this.repository.listForests();
    this.#forest = existing.length > 0 ? existing[0]! : this.repository.createForest();
    return this.#forest;
  }

  listTrees(): readonly Tree[] {
    return this.repository.listTrees(this.ensureForest().id);
  }

  /** 创建 Tree（自动建 Trunk 根分支）。 */
  createTree(): { tree: Tree; trunkBranch: Branch } {
    const forest = this.ensureForest();
    return this.repository.transaction(() => {
      const tree = this.repository.createTree(forest.id);
      const trunkBranch = this.repository.createBranch(tree.id);
      return { tree, trunkBranch };
    });
  }

  getTreeState(treeId: TreeId): TreeState {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null) ?? null;
    const views: BranchView[] = branches.map((branch) => {
      const origin = this.repository.findBranchOrigin(branch.id);
      return {
        branch,
        origin,
        originStatus: origin === null ? null : this.#anchorStatus(origin),
        turns: this.repository.listTurns(branch.id),
      };
    });
    return {
      tree,
      trunkBranchId: trunk !== null ? trunk.id : null,
      branches: views,
      cursor: this.#cursorInfo(tree.id),
    };
  }

  #cursorInfo(treeId: TreeId): SessionCursorInfo | null {
    const cursor = this.#cursor;
    if (cursor !== null && cursor.treeId === treeId) {
      return { treeId, branchId: cursor.branchId, entryId: cursor.reference.entryId };
    }
    const persisted = this.repository.findActiveNavigation(treeId);
    return persisted === null
      ? null
      : { treeId, branchId: persisted.branchId, entryId: persisted.reference.entryId };
  }

  #setCursor(treeId: TreeId, branchId: BranchId, reference: SessionReference): void {
    this.#cursor = { treeId, branchId, reference };
    this.repository.saveActiveNavigation(treeId, branchId, reference);
  }

  #anchorStatus(origin: BranchOrigin): AnchorStatus {
    const sourceBranch = this.repository.findBranch(origin.sourceBranchId);
    const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
    if (sourceBranch === null || anchorTurn === null) return "unavailable";
    if (anchorTurn.branchId !== sourceBranch.id || anchorTurn.role !== "assistant" || anchorTurn.piEntryId !== origin.anchorEntryId) {
      return "changed";
    }
    if (
      origin.selection.start < 0 ||
      origin.selection.end < origin.selection.start ||
      origin.selection.end > anchorTurn.text.length ||
      anchorTurn.text.slice(origin.selection.start, origin.selection.end) !== origin.selection.text
    ) {
      return "changed";
    }
    if (anchorTurn.runId === null) return "changed";
    const run = this.repository.findRun(anchorTurn.runId);
    return run === null || run.session.availability.status === "unavailable" ? "unavailable" : "available";
  }


  /** 分支的续聊点（全部可从 DB 重建）。 */
  #resolveContinuation(branch: Branch): Continuation {
    const episodes = this.repository.listEpisodes(branch.id);
    let latestRun: Run | null = null;
    for (const episode of episodes) {
      const runs = this.repository.listRuns(episode.id);
      if (runs.length > 0) latestRun = runs[runs.length - 1]!;
    }
    if (latestRun !== null) {
      return { kind: "reference", reference: latestRun.session };
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin !== null) {
      const anchorTurn = this.repository.getTurn(origin.anchorTurnId);
      if (anchorTurn.runId === null) {
        throw new InvalidArgumentError(
          `anchor turn ${origin.anchorTurnId} has no run (schema integrity violation)`,
        );
      }
      const anchorRun = this.repository.getRun(anchorTurn.runId);
      return {
        kind: "reference",
        reference: {
          sessionId: anchorRun.session.sessionId,
          sessionFile: anchorRun.session.sessionFile,
          entryId: origin.anchorEntryId,
          piVersion: anchorRun.session.piVersion,
          availability: anchorRun.session.availability,
        },
      };
    }
    if (branch.parentBranchId === null) {
      return { kind: "new-session" };
    }
    throw new InvalidArgumentError(
      `branch ${branch.id} has no continuation point (no runs and no origin)`,
    );
  }

  /** 把活动 Pi 会话对准续聊点（cursor 只是缓存，真实位置以 DB 为准）。 */
  async #ensureSessionAt(treeId: TreeId, branchId: BranchId, continuation: Continuation): Promise<SessionReference> {
    if (continuation.kind === "new-session") {
      const snapshot = await this.runtime.createSession({
        model: this.model,
        cwd: this.cwd,
        sessionDir: this.sessionDir,
      });
      this.#setCursor(treeId, branchId, snapshot.reference);
      return snapshot.reference;
    }
    const target = continuation.reference;
    const cursor = this.#cursor;
    if (
      cursor !== null &&
      cursor.reference.sessionFile === target.sessionFile &&
      cursor.reference.entryId === target.entryId
    ) {
      // 已在该位置（可能只是分支视图不同）：更新分支归属即可。
      this.#setCursor(treeId, branchId, cursor.reference);
      return cursor.reference;
    }
    let reference: SessionReference;
    if (cursor !== null && cursor.reference.sessionFile === target.sessionFile) {
      // 同一 session 文件：navigateTree 移动叶指针（不换 session、不换文件）。
      reference = await this.runtime.navigateTree({ entryId: target.entryId });
    } else {
      reference = (await this.runtime.restoreSession(target)).reference;
    }
    this.#setCursor(treeId, branchId, reference);
    return reference;
  }

  /* ------------------------------ 对话 ------------------------------ */

  /**
   * 在分支上执行一轮 prompt（Episode + Run + user/assistant Turn 落库）。
   *
   * 单用户冲突语义：同一时刻至多一个在途 prompt 操作（与 PiRuntime 契约
   * 一致）；冲突的第二个 prompt 以 TypeError 拒绝（HTTP 层映射 409），
   * 且不产生任何 run/turn 写入。
   *
   * 中止收敛：prompt 被中止（runtime TreeAIError code "user-abort"）时，
   * run 以单事务 running → aborting → aborted 收敛（run-state I4），
   * 绝不改写为 failed；其他失败仍按既有语义收敛 failed 并记录 failure。
   */
  async prompt(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("prompt text must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    if (this.#promptInFlight) {
      throw new TypeError("a prompt is already in flight on this service; wait for it to settle or abort it first");
    }
    this.#promptInFlight = true;
    try {
      const continuation = this.#resolveContinuation(branch);
      const preRef = await this.#ensureSessionAt(tree.id, branch.id, continuation);

      // 未送达的 return 在这次 prompt 送入 Pi 上下文。
      const pendingReturns = this.repository
        .listTurns(branch.id)
        .filter((turn) => turn.role === "return" && turn.deliveredRunId === null);
      const composedText = composePromptText(pendingReturns, text);

      const episode = this.repository.createEpisode(branch.id);
      const run = this.repository.createRun(episode.id, preRef);
      this.repository.updateRunState(run.id, "running");
      this.#activeRun = {
        treeId: tree.id,
        branchId: branch.id,
        episodeId: episode.id,
        runId: run.id,
        abortRequested: false,
      };

      let result: Awaited<ReturnType<PiRuntime["prompt"]>>;
      try {
        result = await this.runtime.prompt({ text: composedText });
      } catch (err) {
        const error = toTreeAIError(err);
        const record = this.#activeRun;
        this.#activeRun = null;
        if (error.code === "user-abort") {
          // 用户/宿主主动中止（abort、会话替换、dispose）：收敛为 aborted。
          this.repository.transaction(() => {
            this.repository.updateRunState(run.id, "aborting");
            this.repository.updateRunState(run.id, "aborted");
          });
          if (record !== null && record.abortRequested && preRef.entryId !== "") {
            // 会话叶指针回位到本次 prompt 的续聊点（append-only 树不删条目），
            // 保证中止后同进程续聊与重启后语义一致；尽力而为，失败时清空
            // 内存 cursor，让下一次 prompt 走 restoreSession 自愈。
            try {
              await this.runtime.navigateTree({ entryId: preRef.entryId });
            } catch {
              this.#cursor = null;
            }
          }
        } else {
          this.repository.updateRunState(run.id, "failed", { failure: error });
        }
        throw err;
      }
      this.#activeRun = null;

      const outcome = this.repository.transaction(() => {
        this.repository.updateRunState(run.id, "succeeded");
        this.repository.updateRunSessionReference(run.id, result.reference);
        const userTurn = this.repository.createTurn({
          treeId: tree.id,
          branchId: branch.id,
          episodeId: episode.id,
          runId: run.id,
          role: "user",
          text,
        });
        const assistantTurn = this.repository.createTurn({
          treeId: tree.id,
          branchId: branch.id,
          episodeId: episode.id,
          runId: run.id,
          role: "assistant",
          text: result.message,
          piEntryId: result.reference.entryId,
        });
        for (const pending of pendingReturns) {
          this.repository.markReturnDelivered(pending.id, run.id);
        }
        return { userTurn, assistantTurn };
      });

      this.#setCursor(tree.id, branch.id, result.reference);
      return {
        run: this.repository.getRun(run.id),
        userTurn: outcome.userTurn,
        assistantTurn: outcome.assistantTurn,
        deliveredReturns: pendingReturns.length,
      };
    } finally {
      this.#promptInFlight = false;
    }
  }

  /* ------------------------------ 中止 ------------------------------ */

  /**
   * 请求中止该树当前在途的 run。校验目标确为该树的活动 run（未知树/run →
   * EntityNotFoundError；空 id/跨树 run → InvalidArgumentError；非活动 run
   * → RunNotActiveError，均为操作冲突语义），然后调用 runtime.abort()；
   * 在途 prompt 随后以 TreeAIError（code "user-abort"）收敛，run 落库为
   * aborted（见 prompt 的收敛路径）。幂等；若 prompt 已先一步 settle，
   * 本次请求不产生效果（不撒谎、不改写结果）。
   */
  async abort(treeId: TreeId, runId: RunId): Promise<void> {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const run = this.repository.getRun(runId); // 空 id → InvalidArgumentError；未知 → 404
    const episode = this.repository.getEpisode(run.episodeId);
    const branch = this.repository.getBranch(episode.branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`run ${runId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const active = this.#activeRun;
    if (active === null || active.runId !== run.id) {
      throw new RunNotActiveError(runId, run.state);
    }
    // 同步置位：abort() 返回前，诊断面即可观测到 aborting。
    active.abortRequested = true;
    await this.runtime.abort();
  }

  /* ------------------------------ 诊断（A5 安全投影） ------------------------------ */

  /**
   * 一棵树的诊断读模型：运行面状态（idle/streaming/aborting）、在途 run
   * 定位、DB 全量 run 的安全投影。刻意排除 session 引用（sessionFile/
   * sessionId/entryId/piVersion/availability）、failure.details、原始
   * cause、命令、主机与目标路径；策略决策如实报告未观测（Studio 无
   * 工具执行器），绝不伪造 policy 判定。
   */
  getTreeDiagnostics(treeId: TreeId): TreeDiagnostics {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const runs: RunDiagnostics[] = [];
    for (const branch of this.repository.listBranches(tree.id)) {
      for (const episode of this.repository.listEpisodes(branch.id)) {
        for (const run of this.repository.listRuns(episode.id)) {
          runs.push({
            runId: run.id,
            branchId: branch.id,
            episodeId: episode.id,
            state: run.state,
            failure:
              run.failure === undefined ? null : { code: run.failure.code, message: run.failure.message },
            createdAt: run.createdAt,
            terminalAt: run.terminalAt,
          });
        }
      }
    }
    // 跨 episode/branch 的稳定全序（createdAt 同毫秒时以 runId 决胜）。
    runs.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.runId < b.runId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
    const active = this.#activeRun;
    const activeForTree = active !== null && active.treeId === tree.id ? active : null;
    return {
      treeId: tree.id,
      runtimeState:
        activeForTree === null ? "idle" : activeForTree.abortRequested ? "aborting" : "streaming",
      activeRun:
        activeForTree === null
          ? null
          : { runId: activeForTree.runId, branchId: activeForTree.branchId, episodeId: activeForTree.episodeId },
      runs,
      policyDecisions: { observed: false, reason: NO_POLICY_DECISIONS_REASON },
    };
  }

  /* ------------------------------ 分支 ------------------------------ */

  /** 从“锚定的答案选区”创建分支（出处与选区完整落库；分叉发生在首次续聊）。 */
  createBranchFromSelection(
    treeId: TreeId,
    sourceBranchId: BranchId,
    anchorTurnId: string,
    selection: TurnSelection,
  ): BranchCreation {
    const tree = this.repository.getTree(treeId);
    const source = this.repository.getBranch(sourceBranchId);
    if (source.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${sourceBranchId} belongs to tree ${source.treeId}, not ${tree.id}`);
    }
    const anchorTurn = this.repository.getTurn(anchorTurnId as TurnId);
    if (anchorTurn.treeId !== tree.id) {
      throw new InvalidArgumentError(`turn ${anchorTurnId} belongs to tree ${anchorTurn.treeId}, not ${tree.id}`);
    }
    if (typeof selection !== "object" || selection === null) {
      throw new InvalidArgumentError("selection must be a TurnSelection object");
    }
    return this.repository.transaction(() => {
      const branch = this.repository.createBranch(tree.id, { parentBranchId: source.id });
      const origin = this.repository.setBranchOrigin({
        branchId: branch.id,
        sourceBranchId: source.id,
        anchorTurnId: anchorTurn.id,
        anchorEntryId: anchorTurn.piEntryId === null ? "" : anchorTurn.piEntryId,
        selection,
      });
      return { branch, origin };
    });
  }

  /** 切换分支视图并把活动会话对准该分支续聊点（“导航回 Trunk”）。 */
  async switchBranch(treeId: TreeId, branchId: BranchId): Promise<SessionCursorInfo | null> {
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const continuation = this.#resolveContinuation(branch);
    if (continuation.kind === "new-session") {
      // 尚无 session：切换只改变视图，首次 prompt 时再新建。
      return null;
    }
    await this.#ensureSessionAt(tree.id, branch.id, continuation);
    return this.#cursorInfo(treeId);
  }

  async revealBranchOrigin(treeId: TreeId, branchId: BranchId): Promise<AnchorLocation> {
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${treeId}`);
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) {
      throw new InvalidArgumentError(`branch ${branchId} has no anchor origin`);
    }
    const source = this.repository.findBranch(origin.sourceBranchId);
    let status = this.#anchorStatus(origin);
    if (status === "available" && source !== null) {
      const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
      if (anchorTurn !== null && anchorTurn.runId !== null) {
        const anchorRun = this.repository.getRun(anchorTurn.runId);
        const target: SessionReference = { ...anchorRun.session, entryId: origin.anchorEntryId };
        try {
          const cursor = this.#cursor;
          const reference =
            cursor !== null && cursor.reference.sessionFile === target.sessionFile
              ? await this.runtime.navigateTree({ entryId: target.entryId })
              : (await this.runtime.restoreSession(target)).reference;
          this.#setCursor(tree.id, source.id, reference);
        } catch {
          status = "unavailable";
        }
      } else {
        status = "unavailable";
      }
    }
    return {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      status,
      selection: origin.selection,
    };
  }

  /* ------------------------------ Return ------------------------------ */

  /**
   * 编辑后显式提交 Return：先把活动会话导航回 Trunk 续聊点，成功后才把
   * Return 记录在 Trunk（含出处分支）；下一次 Trunk prompt 时送入 Pi 上下文
   * （deliveredRunId 落库）。
   *
   * 失败/重试一致性（写入顺序即契约）：导航失败（如 Pi session 文件缺失
   * → session-corrupt）在任何 Return 落库之前抛出，因此同一失败上重试
   * 不会产生重复的 Return turn；导航成功后写入失败时，重试只会补写一次。
   * Trunk 尚无 session（new-session）时不导航、不建 session（与
   * switchBranch 语义一致），Return 直接落库，待首次 Trunk prompt 时建
   * session 并送达。
   */
  async submitReturn(treeId: TreeId, fromBranchId: BranchId, text: string): Promise<Turn> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("return text must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(fromBranchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${fromBranchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) {
      throw new InvalidArgumentError(
        `branch ${fromBranchId} has no origin; only anchored branches can submit a return`,
      );
    }
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null);
    if (trunk === undefined) {
      throw new InvalidArgumentError(`tree ${tree.id} has no trunk (root) branch`);
    }
    // 先导航后写入：导航失败（运行期 TreeAIError，如 session 文件缺失）
    // 在任何 Return 持久化之前抛出 → 重试不产生重复 Return。
    await this.switchBranch(tree.id, trunk.id);
    const episode = this.repository.createEpisode(trunk.id);
    return this.repository.createTurn({
      treeId: tree.id,
      branchId: trunk.id,
      episodeId: episode.id,
      role: "return",
      text,
      fromBranchId: branch.id,
    });
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async dispose(): Promise<void> {
    this.#cursor = null;
    this.#activeRun = null;
    await this.runtime.dispose();
  }
}
