/** Immutable first-question identity, dispatch/reconciliation and terminal ledger settlement. */
import type {
  TreeRepository,
} from "@treeai/persistence";
import type {
  TreeStudioService,
} from "../service.ts";
import {
  TerminologyPromotionConflictError,
} from "./errors.ts";
import {
  firstQuestionContext,
  hashFirstQuestionPayload,
  TERMINOLOGY_PROMOTION_TURN_PREFIX,
} from "./prompts.ts";
import {
  toErrorMessage,
  toTreeAIErrorCode,
} from "./usage.ts";
import type {
  PromptOutcome,
} from "../service.ts";
import type {
  PromotionOutcome,
  TerminologyDispatchOutcome,
} from "./model.ts";
import type {
  BranchId,
  RunId,
  TerminologyAnnotation,
  TreeAIErrorCode,
  TreeId,
} from "@treeai/contracts";
import {
  InvalidArgumentError,
} from "@treeai/persistence";

export class TerminologyDispatchLedger {
  readonly repository: TreeRepository;
  readonly studio: TreeStudioService;
  constructor(repository: TreeRepository, studio: TreeStudioService) {
    this.repository = repository;
    this.studio = studio;
  }

  /**
   * 同键重放（批注已推广）：首问身份校验（同键异问 → 409）+ 账本状态机。
   */
  async replayPromotion(
    treeId: TreeId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<PromotionOutcome> {
    const promotedBranchId = annotation.promotedBranchId;
    if (promotedBranchId === null || annotation.promotionKey === null) {
      throw new InvalidArgumentError(
        `annotation ${annotation.id} has no promotion binding (schema integrity violation)`,
      );
    }
    const branchView = this.studio
      .getTreeState(treeId)
      .branches.find((view) => view.branch.id === promotedBranchId);
    if (branchView === undefined) {
      throw new InvalidArgumentError(
        `the promoted branch ${promotedBranchId} no longer exists (schema integrity violation)`,
      );
    }
    const ledger = this.repository.findTerminologyDispatchByAnnotation(annotation.id);
    if (ledger === null) {
      throw new InvalidArgumentError(
        `annotation ${annotation.id} is bound to a promotion but has no dispatch ledger row ` +
          "(schema integrity violation)",
      );
    }
    const firstQuestionHash = hashFirstQuestionPayload(annotation, firstQuestion);
    if (ledger.firstQuestionHash !== firstQuestionHash) {
      throw new TerminologyPromotionConflictError(
        `promotion key '${String(annotation.promotionKey)}' was already used with a different first question; ` +
          "the first question is immutable for a promotion key — a retry with this key must carry the same question, " +
          "and a different question needs a new annotation",
      );
    }
    if (ledger.dispatchState === "succeeded") {
      /* 首问已送达：幂等重放（不重复派发，不重建枝）。 */
      return {
        branch: branchView.branch,
        outcome: null,
        firstQuestionError: null,
        created: false,
        dispatch: "succeeded",
        dispatchRunId: ledger.runId,
      };
    }
    if (ledger.dispatchState === "dispatched") {
      /* 结果未知：先对账（Turn/Run 证据）——绝不以 turns.length 盲判。 */
      const reconciled = this.#reconcileUnknownDispatch(annotation, promotedBranchId, firstQuestion);
      if (reconciled.state === "succeeded") {
        return {
          branch: branchView.branch,
          outcome: null,
          firstQuestionError: null,
          created: false,
          dispatch: "succeeded",
          dispatchRunId: reconciled.runId,
        };
      }
      if (reconciled.state === "undecidable") {
        /* 对账不决（分支有非终态 Run：可能仍在途/未收敛）：不盲发。 */
        return {
          branch: branchView.branch,
          outcome: null,
          firstQuestionError: {
            code: "dispatch-unknown",
            message:
              `the first question for annotation ${annotation.id} was dispatched but never reached a terminal state ` +
              "(the process exited mid-dispatch or another dispatch may still be in flight); it was NOT re-sent — " +
              "reconcile the promoted branch's runs, then retry this promotion",
          },
          created: false,
          dispatch: "unknown",
          dispatchRunId: null,
        };
      }
      /* reconciled.state === "not-landed"：对账结论 = 明确未送达 → 落入下方重试。 */
    }
    /* pending（从未派发）| failed（明确失败）| dispatched→对账判负：重试派发（不重建枝）。 */
    const dispatched = await this.dispatchFirstQuestionWithLedger(
      treeId,
      promotedBranchId,
      annotation,
      firstQuestion,
    );
    return {
      branch: branchView.branch,
      outcome: dispatched.outcome,
      firstQuestionError: dispatched.error,
      created: false,
      dispatch: dispatched.dispatch,
      dispatchRunId: dispatched.runId,
    };
  }

  /**
   * 对账一次结果未知的派发（账本 dispatched；issue #7 P0 整改）：
   * - 证据一：首问 turn 已落库（用户 turn 文本 = 推广标记 + 问题原文）→
   *   实际已送达：账本补结算 succeeded（Run 引用取自该 turn）；
   * - 证据二：分支存在非终态 Run（在途/未收敛）→ 对账不决（不盲发）；
   * - 其余（无落库 turn 且全部 Run 终态或无 Run）→ 明确未送达：账本补
   *   结算 failed（可重试）。
   */
  #reconcileUnknownDispatch(
    annotation: TerminologyAnnotation,
    promotedBranchId: BranchId,
    firstQuestion: string,
  ): { state: "succeeded"; runId: RunId } | { state: "undecidable" } | { state: "not-landed" } {
    const expectedTurnText = `${TERMINOLOGY_PROMOTION_TURN_PREFIX}\n\n${firstQuestion}`;
    const landing = this.repository
      .listTurns(promotedBranchId)
      .find((turn) => turn.role === "user" && turn.text === expectedTurnText);
    if (landing !== undefined && landing.runId !== null) {
      this.repository.settleTerminologyDispatch(annotation.id, { state: "succeeded", runId: landing.runId });
      return { state: "succeeded", runId: landing.runId };
    }
    for (const episode of this.repository.listEpisodes(promotedBranchId)) {
      for (const run of this.repository.listRuns(episode.id)) {
        if (run.terminalAt === null) return { state: "undecidable" };
      }
    }
    this.repository.settleTerminologyDispatch(annotation.id, {
      state: "failed",
      failure: {
        code: "unknown",
        message:
          "reconciled after an unknown-result dispatch: the first question never landed " +
          "(no matching turn on the promoted branch and all its runs are terminal)",
      },
    });
    return { state: "not-landed" };
  }

  /** 派发前账本标记（并发在途 → 409 冲突语义）。 */
  #markDispatchSent(annotationId: string): void {
    try {
      this.repository.markTerminologyDispatchSent(annotationId);
    } catch (error) {
      if (error instanceof InvalidArgumentError) {
        const ledger = this.repository.findTerminologyDispatchByAnnotation(annotationId);
        if (ledger !== null && ledger.dispatchState === "dispatched") {
          throw new TerminologyPromotionConflictError(
            `a dispatch for annotation ${annotationId} is already in flight or its result is unknown; ` +
              "reconcile before re-sending",
          );
        }
      }
      throw error;
    }
  }

  /**
   * 账本护航的首问派发：markSent（attempts+1，崩溃窗口内重放看到
   * dispatched → 先对账）→ 派发 → 终局结算（succeeded 带 Run 引用 /
   * failed 带明确失败）。派发错误由 #dispatchFirstQuestion 捕获并随
   * error 字段返回（绝不向外抛），此处只结算账本。
   */
  async dispatchFirstQuestionWithLedger(
    treeId: TreeId,
    branchId: BranchId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<{
    readonly outcome: PromptOutcome | null;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly dispatch: TerminologyDispatchOutcome;
    readonly runId: RunId | null;
  }> {
    this.#markDispatchSent(annotation.id);
    const dispatched = await this.#dispatchFirstQuestion(treeId, branchId, annotation, firstQuestion);
    if (dispatched.outcome !== null) {
      this.repository.settleTerminologyDispatch(annotation.id, {
        state: "succeeded",
        runId: dispatched.outcome.run.id,
      });
      return {
        outcome: dispatched.outcome,
        error: null,
        dispatch: "succeeded",
        runId: dispatched.outcome.run.id,
      };
    }
    const error = dispatched.error!;
    this.repository.settleTerminologyDispatch(annotation.id, {
      state: "failed",
      failure: { code: error.code as TreeAIErrorCode, message: error.message },
    });
    return { outcome: null, error, dispatch: "failed", runId: null };
  }

  async #dispatchFirstQuestion(
    treeId: TreeId,
    branchId: BranchId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<{ outcome: PromptOutcome | null; error: { code: string; message: string } | null }> {
    const context = firstQuestionContext(annotation);
    try {
      const outcome = await this.studio.prompt(treeId, branchId, firstQuestion, {
        composedPrefix: context,
        turnPrefix: TERMINOLOGY_PROMOTION_TURN_PREFIX,
      });
      return { outcome, error: null };
    } catch (err) {
      const code = toTreeAIErrorCode(err);
      return { outcome: null, error: { code, message: toErrorMessage(err) } };
    }
  }

}
