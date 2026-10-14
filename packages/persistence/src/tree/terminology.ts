/** terminology SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";
import {
  encodeFailure,
  rowToTerminologyAnnotation,
  rowToTerminologyDispatch,
  type TerminologyAnnotationRow,
  type TerminologyDispatchRow,
} from "../serialization.ts";
import type {
  CreateTerminologyAnnotationInput,
  CreateTerminologyDispatchInput,
  SettleTerminologyDispatchInput,
} from "./model.ts";

import {
  assertNonEmptyString,
} from "./validation.ts";
import type {
  BranchId,
  TerminologyAnnotation,
  TerminologyPromotionDispatch,
  TreeId,
  TurnId,
} from "@treeai/contracts";

import type {
  TreeDomainContext,
} from "./context.ts";

export class TreeTerminologyRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }


  /* --------------------- 术语三部分（terminology_annotations / terminology_state，migration 0007） --------------------- */

  /**
   * 保存术语批注（issue #7 C ②）。锚定完整性（选区切片一致、锚点 turn
   * 属于该分支的 assistant turn）在此校验；同一 (tree, anchorTurn, start,
   * end) 至多一条（唯一索引 idx_terminology_annotations_range——重复保存
   * 以 ConstraintViolationError 拒绝，服务层读路径先查重返回既有批注）。
   */
  createTerminologyAnnotation(input: CreateTerminologyAnnotationInput): TerminologyAnnotation {
    this.#context.assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.anchorTurnId, "anchor turn id");
    assertNonEmptyString(input.sourceHash, "source hash");
    assertNonEmptyString(input.term, "term");
    assertNonEmptyString(input.explanation, "explanation");
    if (input.mode !== "term" && input.mode !== "range" && input.mode !== "auto") {
      throw new InvalidArgumentError(`terminology mode must be 'term' | 'range' | 'auto' (got '${String(input.mode)}')`);
    }
    const tree = this.#context.repository.findTree(input.treeId);
    if (tree === null) throw new EntityNotFoundError("tree", input.treeId);
    const branch = this.#context.repository.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${input.branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const anchorTurn = this.#context.repository.findTurn(input.anchorTurnId);
    if (anchorTurn === null) throw new EntityNotFoundError("turn", input.anchorTurnId);
    if (anchorTurn.branchId !== input.branchId) {
      throw new InvalidArgumentError(
        `anchor turn ${input.anchorTurnId} belongs to branch ${anchorTurn.branchId}, not ${input.branchId}`,
      );
    }
    if (anchorTurn.role !== "assistant") {
      throw new InvalidArgumentError("terminology annotations must reference an assistant turn (an answer)");
    }
    const selection = input.selection;
    if (
      typeof selection !== "object" ||
      selection === null ||
      !Number.isInteger(selection.start) ||
      !Number.isInteger(selection.end) ||
      selection.start < 0 ||
      selection.end < selection.start ||
      selection.end > anchorTurn.text.length
    ) {
      throw new InvalidArgumentError(
        `selection [${String(selection?.start)}, ${String(selection?.end)}) is out of bounds for the anchor answer (${anchorTurn.text.length} chars)`,
      );
    }
    if (anchorTurn.text.slice(selection.start, selection.end) !== selection.text) {
      throw new InvalidArgumentError(
        "selection text does not match the anchor answer at the given offsets (anchor integrity violation)",
      );
    }
    const createdAt = this.#context.now();
    const id = this.#context.newId("term");
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO terminology_annotations
             (id, tree_id, branch_id, anchor_turn_id, sel_start, sel_end, sel_text, source_hash,
              term, explanation, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.treeId,
          input.branchId,
          input.anchorTurnId,
          selection.start,
          selection.end,
          selection.text,
          input.sourceHash,
          input.term,
          input.explanation,
          input.mode,
          createdAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "creating terminology annotation");
    }
    return this.getTerminologyAnnotation(id);
  }


  getTerminologyAnnotation(id: string): TerminologyAnnotation {
    const found = this.findTerminologyAnnotation(id);
    if (found === null) throw new EntityNotFoundError("terminology annotation", id);
    return found;
  }


  findTerminologyAnnotation(id: string): TerminologyAnnotation | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "terminology annotation id");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, anchor_turn_id, sel_start, sel_end, sel_text, source_hash,
                term, explanation, mode, promoted_branch_id, promotion_key, created_at
         FROM terminology_annotations WHERE id = ?`,
      )
      .get(id) as TerminologyAnnotationRow | undefined;
    return row ? rowToTerminologyAnnotation(row) : null;
  }


  /** 树的全部批注（追加序）。 */
  listTerminologyAnnotations(treeId: TreeId): TerminologyAnnotation[] {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, anchor_turn_id, sel_start, sel_end, sel_text, source_hash,
                term, explanation, mode, promoted_branch_id, promotion_key, created_at
         FROM terminology_annotations WHERE tree_id = ? ORDER BY created_at, rowid`,
      )
      .all(treeId) as unknown as TerminologyAnnotationRow[];
    return rows.map(rowToTerminologyAnnotation);
  }


  /** 同一选区的既有批注（去重读路径；无则 null）。 */
  findTerminologyAnnotationByRange(
    treeId: TreeId,
    anchorTurnId: TurnId,
    start: number,
    end: number,
  ): TerminologyAnnotation | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(anchorTurnId, "anchor turn id");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, anchor_turn_id, sel_start, sel_end, sel_text, source_hash,
                term, explanation, mode, promoted_branch_id, promotion_key, created_at
         FROM terminology_annotations
         WHERE tree_id = ? AND anchor_turn_id = ? AND sel_start = ? AND sel_end = ?`,
      )
      .get(treeId, anchorTurnId, start, end) as TerminologyAnnotationRow | undefined;
    return row ? rowToTerminologyAnnotation(row) : null;
  }


  /**
   * 绑定批注的幂等推广（issue #7 C ②：推广至多一次）。条件 UPDATE：
   * promoted_branch_id 为空才写入——首个到达的 (promotionKey, branchId)
   * 生效；已绑定（重放/双击/响应丢失重试）返回 false，调用方按键对齐
   * （同键 → 既有分支重放；异键 → 冲突上抛）。
   */
  bindTerminologyPromotion(annotationId: string, promotionKey: string, branchId: BranchId): boolean {
    this.#context.assertOpen();
    assertNonEmptyString(annotationId, "terminology annotation id");
    assertNonEmptyString(promotionKey, "promotion key");
    assertNonEmptyString(branchId, "branch id");
    const annotation = this.findTerminologyAnnotation(annotationId);
    if (annotation === null) throw new EntityNotFoundError("terminology annotation", annotationId);
    if (this.#context.repository.findBranch(branchId) === null) throw new EntityNotFoundError("branch", branchId);
    if (annotation.promotedBranchId !== null) return false;
    const result = this.#context.database()!
      .prepare(
        `UPDATE terminology_annotations
         SET promoted_branch_id = ?, promotion_key = ?
         WHERE id = ? AND promoted_branch_id IS NULL`,
      )
      .run(branchId, promotionKey, annotationId);
    return Number(result.changes) > 0;
  }


  /** 按推广幂等键找批注（重放对齐路径；无则 null）。 */
  findTerminologyAnnotationByPromotionKey(treeId: TreeId, promotionKey: string): TerminologyAnnotation | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(promotionKey, "promotion key");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, anchor_turn_id, sel_start, sel_end, sel_text, source_hash,
                term, explanation, mode, promoted_branch_id, promotion_key, created_at
         FROM terminology_annotations WHERE tree_id = ? AND promotion_key = ?`,
      )
      .get(treeId, promotionKey) as TerminologyAnnotationRow | undefined;
    return row ? rowToTerminologyAnnotation(row) : null;
  }


  /* ------------- 术语推广首问派发账本（terminology_promotion_dispatches，migration 0009） ------------- */

  /**
   * 登记派发意图（issue #7 P0 整改）：插入 dispatch_state='pending'、
   * attempts=0 的账本行。**必须与推广绑定（bindTerminologyPromotion）及
   * Branch/Origin 创建在同一事务内调用**——意图先于任何派发落库，崩溃后
   * 重放以账本而非内存/分支 Turn 为准。前置校验：批注已绑定该 key/branch、
   * 分支属于该树；重复登记（annotation_id 唯一）以 ConstraintViolationError
   * 拒绝（调用方按键对齐或按冲突上抛）。
   */
  createTerminologyDispatch(input: CreateTerminologyDispatchInput): TerminologyPromotionDispatch {
    this.#context.assertOpen();
    assertNonEmptyString(input.annotationId, "terminology annotation id");
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.promotionKey, "promotion key");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.firstQuestionHash, "first question hash");
    const annotation = this.findTerminologyAnnotation(input.annotationId);
    if (annotation === null) throw new EntityNotFoundError("terminology annotation", input.annotationId);
    if (annotation.treeId !== input.treeId) {
      throw new InvalidArgumentError(
        `terminology annotation ${input.annotationId} belongs to tree ${annotation.treeId}, not ${input.treeId}`,
      );
    }
    if (annotation.promotedBranchId === null || annotation.promotionKey === null) {
      throw new InvalidArgumentError(
        `terminology annotation ${input.annotationId} is not bound to a promotion yet; ` +
          "bind the promotion (bindTerminologyPromotion) in the same transaction before registering the dispatch intent",
      );
    }
    if (annotation.promotedBranchId !== input.branchId || annotation.promotionKey !== input.promotionKey) {
      throw new InvalidArgumentError(
        `the dispatch intent for annotation ${input.annotationId} must match its promotion binding ` +
          `(branch ${annotation.promotedBranchId} / key ${annotation.promotionKey}), got ` +
          `branch ${input.branchId} / key ${input.promotionKey}`,
      );
    }
    const branch = this.#context.repository.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    if (branch.treeId !== input.treeId) {
      throw new InvalidArgumentError(`branch ${input.branchId} belongs to tree ${branch.treeId}, not ${input.treeId}`);
    }
    const id = this.#context.newId("termdispatch");
    const now = this.#context.now();
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO terminology_promotion_dispatches
             (id, annotation_id, tree_id, promotion_key, branch_id, first_question_hash,
              dispatch_state, attempts, run_id, failure_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          input.annotationId,
          input.treeId,
          input.promotionKey,
          input.branchId,
          input.firstQuestionHash,
          now,
          now,
        );
    } catch (error) {
      throw mapSqliteError(error, "creating terminology dispatch");
    }
    return this.getTerminologyDispatchByAnnotation(input.annotationId);
  }


  /** 批注的派发账本行（无则 null）。 */
  findTerminologyDispatchByAnnotation(annotationId: string): TerminologyPromotionDispatch | null {
    this.#context.assertOpen();
    assertNonEmptyString(annotationId, "terminology annotation id");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, annotation_id, tree_id, promotion_key, branch_id, first_question_hash,
                dispatch_state, attempts, run_id, failure_json, created_at, updated_at
         FROM terminology_promotion_dispatches WHERE annotation_id = ?`,
      )
      .get(annotationId) as TerminologyDispatchRow | undefined;
    return row ? rowToTerminologyDispatch(row) : null;
  }


  /** getTerminologyDispatchByAnnotation 的抛错版（账本行缺失 = schema 完整性违约）。 */
  getTerminologyDispatchByAnnotation(annotationId: string): TerminologyPromotionDispatch {
    const found = this.findTerminologyDispatchByAnnotation(annotationId);
    if (found === null) {
      throw new EntityNotFoundError("terminology dispatch ledger row", annotationId);
    }
    return found;
  }


  /**
   * 标记一次实际派发尝试：dispatch_state ∈ {pending, failed} → dispatched，
   * attempts 自增。条件 UPDATE 保证唯一在途尝试；已 dispatched（结果未知，
   * 须先对账）或已 succeeded（不可再发）均以 InvalidArgumentError 拒绝
   * （HTTP 层 400——调用方编程/并发纪律错误，不是领域冲突）。
   */
  markTerminologyDispatchSent(annotationId: string): TerminologyPromotionDispatch {
    this.#context.assertOpen();
    assertNonEmptyString(annotationId, "terminology annotation id");
    return this.#context.repository.transaction((): TerminologyPromotionDispatch => {
      const result = this.#context.database()!
        .prepare(
          `UPDATE terminology_promotion_dispatches
           SET dispatch_state = 'dispatched', attempts = attempts + 1, updated_at = ?
           WHERE annotation_id = ? AND dispatch_state IN ('pending', 'failed')`,
        )
        .run(this.#context.now(), annotationId);
      if (Number(result.changes) === 0) {
        const current = this.findTerminologyDispatchByAnnotation(annotationId);
        if (current === null) throw new EntityNotFoundError("terminology dispatch ledger row", annotationId);
        if (current.dispatchState === "succeeded") {
          throw new InvalidArgumentError(
            `the first question for annotation ${annotationId} already landed (run ${String(current.runId)}); it is never re-dispatched`,
          );
        }
        throw new InvalidArgumentError(
          `a dispatch for annotation ${annotationId} is already in flight or its result is unknown ` +
            "(ledger state 'dispatched'); reconcile against the branch turns/runs before re-sending",
        );
      }
      return this.getTerminologyDispatchByAnnotation(annotationId);
    });
  }


  /**
   * 派发终局结算（条件 UPDATE：仅 dispatched → 终态）。succeeded 携带 Run
   * 引用（run 必须存在）；failed 携带脱敏失败（failure_json）。结算后不可
   * 再变更（重试经 markTerminologyDispatchSent 的 failed → dispatched 走
   * 新尝试，不改写历史终态行——attempts 保留全部尝试计数）。
   */
  settleTerminologyDispatch(
    annotationId: string,
    outcome: SettleTerminologyDispatchInput,
  ): TerminologyPromotionDispatch {
    this.#context.assertOpen();
    assertNonEmptyString(annotationId, "terminology annotation id");
    return this.#context.repository.transaction((): TerminologyPromotionDispatch => {
      if (outcome.state === "succeeded") {
        if (this.#context.repository.findRun(outcome.runId) === null) throw new EntityNotFoundError("run", outcome.runId);
      }
      const now = this.#context.now();
      const result =
        outcome.state === "succeeded"
          ? this.#context.database()!
              .prepare(
                `UPDATE terminology_promotion_dispatches
                 SET dispatch_state = 'succeeded', run_id = ?, failure_json = NULL, updated_at = ?
                 WHERE annotation_id = ? AND dispatch_state = 'dispatched'`,
              )
              .run(outcome.runId, now, annotationId)
          : this.#context.database()!
              .prepare(
                `UPDATE terminology_promotion_dispatches
                 SET dispatch_state = 'failed', run_id = NULL, failure_json = ?, updated_at = ?
                 WHERE annotation_id = ? AND dispatch_state = 'dispatched'`,
              )
              .run(encodeFailure(outcome.failure), now, annotationId);
      if (Number(result.changes) === 0) {
        const current = this.findTerminologyDispatchByAnnotation(annotationId);
        if (current === null) throw new EntityNotFoundError("terminology dispatch ledger row", annotationId);
        throw new InvalidArgumentError(
          `cannot settle the dispatch for annotation ${annotationId} from state '${current.dispatchState}' ` +
            "(settle is only valid while the ledger row is 'dispatched')",
        );
      }
      return this.getTerminologyDispatchByAnnotation(annotationId);
    });
  }

  /** 执行器键值状态读取（用量/预算/缓存偏好；缺失为 null）。 */
  getTerminologyState(key: string): string | null {
    this.#context.assertOpen();
    assertNonEmptyString(key, "terminology state key");
    const row = this.#context.database()!.prepare("SELECT key, value FROM terminology_state WHERE key = ?").get(key) as
      | { key: string; value: string }
      | undefined;
    return row?.value ?? null;
  }


  /** 执行器键值状态写入（UPSERT；值由调用方以 JSON 文本提供）。 */
  setTerminologyState(key: string, value: string): void {
    this.#context.assertOpen();
    assertNonEmptyString(key, "terminology state key");
    assertNonEmptyString(value, "terminology state value");
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO terminology_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    } catch (error) {
      throw mapSqliteError(error, "writing terminology state");
    }
  }
}
