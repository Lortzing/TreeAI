/** intents SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";

import type {
  CreateMaterialBranchInput,
  CreateMaterialBranchResult,
  FirstQuestionRow,
  InsertFirstQuestionInput,
  InsertFirstQuestionResult,
  MaterialBranchOriginRow,
  MaterialFirstQuestion,
} from "./model.ts";

import {
  rowToFirstQuestion,
  rowToMaterialBranchOrigin,
} from "./serialization.ts";
import {
  assertNonEmptyString,
  assertValidSelectionShape,
} from "./validation.ts";
import type {
  BranchId,
  IsoTimestamp,
  TreeId,
} from "@treeai/contracts";


import type {
  MaterialDomainContext,
} from "./context.ts";

export class MaterialIntentsRepository {
  readonly #context: MaterialDomainContext;
  constructor(context: MaterialDomainContext) { this.#context = context; }


  /* ------------------------------ 首问幂等 ------------------------------ */

  /**
   * 记录材料首问的提交意图（ADR-003 §4：树内幂等键）。
   * PRIMARY KEY(tree_id, intent_key)：双击、响应丢失重试、进程重启重放
   * 同一键 → 返回既有行（replayed=true，同一 Branch，至多派发一次首问）。
   */
  insertFirstQuestion(input: InsertFirstQuestionInput): InsertFirstQuestionResult {
    this.#context.assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.intentKey, "intent key");
    return this.#context.repository.transaction((): InsertFirstQuestionResult => {
      const db = this.#context.database()!;
      const tree = db.prepare("SELECT id FROM trees WHERE id = ?").get(input.treeId);
      if (tree === undefined) throw new EntityNotFoundError("tree", input.treeId);
      const branch = db
        .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
        .get(input.branchId) as { id: string; tree_id: string } | undefined;
      if (branch === undefined) throw new EntityNotFoundError("branch", input.branchId);
      if (branch.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${input.branchId} belongs to tree ${branch.tree_id}, not ${input.treeId}`,
        );
      }
      const existing = db
        .prepare("SELECT intent_key, tree_id, branch_id, created_at FROM material_first_questions WHERE tree_id = ? AND intent_key = ?")
        .get(input.treeId, input.intentKey) as FirstQuestionRow | undefined;
      if (existing !== undefined) {
        return { question: rowToFirstQuestion(existing), replayed: true };
      }
      const createdAt = this.#context.now();
      try {
        db.prepare(
          "INSERT INTO material_first_questions (intent_key, tree_id, branch_id, created_at) VALUES (?, ?, ?, ?)",
        ).run(input.intentKey, input.treeId, input.branchId, createdAt);
      } catch (error) {
        throw mapSqliteError(error, "inserting material first question");
      }
      return {
        question: {
          treeId: input.treeId,
          intentKey: input.intentKey,
          branchId: input.branchId,
          createdAt,
        },
        replayed: false,
      };
    });
  }


  /** 按幂等键查找首问记录（重放对齐路径；无则 null）。 */
  findFirstQuestion(treeId: TreeId, intentKey: string): MaterialFirstQuestion | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(intentKey, "intent key");
    const row = this.#context.database()!
      .prepare(
        "SELECT intent_key, tree_id, branch_id, created_at FROM material_first_questions WHERE tree_id = ? AND intent_key = ?",
      )
      .get(treeId, intentKey) as FirstQuestionRow | undefined;
    return row ? rowToFirstQuestion(row) : null;
  }


  /* ------------------------------ 材料建枝（D4-3，ADR-004） ------------------------------ */

  /**
   * 材料建枝的原子落库（D4-3，ADR-004）：Branch 行 + 材料来源
   * （material_branch_origins，含 ready 门槛与选区纪律校验）+ 首问意图绑定
   * （material_first_questions）在**同一事务**内写入——任何一步失败整体
   * 回滚，无孤儿分支/来源/绑定（与术语推广 promote 的单事务纪律同源，
   * issue #7 P0 整改验收口径）。
   *
   * 事务内首查 (tree_id, intent_key)：`BEGIN IMMEDIATE` 串行化写者，查-插
   * 之间无竞争窗口——已有绑定则原样返回既有 Branch/来源/绑定
   * （replayed=true，零新行，不重复建枝）；同键不同 selection 的冲突判定
   * 归调用方（材料建枝服务，409 语义），本方法只如实返回已绑定的来源。
   *
   * 为什么在本仓储插入 Branch 行：TreeRepository.createBranch 与本仓储的
   * 材料来源/首问绑定分属**两个 SQLite 连接**，跨连接无法共事务（单写者
   * 锁会互相阻塞）；本方法复制 createBranch 的最小 INSERT（列与 0001 冻结
   * 表一致，id 前缀同 `branch_`），把三方写入收进同一事务。branches 表的
   * 其余读写仍归 TreeRepository。
   */
  createMaterialBranch(input: CreateMaterialBranchInput): CreateMaterialBranchResult {
    this.#context.assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.parentBranchId, "parent branch id");
    assertValidSelectionShape(input.selection);
    assertNonEmptyString(input.intentKey, "intent key");
    return this.#context.repository.transaction((): CreateMaterialBranchResult => {
      const db = this.#context.database()!;
      if (this.#context.findTreeRow(input.treeId) === undefined) throw new EntityNotFoundError("tree", input.treeId);
      const parent = db
        .prepare("SELECT id, tree_id FROM branches WHERE id = ?")
        .get(input.parentBranchId) as { id: string; tree_id: string } | undefined;
      if (parent === undefined) throw new EntityNotFoundError("branch", input.parentBranchId);
      if (parent.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `parent branch ${input.parentBranchId} belongs to tree ${parent.tree_id}, not ${input.treeId}`,
        );
      }
      const existing = db
        .prepare(
          "SELECT intent_key, tree_id, branch_id, created_at FROM material_first_questions WHERE tree_id = ? AND intent_key = ?",
        )
        .get(input.treeId, input.intentKey) as FirstQuestionRow | undefined;
      if (existing !== undefined) {
        return this.#replayMaterialBranch(existing);
      }
      const branchId = input.branchId ?? (this.#context.newId("branch") as BranchId);
      assertNonEmptyString(branchId, "branch id");
      if (branchId === input.parentBranchId) {
        throw new InvalidArgumentError(`branch ${branchId} cannot be its own parent`);
      }
      const createdAt = this.#context.now();
      try {
        db.prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)").run(
          branchId,
          input.treeId,
          input.parentBranchId,
          createdAt,
        );
      } catch (error) {
        throw mapSqliteError(error, "creating material branch");
      }
      const origin = this.#context.repository.insertMaterialBranchOrigin({
        branchId,
        treeId: input.treeId,
        selection: input.selection,
      });
      const { question } = this.insertFirstQuestion({
        treeId: input.treeId,
        branchId,
        intentKey: input.intentKey,
      });
      return {
        branch: { id: branchId, treeId: input.treeId, parentBranchId: input.parentBranchId, createdAt },
        origin,
        question,
        replayed: false,
      };
    });
  }


  /** 同键重放的既有绑定还原（branch + 材料来源 + 绑定行；缺行按库损坏拒绝）。 */
  #replayMaterialBranch(existing: FirstQuestionRow): CreateMaterialBranchResult {
    const db = this.#context.database()!;
    const branchRow = db
      .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
      .get(existing.branch_id) as
      | { id: string; tree_id: string; parent_branch_id: string | null; created_at: string }
      | undefined;
    if (branchRow === undefined) {
      throw new DatabaseCorruptError(
        `material first-question intent '${existing.intent_key}' is bound to branch ${existing.branch_id} which no longer exists ` +
          "(schema integrity violation)",
      );
    }
    const originRow = db
      .prepare(
        `SELECT branch_id, tree_id, material_id, version_id, block_id, start, end, excerpt, source_hash, created_at
         FROM material_branch_origins WHERE branch_id = ?`,
      )
      .get(existing.branch_id) as MaterialBranchOriginRow | undefined;
    if (originRow === undefined) {
      throw new DatabaseCorruptError(
        `material branch ${existing.branch_id} has a first-question binding but no material origin ` +
          "(schema integrity violation)",
      );
    }
    return {
      branch: {
        id: branchRow.id as BranchId,
        treeId: branchRow.tree_id as TreeId,
        parentBranchId: (branchRow.parent_branch_id ?? null) as BranchId | null,
        createdAt: branchRow.created_at as IsoTimestamp,
      },
      origin: rowToMaterialBranchOrigin(originRow),
      question: rowToFirstQuestion(existing),
      replayed: true,
    };
  }
}
