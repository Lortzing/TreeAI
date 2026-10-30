import {
  StudioReadModels,
} from "./read-models.ts";
import {
  StudioReturnCoordinator,
} from "./return-coordinator.ts";
import {
  StudioSessionCoordinator,
} from "./session-coordinator.ts";
import {
  StudioEventObserver,
} from "./event-observer.ts";
/** Studio tree-studio-service ownership; public compatibility exports remain in ../service.ts. */
import {
  NewExplorationConflictError,
  RunNotActiveError,
  toTreeAIError,
} from "./errors.ts";

import type {
  ActiveRunRecord,
  AnchorLocation,
  AnchorNavigationOutcome,
  BranchCreation,
  JournalEventView,
  PromptOptions,
  PromptOutcome,
  ReturnSubmission,
  SessionCursorInfo,
  StudioEventListener,
  TreeDiagnostics,
  TreeState,
  TreeStudioServiceOptions,
} from "./model.ts";
import {
  NEW_EXPLORATION_TURN_PREFIX,
} from "./policy.ts";
import {
  composePromptText,
} from "./prompt-text.ts";
import type {
  Branch,
  BranchId,
  Forest,
  PiModelSelector,
  PiRuntime,
  PiRuntimeEvent,
  Run,
  RunId,
  SessionReference,
  Tree,
  TreeId,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import type {
  EventJournal,
  RecoveryReport,
} from "@treeai/event-journal";
import {
  InvalidArgumentError,
  type TreeRepository,
} from "@treeai/persistence";


/** 安全读取事件 payload 上的字符串字段（缺失/非字符串 → undefined）。 */
export class TreeStudioService {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly #sessions: StudioSessionCoordinator;
  readonly #returns: StudioReturnCoordinator;
  readonly #readModels: StudioReadModels;
  #forest: Forest | null = null;
  /** 单 prompt 操作锁：同一时刻至多一个 prompt 操作（含会话对准阶段）。 */
  #promptInFlight: boolean = false;
  /** 当前在途的 run（run 落库并置 running 后才有值；收敛即清除）。 */
  #activeRun: ActiveRunRecord | null = null;
  /** prompt 会话对准阶段（activeRun 尚未建立）缓冲的运行时事件，待 run 建立后归属。 */
  #promptPrelude: PiRuntimeEvent[] | null = null;
  /** journal 写入（缺省 null = 不记录）。 */
  readonly #journal: EventJournal | null;
  readonly #observer: StudioEventObserver;
  readonly journalRecovery: Promise<RecoveryReport> | null;
  /** 运行时订阅的退订函数（dispose 时释放）。 */
  readonly #unsubscribeRuntime: () => void;

  constructor(options: TreeStudioServiceOptions) {
    this.repository = options.repository;
    this.runtime = options.runtime;
    this.model = options.model;
    this.sessionDir = options.sessionDir;
    this.cwd = options.cwd;
    this.#sessions = new StudioSessionCoordinator({
      repository: this.repository, runtime: this.runtime, model: this.model,
      sessionDir: this.sessionDir, cwd: this.cwd,
    });
    this.#returns = new StudioReturnCoordinator({
      repository: this.repository,
      switchBranch: (treeId, branchId) => this.switchBranch(treeId, branchId),
    });
    this.#journal = options.journal ?? null;
    this.#observer = new StudioEventObserver({
      journal: this.#journal,
      getActiveRun: () => this.#activeRun,
      getPrelude: () => this.#promptPrelude,
    });
    this.journalRecovery = this.#observer.journalRecovery;
    this.#readModels = new StudioReadModels({
      repository: this.repository, sessions: this.#sessions, observer: this.#observer,
      journal: this.#journal, getActiveRun: () => this.#activeRun,
    });
    // 事件面：订阅运行时事件（会话替换后保持有效——契约保证）。
    this.#unsubscribeRuntime = this.runtime.subscribe((event) => {
      this.#observer.handleRuntimeEvent(event);
    });
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

  /* ------------------------------ 事件面 / journal（P1） ------------------------------ */

  subscribeStudioEvents(listener: StudioEventListener): () => void {
    return this.#observer.subscribeStudioEvents(listener);
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
  getTreeState(treeId: TreeId): TreeState { return this.#readModels.getTreeState(treeId); }


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
   *
   * 事件面（P1）：run 落库后推送 run-started；收敛（成功/失败/中止）推送
   * run-terminal。会话对准失败（如 session-corrupt）发生在 run 创建之前
   * ——无部分写入，也无事件（HTTP 错误与 sessionAvailability 展示降级）。
   *
   * Journal 面（P1，注入 journal 时）：对准阶段事件（session.* /
   * tree.navigated）缓冲后归属本次创建的 run；run 落库记录显式
   * queued→running；运行期事件实时归属。收敛由运行时事件派生（见文件头）。
   */
  async prompt(treeId: TreeId, branchId: BranchId, text: string, options?: PromptOptions): Promise<PromptOutcome> {
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
    const prelude: PiRuntimeEvent[] = [];
    this.#promptPrelude = prelude;
    try {
      let continuation = this.#sessions.resolveContinuation(branch);
      /* 新探索（signed v3 §4.4）：仅在续聊点 session 当前不可用时成立。
         校验与续聊点解析同在操作锁内——判负零写入（无 session/run/turn）。 */
      let explorationPrefix: string | null = null;
      if (options?.newExploration === true) {
        if (continuation.kind !== "reference") {
          throw new NewExplorationConflictError(
            `branch ${branchId} has no prior session to start a new exploration from; a normal prompt will create one`,
          );
        }
        if (this.#sessions.probeSessionAvailability(continuation.reference) !== "unavailable") {
          throw new NewExplorationConflictError(
            `branch ${branchId} still has an available session; continue with a normal prompt instead of starting a new exploration`,
          );
        }
        explorationPrefix = this.#newExplorationContext(branch, options?.newExplorationMaterialContext);
        continuation = { kind: "new-session" };
      }
      const preRef = await this.#sessions.ensureSessionAt(tree.id, branch.id, continuation);

      // 未送达的 return 在这次 prompt 送入 Pi 上下文。
      const pendingReturns = this.repository
        .listTurns(branch.id)
        .filter((turn) => turn.role === "return" && turn.deliveredRunId === null);
      /* 组合前缀（新探索 / 术语推广）：模型输入面事实，用户 turn 只带显式
         标记（NEW_EXPLORATION_TURN_PREFIX / options.turnPrefix）。 */
      const composedPrefix =
        explorationPrefix ?? (options?.composedPrefix === undefined || options.composedPrefix === "" ? null : options.composedPrefix);
      const turnPrefix =
        explorationPrefix !== null ? NEW_EXPLORATION_TURN_PREFIX : options?.turnPrefix ?? null;
      const composedText = composePromptText(pendingReturns, composedPrefix === null ? text : composedPrefix + text);

      const episode = this.repository.createEpisode(branch.id);
      const run = this.repository.createRun(episode.id, preRef);
      // 采用尝试关联（已签署 W1 v3.0 §3.2）：本次 Run 的确定输入（组合
      // 文本）已包含这些 pending Return → 各记一条 Return→Run 关联。
      // Run 结果（succeeded/failed/aborted）由 runs 行自身记录，读取面以
      // 关联 + run 状态联合投影；失败/中止后 Return 保持 pending，
      // 下一次主干 prompt 会再次组装并新增关联（pending 重注入不变）。
      if (pendingReturns.length > 0) {
        this.repository.transaction(() => {
          for (const pending of pendingReturns) {
            this.repository.recordReturnAdoptionAttempt(pending.id, run.id);
          }
        });
      }
      this.repository.updateRunState(run.id, "running");
      this.#activeRun = {
        treeId: tree.id,
        branchId: branch.id,
        episodeId: episode.id,
        runId: run.id,
        abortRequested: false,
      };
      this.#promptPrelude = null;
      // journal：对准阶段事件归属本 run + 显式 queued→running（域归属在此补齐）。
      for (const event of prelude) {
        this.#observer.journalRuntimeEvent(run.id, event);
      }
      this.#observer.journalStateChange(run.id, "queued", "running");
      this.#observer.emitStudio({
        type: "run-started",
        treeId: tree.id,
        branchId: branch.id,
        episodeId: episode.id,
        runId: run.id,
      });

      let result: Awaited<ReturnType<PiRuntime["prompt"]>>;
      try {
        result = await this.runtime.prompt({ text: composedText, ...(options?.model ? { model: options.model } : {}) });
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
          this.#observer.emitStudio({ type: "run-terminal", treeId: tree.id, runId: run.id, state: "aborted", failure: null });
          if (record !== null && record.abortRequested && preRef.entryId !== "") {
            // 会话叶指针回位到本次 prompt 的续聊点（append-only 树不删条目），
            // 保证中止后同进程续聊与重启后语义一致；尽力而为，失败时清空
            // 内存 cursor，让下一次 prompt 走 restoreSession 自愈。
            try {
              await this.runtime.navigateTree({ entryId: preRef.entryId });
            } catch {
              this.#sessions.clearCursor();
            }
          }
        } else {
          this.repository.updateRunState(run.id, "failed", { failure: error });
          this.#observer.emitStudio({
            type: "run-terminal",
            treeId: tree.id,
            runId: run.id,
            state: "failed",
            failure: { code: error.code, message: error.message },
          });
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
          /* 转录标记（新探索 v3 §4.4 / 术语推广）：服务端生成的显式前缀随
             用户 turn 落库——数据库层面可审计该回合的输入语境；用户输入
             原文保持在其后完整可读。 */
          text: turnPrefix === null ? text : `${turnPrefix}\n\n${text}`,
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
        // 首次成功采用标记（条件 UPDATE：至多写一次；此前的失败/中止尝试
        // 只留在 return_adoption_attempts，Return 的 pending 过滤随之解除）。
        for (const pending of pendingReturns) {
          this.repository.markReturnDelivered(pending.id, run.id);
        }
        return { userTurn, assistantTurn };
      });

      this.#sessions.setCursor(tree.id, branch.id, result.reference);
      this.#observer.emitStudio({ type: "run-terminal", treeId: tree.id, runId: run.id, state: "succeeded", failure: null });
      return {
        run: this.repository.getRun(run.id),
        userTurn: outcome.userTurn,
        assistantTurn: outcome.assistantTurn,
        deliveredReturns: pendingReturns.length,
      };
    } finally {
      this.#promptPrelude = null;
      this.#promptInFlight = false;
      // journal 落盘排空（确定性：prompt settle 时该 run 的全部 journal 事件已写入）。
      await this.#observer.flushJournal();
    }
  }

  /**
   * 新探索的首问上下文（v3 §4.4「明确带入摘录/收获以及旧运行上下文缺失」）：
   * 一段服务端生成的说明块，随首问文本一起送入新 session——
   * - 显式声明：这是从保存内容开始的新探索，旧运行上下文**未恢复**；
   * - 材料来源上下文块（D4-3，ADR-004：材料分支无 Turn 来源摘录，由材料
   *   建枝服务组合的「标题/版本 + 选区摘录 + 有界邻近窗口」经
   *   PromptOptions.newExplorationMaterialContext 注入——材料上下文是真实
   *   输入，不是恢复的历史）；
   * - 锚点摘录（Turn 来源分支：origin 的选区快照，来源关系随 origin 保持不动）；
   * - 分支已保存历史（该分支全部 turn，作为文本重新带入，不是会话恢复）。
   */
  #newExplorationContext(branch: Branch, materialContext?: string): string {
    const lines: string[] = [
      "[New exploration on this branch — the previous session is no longer available and was not restored. " +
        "The anchored excerpt and the saved history below are re-included as the starting context; " +
        "the earlier run context is missing.]",
    ];
    if (materialContext !== undefined && materialContext.length > 0) {
      lines.push("", "[Material source context]:", materialContext);
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin !== null) {
      lines.push("", `[Anchored excerpt]: "${origin.selection.text}"`);
    }
    const turns = this.repository.listTurns(branch.id);
    if (turns.length > 0) {
      lines.push("", "[Saved history on this branch]:");
      for (const turn of turns) {
        lines.push(`${turn.role}: ${turn.text}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  /**
   * 「以保存内容开始新的探索」（signed v3 §4.4）：用户显式确认后，在该
   * 分支上以全新 session 续聊——锚点摘录与已保存历史作为首问上下文带入
   * （#newExplorationContext），旧运行上下文缺失如实声明，用户 turn 携带
   * 新探索标记。前置条件（不满足 → NewExplorationConflictError 409，零
   * 写入）：分支有历史 session 且当前不可用。成功后分支续聊点 = 新
   * session，旧历史保持可读；返回与 prompt 相同的 PromptOutcome。
   */
  async promptNewExploration(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    return this.prompt(treeId, branchId, text, { newExploration: true });
  }

  /* ------------------------------ 中止 ------------------------------ */

  /**
   * 请求中止该树当前在途的 run。校验目标确为该树的活动 run（未知树/run →
   * EntityNotFoundError；空 id/跨树 run → InvalidArgumentError；非活动 run
   * → RunNotActiveError，均为操作冲突语义），然后调用 runtime.abort()；
   * 在途 prompt 随后以 TreeAIError（code "user-abort"）收敛，run 落库为
   * aborted（见 prompt 的收敛路径）。幂等；若 prompt 已先一步 settle，
   * 本次请求不产生效果（不撒谎、不改写结果）。
   *
   * 事件面：校验通过即推送 abort-requested（诊断面同步可见 aborting）。
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
    this.#observer.emitStudio({ type: "abort-requested", treeId: tree.id, runId: run.id });
    this.#observer.journalAbortRequested(run.id);
    await this.runtime.abort();
  }
  getTreeDiagnostics(treeId: TreeId): TreeDiagnostics { return this.#readModels.getTreeDiagnostics(treeId); }

  getTreeJournal(treeId: TreeId, limit = 50): readonly JournalEventView[] { return this.#readModels.getTreeJournal(treeId, limit); }


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
    const continuation = this.#sessions.resolveContinuation(branch);
    if (continuation.kind === "new-session") {
      // 尚无 session：切换只改变视图，首次 prompt 时再新建。
      return null;
    }
    await this.#sessions.ensureSessionAt(tree.id, branch.id, continuation);
    return this.#sessions.cursorInfo(treeId);
  }

  /**
   * 锚点揭示（signed v3 §1.2：来源定位与 Pi 游标对齐分离）：
   * 1. **纯产品定位**（status/selection）读数据库原文、版本/切片与身份
   *    判定（#anchorStatus），与 session 可用性无关——session 文件缺失/
   *    损坏时 status 仍为 available，数据库原文照常可定位高亮；文本
   *    changed 时拒绝假定位（返回落库快照原文，不回退、不静默重锚）。
   * 2. status === "available" 时**另行尝试**把活动 Pi 会话对准锚点条目
   *    （navigateTree / restoreSession）：成功 → navigation "navigated"
   *    （游标落出处分支）；失败 → navigation "failed"（code/message 如实
   *    携带），**不降格来源状态**（揭示的产品定位仍然准确）。锚点
   *    session 经存在性探针判不可用时不再发起运行期调用（同样的失败，
   *    少一次注定失败的 restore）。
   */
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
    const status = this.#sessions.anchorStatus(origin);
    let navigation: AnchorNavigationOutcome | null = null;
    if (status === "available" && source !== null) {
      // #anchorStatus === "available" 保证锚点 turn/run 存在且不变量完好。
      const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
      if (anchorTurn !== null && anchorTurn.runId !== null) {
        const anchorRun = this.repository.getRun(anchorTurn.runId);
        const target: SessionReference = { ...anchorRun.session, entryId: origin.anchorEntryId };
        if (this.#sessions.probeSessionAvailability(anchorRun.session) === "unavailable") {
          // 锚点 session 判不可用（存在性探针）：不发起注定失败的运行期
          // 调用，游标不动，对齐失败如实分离返回（来源定位不受影响）。
          navigation = {
            status: "failed",
            code: "session-corrupt",
            message: "the anchor session is unavailable; the source text was located from the database",
          };
        } else {
          try {
            const cursor = this.#sessions.cursor;
            const reference =
              cursor !== null && cursor.reference.sessionFile === target.sessionFile
                ? await this.runtime.navigateTree({ entryId: target.entryId })
                : (await this.runtime.restoreSession(target)).reference;
            this.#sessions.setCursor(tree.id, source.id, reference);
            navigation = { status: "navigated" };
          } catch (error) {
            const treeAIError = toTreeAIError(error);
            navigation = { status: "failed", code: treeAIError.code, message: treeAIError.message };
          }
        }
      }
    }
    return {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      status,
      selection: origin.selection,
      navigation,
    };
  }

  /* ------------------------------ Return ------------------------------ */

  /**
   * 编辑后显式提交 Return（幂等）：idempotencyKey 标识一次逻辑提交
   * （客户端生成，跨失败重试保持稳定），targetAnchor 为提交时出处分支
   * origin 的快照（原分叉点的展示定位）。
   *
   * 写入顺序即契约（已签署 W1 v3.0 §3.5：先保存，后导航）：
   * 1. 校验产品对象（tree/branch/出处 origin/Trunk 定位）与提交身份；
   * 2. 幂等重放检查（零写入）：同键同内容（fromBranchId + text）→
   *    直接返回既有 Return（created === false）；同键不同内容 →
   *    ReturnConflictError（零写入，不尝试导航）。响应丢失后的客户端
   *    重试因此不会产生第二条 Return；
   * 3. 单事务落库（episode + return turn）——Return 的可靠保存不以
   *    Pi 导航成功为前提：session 缺失/损坏、无 session 的新 Trunk 均
   *    照常保存。并发同键竞争由树内唯一索引 UNIQUE(tree_id,
   *    idempotency_key) 裁决：判负方事务整体回滚（无悬挂 episode），
   *    按键重读——同内容返回既有 Return（created === false），不同
   *    内容 ReturnConflictError；
   * 4. 保存成功后再尝试回程导航（switchBranch 对准 Trunk 续聊点）。
   *    导航失败不回滚、不抛错：结果如实随 ReturnSubmission.navigation
   *    返回（failed + code/message），由 HTTP/UI 分开呈现「已保存，
   *    返回主线失败」；重放路径同样尝试导航（重试即重新导航的载体）。
   *    Trunk 尚无 session（new-session）→ navigation "no-session"
   *    （无可导航对象；首次 Trunk prompt 时建立 session 并采用，
   *    见 prompt / markReturnDelivered）。
   */
  async submitReturn(
    treeId: TreeId,
    fromBranchId: BranchId,
    text: string,
    idempotencyKey: string,
  ): Promise<ReturnSubmission> {
    return this.#returns.submitReturn(treeId, fromBranchId, text, idempotencyKey);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /**
   * 释放服务侧资源：退订运行时事件、清空事件监听者、释放 runtime。
   * journal 的 close 仍由宿主拥有（close 排空内部写入队列，保证剩余
   * journal 事件落盘）——本方法只尽力等待当前已排队的写入。
   */
  async dispose(): Promise<void> {
    this.#sessions.clearCursor();
    this.#activeRun = null;
    this.#promptPrelude = null;
    await this.runtime.dispose();
    this.#unsubscribeRuntime();
    this.#observer.clearListeners();
    await this.#observer.flushJournal();
  }
}
