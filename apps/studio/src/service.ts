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
 * 已知范围（诚实声明）：不做流式 UI 推送（prompt 请求同步等待收敛）、
 * 不做并发 prompt 串行化（单用户本地工具，UI 禁用重复提交）、
 * 不做 event-journal 集成（D2 审计面留待后续接入）。
 */

import type {
  Branch,
  BranchId,
  BranchOrigin,
  Forest,
  PiModelSelector,
  PiRuntime,
  Run,
  SessionReference,
  Tree,
  TreeAIError,
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
    const views: BranchView[] = branches.map((branch) => ({
      branch,
      origin: this.repository.findBranchOrigin(branch.id),
      turns: this.repository.listTurns(branch.id),
    }));
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

  /* ------------------------------ 会话连续性 ------------------------------ */

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

  /** 在分支上执行一轮 prompt（Episode + Run + user/assistant Turn 落库）。 */
  async prompt(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("prompt text must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }

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

    let result: Awaited<ReturnType<PiRuntime["prompt"]>>;
    try {
      result = await this.runtime.prompt({ text: composedText });
    } catch (err) {
      this.repository.updateRunState(run.id, "failed", { failure: toTreeAIError(err) });
      throw err;
    }

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

  /* ------------------------------ Return ------------------------------ */

  /**
   * 编辑后显式提交 Return：记录在 Trunk（含出处分支），
   * 下一次 Trunk prompt 时送入 Pi 上下文（deliveredRunId 落库）。
   */
  submitReturn(treeId: TreeId, fromBranchId: BranchId, text: string): Turn {
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
    await this.runtime.dispose();
  }
}
