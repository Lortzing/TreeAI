/** navigation SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";
import {
  type ActiveNavigationRow,
  type NavExpandStateRow,
  rowToActiveNavigation,
  rowToNavExpandState,
} from "../serialization.ts";
import type {
  ActiveNavigation,
  BranchRecovery,
  EpisodeRecovery,
  TreeRecovery,
} from "./model.ts";
import {
  NAV_EXPAND_STATE_MAX_BRANCHES,
} from "./policy.ts";
import {
  assertNonEmptyString,
  assertValidSessionReference,
  availabilityToColumns,
} from "./validation.ts";
import type {
  BranchId,
  NavTreeExpandState,
  SessionReference,
  TreeId,
} from "@treeai/contracts";

import type {
  TreeDomainContext,
} from "./context.ts";

export class TreeNavigationRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }


  saveActiveNavigation(treeId: TreeId, branchId: BranchId, reference: SessionReference): ActiveNavigation {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(branchId, "branch id");
    assertValidSessionReference(reference, "active navigation reference");
    const tree = this.#context.repository.findTree(treeId);
    if (tree === null) throw new EntityNotFoundError("tree", treeId);
    const branch = this.#context.repository.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${treeId}`);
    }
    const availability = availabilityToColumns(reference.availability);
    const updatedAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO tree_active_navigation
             (tree_id, branch_id, session_id, session_file, entry_id, pi_version,
              availability_status, availability_reason, availability_detail, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tree_id) DO UPDATE SET
             branch_id = excluded.branch_id,
             session_id = excluded.session_id,
             session_file = excluded.session_file,
             entry_id = excluded.entry_id,
             pi_version = excluded.pi_version,
             availability_status = excluded.availability_status,
             availability_reason = excluded.availability_reason,
             availability_detail = excluded.availability_detail,
             updated_at = excluded.updated_at`,
        )
        .run(
          treeId,
          branchId,
          reference.sessionId,
          reference.sessionFile,
          reference.entryId,
          reference.piVersion,
          availability.status,
          availability.reason,
          availability.detail,
          updatedAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "saving active navigation");
    }
    return this.findActiveNavigation(treeId)!;
  }


  findActiveNavigation(treeId: TreeId): ActiveNavigation | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const row = this.#context.database()!
      .prepare(
        `SELECT tree_id, branch_id, session_id, session_file, entry_id, pi_version,
                availability_status, availability_reason, availability_detail, updated_at
         FROM tree_active_navigation WHERE tree_id = ?`,
      )
      .get(treeId) as ActiveNavigationRow | undefined;
    return row ? rowToActiveNavigation(row) : null;
  }


  /* ------------------------------ 树导航展开状态（issue #8 D4-8，migration 0010） ------------------------------ */

  /**
   * 整组写入某树的导航展开状态（PK tree_id 的 UPSERT）。
   *
   * 校验（全部先于任何写入）：
   * - 树存在（否则 EntityNotFound）；
   * - expandedBranchIds 每个成员存在且属于该树（幽灵/跨树 id 拒绝）；
   * - selectedBranchId 存在且属于该树（null = 未选，诚实空态）；
   * - 去重保序（按提交序保留首个出现）；总量 ≤ 上限（有界状态）。
   */
  saveNavExpandState(input: {
    readonly treeId: TreeId;
    readonly expandedBranchIds: readonly BranchId[];
    readonly selectedBranchId: BranchId | null;
  }): NavTreeExpandState {
    this.#context.assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    if (!Array.isArray(input.expandedBranchIds)) {
      throw new InvalidArgumentError("expandedBranchIds must be an array of branch ids");
    }
    if (input.expandedBranchIds.length > NAV_EXPAND_STATE_MAX_BRANCHES) {
      throw new InvalidArgumentError(
        `expandedBranchIds must hold at most ${String(NAV_EXPAND_STATE_MAX_BRANCHES)} ids (got ${String(input.expandedBranchIds.length)})`,
      );
    }
    const db = this.#context.database()!;
    if (db.prepare("SELECT id FROM trees WHERE id = ?").get(input.treeId) === undefined) {
      throw new EntityNotFoundError("tree", input.treeId);
    }
    const seen = new Set<string>();
    const expanded: string[] = [];
    for (const branchId of input.expandedBranchIds) {
      if (typeof branchId !== "string" || branchId.length === 0) {
        throw new InvalidArgumentError("expandedBranchIds members must be non-empty strings");
      }
      if (seen.has(branchId)) continue;
      const row = db.prepare("SELECT tree_id FROM branches WHERE id = ?").get(branchId) as
        | { tree_id: string }
        | undefined;
      if (row === undefined) throw new EntityNotFoundError("branch", branchId);
      if (row.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${branchId} belongs to tree ${row.tree_id}, not ${input.treeId}`,
        );
      }
      seen.add(branchId);
      expanded.push(branchId);
    }
    let selectedBranchId: string | null = null;
    if (input.selectedBranchId !== null) {
      const row = db
        .prepare("SELECT tree_id FROM branches WHERE id = ?")
        .get(input.selectedBranchId) as { tree_id: string } | undefined;
      if (row === undefined) throw new EntityNotFoundError("branch", input.selectedBranchId);
      if (row.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${input.selectedBranchId} belongs to tree ${row.tree_id}, not ${input.treeId}`,
        );
      }
      selectedBranchId = input.selectedBranchId;
    }
    const updatedAt = this.#context.now();
    try {
      db.prepare(
        `INSERT INTO nav_tree_expand_state
           (tree_id, expanded_branch_ids_json, selected_branch_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tree_id) DO UPDATE SET
           expanded_branch_ids_json = excluded.expanded_branch_ids_json,
           selected_branch_id = excluded.selected_branch_id,
           updated_at = excluded.updated_at`,
      ).run(input.treeId, JSON.stringify(expanded), selectedBranchId, updatedAt);
    } catch (error) {
      throw mapSqliteError(error, "saving nav expand state");
    }
    return {
      treeId: input.treeId,
      expandedBranchIds: expanded as BranchId[],
      selectedBranchId: selectedBranchId as BranchId | null,
      updatedAt,
    };
  }


  /** 读取某树的导航展开状态（无则 null——诚实空态，不伪造默认展开）。 */
  findNavExpandState(treeId: TreeId): NavTreeExpandState | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const row = this.#context.database()!
      .prepare(
        `SELECT tree_id, expanded_branch_ids_json, selected_branch_id, updated_at
         FROM nav_tree_expand_state WHERE tree_id = ?`,
      )
      .get(treeId) as NavExpandStateRow | undefined;
    return row === undefined ? null : rowToNavExpandState(row);
  }


  /* ------------------------------ 恢复查询 ------------------------------ */

  /** 分支恢复信息：树/森林定位、父分支、全部 episode 与 run（含最新 run 的 session 引用与 availability）。 */
  getBranchRecovery(branchId: BranchId): BranchRecovery {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const branch = this.#context.repository.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    const tree = this.#context.repository.getTree(branch.treeId);
    const forest = this.#context.repository.getForest(tree.forestId);
    const parent = branch.parentBranchId !== null ? this.#context.repository.findBranch(branch.parentBranchId) : null;

    const episodes = this.#context.repository.listEpisodes(branchId);
    const episodeRecoveries: EpisodeRecovery[] = episodes.map((episode) => {
      const runs = this.#context.repository.listRuns(episode.id);
      return { episode, runs, latestRun: runs.length > 0 ? runs[runs.length - 1]! : null };
    });
    const latestRun =
      episodeRecoveries.length > 0
        ? episodeRecoveries[episodeRecoveries.length - 1]!.latestRun
        : null;
    return { forest, tree, branch, parentBranch: parent, episodes: episodeRecoveries, latestRun };
  }


  /** 树恢复信息：全部分支的恢复信息（Wave 2 双分支恢复场景的输入）。 */
  getTreeRecovery(treeId: TreeId): TreeRecovery {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const tree = this.#context.repository.getTree(treeId);
    const forest = this.#context.repository.getForest(tree.forestId);
    const branches = this.#context.repository.listBranches(treeId);
    const branchRecoveries = branches.map((b) => this.getBranchRecovery(b.id));
    return { forest, tree, branches: branchRecoveries };
  }
}
