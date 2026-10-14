/** entities SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";
import {
  type BranchRow,
  type ForestRow,
  rowToBranch,
  rowToForest,
  rowToTree,
  type TreeRow,
} from "../serialization.ts";
import type {
  CreateBranchInput,
} from "./model.ts";

import {
  assertNonEmptyString,
} from "./validation.ts";
import type {
  Branch,
  BranchId,
  Forest,
  ForestId,
  Tree,
  TreeId,
} from "@treeai/contracts";

import type {
  TreeDomainContext,
} from "./context.ts";

export class TreeEntitiesRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }


  /* ------------------------------ Forest ------------------------------ */

  createForest(input?: { id?: ForestId }): Forest {
    this.#context.assertOpen();
    const id = input?.id ?? (this.#context.newId("forest") as ForestId);
    assertNonEmptyString(id, "forest id");
    const createdAt = this.#context.now();
    try {
      this.#context.database()!.prepare("INSERT INTO forests (id, created_at) VALUES (?, ?)").run(id, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating forest");
    }
    return { id, createdAt };
  }


  getForest(id: ForestId): Forest {
    const found = this.findForest(id);
    if (found === null) throw new EntityNotFoundError("forest", id);
    return found;
  }


  findForest(id: ForestId): Forest | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "forest id");
    const row = this.#context.database()!.prepare("SELECT id, created_at FROM forests WHERE id = ?").get(id) as
      | ForestRow
      | undefined;
    return row ? rowToForest(row) : null;
  }


  listForests(): Forest[] {
    this.#context.assertOpen();
    const rows = this.#context.database()!.prepare("SELECT id, created_at FROM forests ORDER BY created_at, rowid").all() as unknown as ForestRow[];
    return rows.map(rowToForest);
  }


  /* ------------------------------ Tree ------------------------------ */

  createTree(forestId: ForestId, input?: { id?: TreeId }): Tree {
    this.#context.assertOpen();
    assertNonEmptyString(forestId, "forest id");
    const forest = this.findForest(forestId);
    if (forest === null) throw new EntityNotFoundError("forest", forestId);
    const id = input?.id ?? (this.#context.newId("tree") as TreeId);
    assertNonEmptyString(id, "tree id");
    const createdAt = this.#context.now();
    try {
      this.#context.database()!.prepare("INSERT INTO trees (id, forest_id, created_at) VALUES (?, ?, ?)").run(
        id,
        forestId,
        createdAt,
      );
    } catch (error) {
      throw mapSqliteError(error, "creating tree");
    }
    return { id, forestId, createdAt };
  }


  getTree(id: TreeId): Tree {
    const found = this.findTree(id);
    if (found === null) throw new EntityNotFoundError("tree", id);
    return found;
  }


  findTree(id: TreeId): Tree | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "tree id");
    const row = this.#context.database()!.prepare("SELECT id, forest_id, created_at FROM trees WHERE id = ?").get(id) as
      | TreeRow
      | undefined;
    return row ? rowToTree(row) : null;
  }


  listTrees(forestId: ForestId): Tree[] {
    this.#context.assertOpen();
    assertNonEmptyString(forestId, "forest id");
    const rows = this.#context.database()!
      .prepare("SELECT id, forest_id, created_at FROM trees WHERE forest_id = ? ORDER BY created_at, rowid")
      .all(forestId) as unknown as TreeRow[];
    return rows.map(rowToTree);
  }


  /* ------------------------------ Branch ------------------------------ */

  /**
   * 创建分支。`parentBranchId` 缺省/null = 根分支；给出时必须属于同一 Tree
   * 且不得是自身（双分支场景：从既有分支派生第二分支时指向来源分支）。
   */
  createBranch(treeId: TreeId, input?: CreateBranchInput): Branch {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const tree = this.findTree(treeId);
    if (tree === null) throw new EntityNotFoundError("tree", treeId);
    const parentBranchId = input?.parentBranchId ?? null;
    if (parentBranchId !== null) {
      assertNonEmptyString(parentBranchId, "parent branch id");
      const parent = this.findBranch(parentBranchId);
      if (parent === null) throw new EntityNotFoundError("branch", parentBranchId);
      if (parent.treeId !== treeId) {
        throw new InvalidArgumentError(
          `parent branch ${parentBranchId} belongs to tree ${parent.treeId}, not ${treeId}`,
        );
      }
    }
    const id = input?.id ?? (this.#context.newId("branch") as BranchId);
    assertNonEmptyString(id, "branch id");
    if (id === parentBranchId) {
      throw new InvalidArgumentError(`branch ${id} cannot be its own parent`);
    }
    const createdAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)")
        .run(id, treeId, parentBranchId, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating branch");
    }
    return { id, treeId, parentBranchId, createdAt };
  }


  getBranch(id: BranchId): Branch {
    const found = this.findBranch(id);
    if (found === null) throw new EntityNotFoundError("branch", id);
    return found;
  }


  findBranch(id: BranchId): Branch | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "branch id");
    const row = this.#context.database()!
      .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
      .get(id) as BranchRow | undefined;
    return row ? rowToBranch(row) : null;
  }


  listBranches(treeId: TreeId): Branch[] {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#context.database()!
      .prepare(
        "SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE tree_id = ? ORDER BY created_at, rowid",
      )
      .all(treeId) as unknown as BranchRow[];
    return rows.map(rowToBranch);
  }
}
