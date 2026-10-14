/** Atomic Branch/Origin binding and intent creation, with one promotion lock per service instance. */
import type {
  TreeRepository,
} from "@treeai/persistence";
import {
  ConstraintViolationError,
  InvalidArgumentError,
} from "@treeai/persistence";
import type {
  TreeId,
} from "@treeai/contracts";
import type {
  BranchCreation,
  TreeStudioService,
} from "../service.ts";
import type {
  PromotionOutcome,
} from "./model.ts";
import {
  TerminologyPromotionConflictError,
} from "./errors.ts";
import {
  hashFirstQuestionPayload,
} from "./prompts.ts";
import {
  TerminologyDispatchLedger,
} from "./promotion-ledger.ts";

export class TerminologyPromotionCoordinator {
  #promotionInFlight: boolean = false;
  readonly #ledger: TerminologyDispatchLedger;
  readonly repository: TreeRepository;
  readonly studio: TreeStudioService;
  constructor(repository: TreeRepository, studio: TreeStudioService) {
    this.repository = repository;
    this.studio = studio;
    this.#ledger = new TerminologyDispatchLedger(repository, studio);
  }

  async promote(input: {
    readonly treeId: TreeId;
    readonly annotationId: string;
    readonly idempotencyKey: string;
    readonly firstQuestion: string;
  }): Promise<PromotionOutcome> {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new InvalidArgumentError("promotion idempotencyKey must be a non-empty string");
    }
    if (typeof input.firstQuestion !== "string" || input.firstQuestion.trim().length === 0) {
      throw new InvalidArgumentError("promotion firstQuestion must be a non-empty string");
    }
    const tree = this.repository.getTree(input.treeId); // EntityNotFoundError → 404
    const annotation = this.repository.getTerminologyAnnotation(input.annotationId);
    if (annotation.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `terminology annotation ${input.annotationId} belongs to tree ${annotation.treeId}, not ${tree.id}`,
      );
    }
    if (annotation.promotedBranchId !== null) {
      if (annotation.promotionKey !== input.idempotencyKey) {
        throw new TerminologyPromotionConflictError(
          `annotation ${input.annotationId} is already promoted (branch ${annotation.promotedBranchId}); ` +
            "a new follow-up needs a new annotation",
        );
      }
      /* 同键重放：判定只走派发账本（首问身份 / 派发状态 / 对账）。 */
      return await this.#ledger.replayPromotion(tree.id, annotation, input.firstQuestion);
    }
    /* 键可用性预检（零写入）：同树同键已绑在别的批注上 → 409。 */
    const keyHolder = this.repository.findTerminologyAnnotationByPromotionKey(tree.id, input.idempotencyKey);
    if (keyHolder !== null && keyHolder.id !== annotation.id) {
      throw new TerminologyPromotionConflictError(
        `promotion key '${input.idempotencyKey}' is already used by annotation ${keyHolder.id} in this tree; ` +
          "a promotion key identifies exactly one follow-up",
      );
    }
    if (this.#promotionInFlight) {
      throw new TypeError("a terminology promotion is already in flight; wait for it to settle first");
    }
    this.#promotionInFlight = true;
    try {
      const firstQuestionHash = hashFirstQuestionPayload(annotation, input.firstQuestion);
      let creation: BranchCreation;
      try {
        /* 单事务（BEGIN IMMEDIATE；嵌套仓储调用以 SAVEPOINT 加入）：
           Branch + Origin（createBranchFromSelection）→ 绑定 → 派发意图
           （账本 pending 行）。任何一步失败整体回滚——零新增行。 */
        creation = this.repository.transaction(() => {
          const created = this.studio.createBranchFromSelection(
            tree.id,
            annotation.branchId,
            annotation.anchorTurnId,
            annotation.selection,
          );
          const bound = this.repository.bindTerminologyPromotion(
            annotation.id,
            input.idempotencyKey,
            created.branch.id,
          );
          if (!bound) {
            throw new TerminologyPromotionConflictError(
              `annotation ${annotation.id} was promoted concurrently; zero rows were written by this attempt ` +
                "(the branch created inside this transaction was rolled back)",
            );
          }
          this.repository.createTerminologyDispatch({
            annotationId: annotation.id,
            treeId: tree.id,
            promotionKey: input.idempotencyKey,
            branchId: created.branch.id,
            firstQuestionHash,
          });
          return created;
        });
      } catch (error) {
        if (error instanceof TerminologyPromotionConflictError) throw error;
        if (error instanceof ConstraintViolationError) {
          /* 唯一索引判负（并发同键/同批注）：整个事务已回滚——零新增行。 */
          const winner = this.repository.findTerminologyAnnotationByPromotionKey(
            tree.id,
            input.idempotencyKey,
          );
          throw new TerminologyPromotionConflictError(
            `promotion key '${input.idempotencyKey}' lost a concurrent race` +
              `${winner !== null ? ` (annotation ${winner.id} holds it)` : ""}; ` +
              "zero rows were written by this attempt (the branch created inside the transaction was rolled back)",
          );
        }
        throw error;
      }
      const dispatched = await this.#ledger.dispatchFirstQuestionWithLedger(
        tree.id,
        creation.branch.id,
        annotation,
        input.firstQuestion,
      );
      return {
        branch: creation.branch,
        outcome: dispatched.outcome,
        firstQuestionError: dispatched.error,
        created: true,
        dispatch: dispatched.dispatch,
        dispatchRunId: dispatched.runId,
      };
    } finally {
      this.#promotionInFlight = false;
    }
  }

}
