/** Pi continuation and cursor coordination; saved DB facts remain independent of session availability. */
import {
  existsSync,
} from "node:fs";
import type {
  Branch,
  BranchId,
  BranchOrigin,
  PiModelSelector,
  PiRuntime,
  Run,
  SessionReference,
  TreeId,
} from "@treeai/contracts";
import {
  InvalidArgumentError,
  type TreeRepository,
} from "@treeai/persistence";
import type {
  AnchorStatus,
  Continuation,
  Cursor,
  SessionCursorInfo,
} from "./model.ts";

export class StudioSessionCoordinator {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  readonly sessionDir: string;
  readonly cwd: string;
  #cursor: Cursor | null = null;
  constructor(options: { repository: TreeRepository; runtime: PiRuntime; model: PiModelSelector; sessionDir: string; cwd: string }) {
    this.repository = options.repository;
    this.runtime = options.runtime;
    this.model = options.model;
    this.sessionDir = options.sessionDir;
    this.cwd = options.cwd;
  }
  get cursor(): Cursor | null { return this.#cursor; }
  clearCursor(): void { this.#cursor = null; }

  cursorInfo(treeId: TreeId): SessionCursorInfo | null {
    const cursor = this.#cursor;
    if (cursor !== null && cursor.treeId === treeId) {
      return { treeId, branchId: cursor.branchId, entryId: cursor.reference.entryId };
    }
    const persisted = this.repository.findActiveNavigation(treeId);
    return persisted === null
      ? null
      : { treeId, branchId: persisted.branchId, entryId: persisted.reference.entryId };
  }

  setCursor(treeId: TreeId, branchId: BranchId, reference: SessionReference): void {
    this.#cursor = { treeId, branchId, reference };
    this.repository.saveActiveNavigation(treeId, branchId, reference);
  }

  /**
   * 锚点完整性三态（signed v3 §1.2：来源定位读**产品原文、版本/切片与
   * 身份**，与 session 可用性无关——session 损害是续聊维度的事实，不再
   * 降格来源状态；删除 session 后数据库原文仍可准确定位揭示）：
   * - unavailable：出处分支或锚点 turn 已不存在（事实缺失）；
   * - changed：事实尚在但锚点不变量破坏（branchId/role/piEntryId/偏移/
   *   切片失配，或锚点 runId 悬空——模式完整性违规）；
   * - available：以上全部不成立——来源身份与文本未变，可准确定位。
   */
  anchorStatus(origin: BranchOrigin): AnchorStatus {
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
    return this.repository.findRun(anchorTurn.runId) === null ? "changed" : "available";
  }

  /**
   * 分支续聊点的会话引用（只读推导；与 #resolveContinuation 同源但不抛错，
   * 供 A4 可用性展示用）：latest run 的引用；无 run 的分支用 origin 锚点
   * run 的引用 + anchorEntryId。返回 null = 尚无会话（或锚点退化不可读）。
   */
  continuationReference(branch: Branch): SessionReference | null {
    const episodes = this.repository.listEpisodes(branch.id);
    let latestRun: Run | null = null;
    for (const episode of episodes) {
      const runs = this.repository.listRuns(episode.id);
      if (runs.length > 0) latestRun = runs[runs.length - 1]!;
    }
    if (latestRun !== null) return latestRun.session;
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) return null;
    const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
    if (anchorTurn === null || anchorTurn.runId === null) return null;
    const anchorRun = this.repository.findRun(anchorTurn.runId);
    if (anchorRun === null) return null;
    return { ...anchorRun.session, entryId: origin.anchorEntryId };
  }

  /**
   * A4 会话可用性评估：以实时文件存在性探针（只探存在，**绝不读取
   * session 内容**——与 persistence 默认探针同纪律）修正 DB 缓存评估：
   * - DB available 且文件在 → available；DB available 但文件缺 → unavailable；
   * - DB 因 missing-file 降级且文件已恢复 → available（降级可修复）；
   * - DB 因其他原因（version-mismatch/corrupt）降级 → 维持 unavailable
   *   （存在性探针看不见这些原因，不谎报恢复）；
   * - 内存会话（无 sessionFile）→ unavailable（不可恢复）。
   */
  probeSessionAvailability(reference: SessionReference): "available" | "unavailable" {
    if (reference.sessionFile === "") return "unavailable";
    if (reference.availability.status === "available") {
      return existsSync(reference.sessionFile) ? "available" : "unavailable";
    }
    return reference.availability.reason === "missing-file" && existsSync(reference.sessionFile)
      ? "available"
      : "unavailable";
  }

  branchSessionAvailability(branch: Branch): "available" | "unavailable" | null {
    const reference = this.continuationReference(branch);
    return reference === null ? null : this.probeSessionAvailability(reference);
  }


  /** 分支的续聊点（全部可从 DB 重建）。 */
  resolveContinuation(branch: Branch): Continuation {
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
    if (this.repository.hasMaterialBranchOrigin(branch.id)) {
      // 材料分支（D4-3，ADR-004 决策一）：无 run 且无 Turn 来源时，续聊点 =
      // new-session——材料来源没有 Pi 分叉点（charter §3.3「材料没有天然
      // Pi 分叉点」），首问以显式材料上下文开**独立** session（不伪造历史、
      // 不挂靠树内任何既有运行/会话）；有 run 后照常走上方 latest run 引用。
      return { kind: "new-session" };
    }
    if (branch.parentBranchId === null) {
      return { kind: "new-session" };
    }
    throw new InvalidArgumentError(
      `branch ${branch.id} has no continuation point (no runs and no origin)`,
    );
  }

  /** 把活动 Pi 会话对准续聊点（cursor 只是缓存，真实位置以 DB 为准）。 */
  async ensureSessionAt(treeId: TreeId, branchId: BranchId, continuation: Continuation): Promise<SessionReference> {
    if (continuation.kind === "new-session") {
      const snapshot = await this.runtime.createSession({
        model: this.model,
        cwd: this.cwd,
        sessionDir: this.sessionDir,
      });
      this.setCursor(treeId, branchId, snapshot.reference);
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
      this.setCursor(treeId, branchId, cursor.reference);
      return cursor.reference;
    }
    let reference: SessionReference;
    if (cursor !== null && cursor.reference.sessionFile === target.sessionFile) {
      // 同一 session 文件：navigateTree 移动叶指针（不换 session、不换文件）。
      reference = await this.runtime.navigateTree({ entryId: target.entryId });
    } else {
      reference = (await this.runtime.restoreSession(target)).reference;
    }
    this.setCursor(treeId, branchId, reference);
    return reference;
  }
}
