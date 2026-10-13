/** Saved product state, adoption attempts, safe diagnostics and journal read projections. */

import {
  StudioSessionCoordinator,
} from "./session-coordinator.ts";
import {
  StudioEventObserver,
} from "./event-observer.ts";

import {
  summarizeJournalEvent,
} from "./event-summary.ts";
import type {
  ActiveRunRecord,
  BranchView,
  JournalEventView,
  ReturnAttemptView,
  RunDiagnostics,
  TreeDiagnostics,
  TreeState,
} from "./model.ts";
import {
  NO_POLICY_DECISIONS_REASON,
} from "./policy.ts";

import type {
  TreeId,
  Turn,
} from "@treeai/contracts";
import type {
  EventJournal,
} from "@treeai/event-journal";
import type {
  TreeRepository,
} from "@treeai/persistence";

export class StudioReadModels {
  readonly repository: TreeRepository;
  readonly #sessions: StudioSessionCoordinator;
  readonly #observer: StudioEventObserver;
  readonly #journal: EventJournal | null;
  readonly #getActiveRun: () => ActiveRunRecord | null;
  constructor(options: { repository: TreeRepository; sessions: StudioSessionCoordinator; observer: StudioEventObserver; journal: EventJournal | null; getActiveRun: () => ActiveRunRecord | null }) {
    this.repository = options.repository;
    this.#sessions = options.sessions;
    this.#observer = options.observer;
    this.#journal = options.journal;
    this.#getActiveRun = options.getActiveRun;
  }


  getTreeState(treeId: TreeId): TreeState {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null) ?? null;
    const views: BranchView[] = branches.map((branch) => {
      const origin = this.repository.findBranchOrigin(branch.id);
      const turns = this.repository.listTurns(branch.id);
      // 采用尝试投影（signed v3 §3.2）：return turns 各自的尝试历史
      // （关联 + Run 结果；安全字段同 RunDiagnostics）。
      const returnAttempts = turns
        .filter((turn) => turn.role === "return")
        .flatMap((turn) => this.#returnAttemptViews(turn));
      return {
        branch,
        origin,
        originStatus: origin === null ? null : this.#sessions.anchorStatus(origin),
        sessionAvailability: this.#sessions.branchSessionAvailability(branch),
        turns,
        returnAttempts,
      };
    });
    return {
      tree,
      trunkBranchId: trunk !== null ? trunk.id : null,
      branches: views,
      cursor: this.#sessions.cursorInfo(tree.id),
    };
  }


  /** 单个 return turn 的采用尝试安全投影（追加序；Run 结果随附，无 session 引用/路径/details）。 */
  #returnAttemptViews(turn: Turn): ReturnAttemptView[] {
    return this.repository.listReturnAdoptionAttempts(turn.id).map((attempt) => {
      const run = this.repository.getRun(attempt.runId);
      return {
        turnId: turn.id,
        runId: attempt.runId,
        runState: run.state,
        failure: run.failure === undefined ? null : { code: run.failure.code, message: run.failure.message },
        attemptedAt: attempt.attemptedAt,
        terminalAt: run.terminalAt,
      };
    });
  }


  /* ------------------------------ 诊断（A5 安全投影） ------------------------------ */

  /**
   * 一棵树的诊断读模型：运行面状态（idle/streaming/aborting）、在途 run
   * 定位、DB 全量 run 的安全投影。刻意排除 session 引用（sessionFile/
   * sessionId/entryId/piVersion/availability）、failure.details、原始
   * cause、命令、主机与目标路径。策略决策如实报告：默认装配（空工具
   * allowlist）下从未观测 → observed=false；注入请求时策略门后观测到的
   * 决定以脱敏投影列出（绝不伪造，也绝不隐瞒已发生的拒绝）。
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
    const active = this.#getActiveRun();
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
      policyDecisions:
        this.#observer.policyObservations.length > 0
          ? { observed: true, decisions: [...this.#observer.policyObservations] }
          : { observed: false, reason: NO_POLICY_DECISIONS_REASON },
    };
  }


  /**
   * 一棵树的 journal 保守投影（P1 来源抽屉的数据面）：该树全部 run 的
   * journal 事件，按写入顺序（全局时序）排列、最新在后；limit 截尾保留
   * 最新 N 条（默认 50，钳制 1..500）。未知树 → EntityNotFoundError
   * （HTTP 404）。未注入 journal 或该树无事件 → 空数组。summary 为
   * 白名单构造的人类可读串（见 summarizeJournalEvent），绝不透出
   * 原始 payload。
   */
  getTreeJournal(treeId: TreeId, limit = 50): readonly JournalEventView[] {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const journal = this.#journal;
    if (journal === null) return [];
    const runIds = this.#treeRunIds(tree.id);
    if (runIds.size === 0) return [];
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
    const events = journal
      .listEvents()
      .filter((event) => runIds.has(event.runId as string))
      .slice(-bounded);
    return events.map((event) => ({
      eventId: event.eventId,
      runId: event.runId,
      seq: event.seq,
      occurredAt: event.occurredAt,
      type: event.type,
      summary: summarizeJournalEvent(event),
    }));
  }


  /** 一棵树全部 run 的 id 集合（journal 过滤用）。 */
  #treeRunIds(treeId: TreeId): Set<string> {
    const runIds = new Set<string>();
    for (const branch of this.repository.listBranches(treeId)) {
      for (const episode of this.repository.listEpisodes(branch.id)) {
        for (const run of this.repository.listRuns(episode.id)) {
          runIds.add(run.id as string);
        }
      }
    }
    return runIds;
  }
}
