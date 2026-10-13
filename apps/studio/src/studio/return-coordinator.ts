/** Tree-scoped Return identity and atomic save; navigation failure never erases the saved fact. */
import {
  ConstraintViolationError,
  InvalidArgumentError,
  type TreeRepository,
} from "@treeai/persistence";
import type {
  BranchId,
  ReturnTargetAnchor,
  TreeId,
  Turn,
} from "@treeai/contracts";
import type {
  ReturnNavigationOutcome,
  ReturnSubmission,
  SessionCursorInfo,
} from "./model.ts";
import {
  ReturnConflictError,
  toTreeAIError,
} from "./errors.ts";

export class StudioReturnCoordinator {
  readonly repository: TreeRepository;
  readonly #switchBranch: (treeId: TreeId, branchId: BranchId) => Promise<SessionCursorInfo | null>;
  constructor(options: {
    repository: TreeRepository;
    switchBranch: (treeId: TreeId, branchId: BranchId) => Promise<SessionCursorInfo | null>;
  }) {
    this.repository = options.repository;
    this.#switchBranch = options.switchBranch;
  }

  async submitReturn(
    treeId: TreeId,
    fromBranchId: BranchId,
    text: string,
    idempotencyKey: string,
  ): Promise<ReturnSubmission> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("return text must be a non-empty string");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new InvalidArgumentError("return idempotencyKey must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(fromBranchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${fromBranchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null);
    if (trunk === undefined) {
      throw new InvalidArgumentError(`tree ${tree.id} has no trunk (root) branch`);
    }
    // 幂等重放（先于任何写入）：同键同内容 → 既有 Return；同键异容 → 冲突。
    const replay = this.repository.findReturnByIdempotencyKey(tree.id, idempotencyKey);
    if (replay !== null) {
      const turn = this.#alignWithExistingReturn(idempotencyKey, replay, branch.id, text);
      return { turn, created: false, navigation: await this.#navigateBackToTrunk(tree.id, trunk.id) };
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    const isMaterialBranch = origin === null && this.repository.hasMaterialBranchOrigin(branch.id);
    if (origin === null && !isMaterialBranch) {
      throw new InvalidArgumentError(
        `branch ${fromBranchId} has no origin; only anchored branches can submit a return`,
      );
    }
    /* 材料 Branch 的 Return（D4-3，ADR-004）：targetAnchor 为 **null**——材料
       来源没有主线对话锚点，绝不伪造一个（charter §3.3「没有主线对话锚点时
       按确认时间放置并提供原文跳转」）；卡片数据（材料标题/版本/块/摘录/
       确认时间/采用记录）由材料建枝服务的读面从不可变材料来源 + return
       turn 派生。保存与导航解耦、采用尝试/成功分离等语义与 Turn 来源
       Return 完全共用（同一 submitReturn 路径）。 */
    const targetAnchor: ReturnTargetAnchor | null =
      origin === null
        ? null
        : {
            sourceBranchId: origin.sourceBranchId,
            anchorTurnId: origin.anchorTurnId,
            anchorEntryId: origin.anchorEntryId,
            selection: origin.selection,
          };
    let turn: Turn;
    try {
      // 单事务：唯一索引判负时 episode 随 return 一并回滚，不留悬挂回合。
      turn = this.repository.transaction(() => {
        const episode = this.repository.createEpisode(trunk.id);
        return this.repository.createTurn({
          treeId: tree.id,
          branchId: trunk.id,
          episodeId: episode.id,
          role: "return",
          text,
          fromBranchId: branch.id,
          idempotencyKey,
          targetAnchor,
        });
      });
    } catch (error) {
      // 并发同键竞争：唯一索引判负 → 事务已回滚，按键重读并按内容对齐；
      // 非同键竞争的约束失败（重读为空）原样上抛。
      if (error instanceof ConstraintViolationError) {
        const raced = this.repository.findReturnByIdempotencyKey(tree.id, idempotencyKey);
        if (raced !== null) {
          return {
            turn: this.#alignWithExistingReturn(idempotencyKey, raced, branch.id, text),
            created: false,
            navigation: await this.#navigateBackToTrunk(tree.id, trunk.id),
          };
        }
      }
      throw error;
    }
    // 保存成功后再导航：失败不回滚、不抛错（结果分离呈现，signed v3 §3.5）。
    const navigation = await this.#navigateBackToTrunk(tree.id, trunk.id);
    return { turn, created: true, navigation };
  }

  /**
   * 保存后的回程导航尝试（对准 Trunk 续聊点）。Trunk 尚无 session →
   * "no-session"（无可导航对象）；导航成功 → "navigated"；失败 →
   * "failed" + TreeAIError code/message（导航失败绝不影响已保存的 Return）。
   */
  async #navigateBackToTrunk(treeId: TreeId, trunkId: BranchId): Promise<ReturnNavigationOutcome> {
    try {
      const cursor = await this.#switchBranch(treeId, trunkId);
      return cursor === null ? { status: "no-session" } : { status: "navigated" };
    } catch (error) {
      const treeAIError = toTreeAIError(error);
      return { status: "failed", code: treeAIError.code, message: treeAIError.message };
    }
  }

  /** 同键内容比对：与既有 Return 一致则返回它，否则抛 ReturnConflictError（差异定位进消息）。 */
  #alignWithExistingReturn(
    idempotencyKey: string,
    existing: Turn,
    fromBranchId: BranchId,
    text: string,
  ): Turn {
    if (existing.fromBranchId === fromBranchId && existing.text === text) {
      return existing;
    }
    const differences: string[] = [];
    if (existing.fromBranchId !== fromBranchId) {
      differences.push(`fromBranchId ${fromBranchId} does not match ${existing.fromBranchId}`);
    }
    if (existing.text !== text) {
      differences.push("text differs");
    }
    throw new ReturnConflictError(idempotencyKey, existing.id, differences.join("; "));
  }

}
