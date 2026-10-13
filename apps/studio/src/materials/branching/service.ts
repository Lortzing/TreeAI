/** service ownership for branching.ts; compatibility entrypoint remains one level above. */
import type {
  PromptOutcome,
  TreeStudioService,
} from "../../service.ts";
import {
  MaterialNotReadyError,
} from "../import-service.ts";
import {
  composeMaterialContext,
  materialExplorationTurnPrefix,
} from "./context.ts";
import {
  MaterialBranchConflictError,
  MaterialFirstQuestionConflictError,
  toErrorCode,
  toErrorMessage,
} from "./errors.ts";
import {
  sameMaterialSelectionIdentity,
} from "./identity.ts";
import type {
  MaterialBranchCreation,
  MaterialBranchingServiceOptions,
  MaterialContextView,
  MaterialFirstQuestionResult,
  MaterialRestoreResult,
  MaterialReturnCard,
  MaterialReturnSubmission,
} from "./model.ts";
import {
  MATERIAL_MAX_SELECTION_UNITS,
} from "./policy.ts";
import type {
  Branch,
  BranchId,
  MaterialBranchOrigin,
  MaterialId,
  MaterialSelection,
  TreeId,
  Turn,
} from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  type MaterialRepository,
  type TreeRepository,
} from "@treeai/persistence";

export class MaterialBranchingService {
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly studio: TreeStudioService;

  constructor(options: MaterialBranchingServiceOptions) {
    this.treeRepository = options.treeRepository;
    this.materialRepository = options.materialRepository;
    this.studio = options.studio;
  }

  /* ------------------------------ 建枝（规则一/三） ------------------------------ */

  /**
   * 从材料选区建枝（幂等）：Branch + 材料来源 + 首问意图绑定**单事务原子
   * 落库**（MaterialRepository.createMaterialBranch——任何一步失败零新增
   * 行）；同键重放返回既有 Branch；同键不同选区 → 409。本次调用零 Run/
   * Turn（浏览/搜索不创建 Turn——首问是独立的显式提交，见 firstQuestion）。
   * 返回的组合上下文与后续首问派发的 composedPrefix 逐字节相同（UI 在
   * 提交前据此说明材料范围与截断状态）。
   */
  createMaterialBranch(input: {
    readonly treeId: TreeId;
    readonly selection: MaterialSelection;
    readonly intentKey: string;
  }): MaterialBranchCreation {
    if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
      throw new InvalidArgumentError("material branching intentKey must be a non-empty string");
    }
    const tree = this.treeRepository.getTree(input.treeId); // EntityNotFoundError → 404
    this.#assertMaterialLinked(tree.id, input.selection.materialId); // 404
    const anchored = this.materialRepository.getMaterialSelection(input.selection); // 纪律 400 / 引用 404
    if (anchored.version.parseStatus !== "ready") {
      throw new MaterialNotReadyError(anchored.version); // 409：不把不支持伪装成成功
    }
    const selectionLength = input.selection.end - input.selection.start;
    if (selectionLength > MATERIAL_MAX_SELECTION_UNITS) {
      throw new InvalidArgumentError(
        `the selection is ${String(selectionLength)} UTF-16 units; a material branch accepts at most ` +
          `${String(MATERIAL_MAX_SELECTION_UNITS)} (the excerpt must enter the composed context in full — ` +
          "truncating the user's own selection would be a dishonest anchor), zero dispatch",
      );
    }
    const trunk = this.#trunkOf(tree.id);
    const existing = this.materialRepository.findFirstQuestion(tree.id, input.intentKey);
    if (existing !== null) {
      return this.#replayCreation(tree.id, input.intentKey, existing, input.selection);
    }
    const created = this.materialRepository.createMaterialBranch({
      treeId: tree.id,
      parentBranchId: trunk.id,
      selection: input.selection,
      intentKey: input.intentKey,
    });
    if (created.replayed && !sameMaterialSelectionIdentity(created.origin.selection, input.selection)) {
      /* 并发同键异选区判负：createMaterialBranch 已零写入（事务内只读回放），
         以 409 如实呈现——一次逻辑提交不得静默换源。 */
      throw this.#selectionConflict(input.intentKey, created.origin.selection, input.selection);
    }
    return {
      branch: created.branch,
      origin: created.origin,
      context: this.buildContext(created.origin),
      created: !created.replayed,
    };
  }

  /** 同键重放对齐：既有绑定的 Branch + 来源；选区不一致 → 409（不换源）。 */
  #replayCreation(
    treeId: TreeId,
    intentKey: string,
    existing: { readonly branchId: BranchId },
    selection: MaterialSelection,
  ): MaterialBranchCreation {
    const branch = this.treeRepository.getBranch(existing.branchId); // 404（绑定悬空）
    if (branch.treeId !== treeId) {
      throw new InvalidArgumentError(
        `material first-question binding points at branch ${branch.id} of tree ${branch.treeId}, not ${treeId} ` +
          "(schema integrity violation)",
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branch.id} has a first-question binding but no material origin (schema integrity violation)`,
      );
    }
    if (!sameMaterialSelectionIdentity(originRef.origin.selection, selection)) {
      throw this.#selectionConflict(intentKey, originRef.origin.selection, selection);
    }
    return { branch, origin: originRef.origin, context: this.buildContext(originRef.origin), created: false };
  }

  #selectionConflict(intentKey: string, bound: MaterialSelection, requested: MaterialSelection): MaterialBranchConflictError {
    const describe = (selection: MaterialSelection): string =>
      `material ${selection.materialId} version ${selection.versionId} block ${selection.blockId} ` +
      `[${String(selection.start)}, ${String(selection.end)})`;
    return new MaterialBranchConflictError(
      `material branching intent key '${intentKey}' is already bound to a branch from a different selection ` +
        `(bound: ${describe(bound)}; requested: ${describe(requested)}); ` +
        "an intent key identifies exactly one material branching submission — use a new key for a new selection",
    );
  }

  /** 组合上下文视图（建枝与首问派发共用；全部成分不可变 ⇒ 确定性）。 */
  buildContext(origin: MaterialBranchOrigin): MaterialContextView {
    const anchored = this.materialRepository.getMaterialSelection(origin.selection);
    const content = this.materialRepository.getVersionContent(origin.selection.versionId);
    return composeMaterialContext({
      material: anchored.material,
      version: content.version,
      canonicalText: content.canonicalText,
      blocks: content.blocks,
      selection: origin.selection,
    });
  }

  /* ------------------------------ 首问（规则二/四/五） ------------------------------ */

  /**
   * 幂等首问（提交意图身份，0009 派发账本纪律的服务层实现——ADR-004
   * 决策四）：以 (tree, intentKey) 绑定的 Branch 为对象，先**对账**再行动：
   * - 已落库首问 turn（显式前缀 + 问题原文全等）→ 幂等重放（succeeded，
   *   不重发、不重建枝）；
   * - 分支存在非终态 Run（在途/未收敛）→ dispatch "unknown"，**不盲发**；
   * - 首问已用不同内容落库 → 409（首问不可变；改问走普通续聊）；
   * - 其余（无落库 turn 且全部 Run 终态或无 Run）→ 从未送达或明确失败，
   *   派发首问：组合上下文作 composedPrefix（模型输入面），用户 turn 落库
   *   为 前缀 + 问题原文（可审计）。失败 → dispatch "failed"（同键重试是
   *   显式允许的新尝试）。
   */
  async firstQuestion(input: {
    readonly treeId: TreeId;
    readonly intentKey: string;
    readonly firstQuestion: string;
  }): Promise<MaterialFirstQuestionResult> {
    if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
      throw new InvalidArgumentError("material first-question intentKey must be a non-empty string");
    }
    if (typeof input.firstQuestion !== "string" || input.firstQuestion.trim().length === 0) {
      throw new InvalidArgumentError("material firstQuestion must be a non-empty string");
    }
    const tree = this.treeRepository.getTree(input.treeId); // 404
    const intent = this.materialRepository.findFirstQuestion(tree.id, input.intentKey);
    if (intent === null) {
      throw new InvalidArgumentError(
        `material first-question intent key '${input.intentKey}' is not registered in tree ${tree.id}; ` +
          "create the material branch with this key first",
      );
    }
    const branch = this.treeRepository.getBranch(intent.branchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `material first-question binding points at branch ${branch.id} of tree ${branch.treeId}, not ${tree.id} ` +
          "(schema integrity violation)",
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branch.id} has a first-question binding but no material origin (schema integrity violation)`,
      );
    }
    const origin = originRef.origin;
    const prefix = materialExplorationTurnPrefix(origin);
    const expectedTurnText = `${prefix}\n\n${input.firstQuestion}`;

    /* 对账证据一：首问 turn 已落库（前缀 + 问题原文全等）→ 已送达。 */
    const turns = this.treeRepository.listTurns(branch.id);
    const landed = turns.find((turn) => turn.role === "user" && turn.text === expectedTurnText);
    if (landed !== undefined) {
      if (landed.runId === null) {
        throw new InvalidArgumentError(
          `first-question turn ${landed.id} has no run (schema integrity violation)`,
        );
      }
      const assistant = turns.find((turn) => turn.role === "assistant" && turn.runId === landed!.runId) ?? null;
      return {
        branch,
        dispatch: "succeeded",
        outcome: null,
        error: null,
        landed: { runId: landed.runId, userTurnId: landed.id, assistantTurnId: assistant?.id ?? null },
      };
    }
    /* 首问已用不同内容落库 → 不可变冲突（改问是普通续聊）。 */
    const landedDifferent = turns.find((turn) => turn.role === "user" && turn.text.startsWith(prefix));
    if (landedDifferent !== undefined) {
      throw new MaterialFirstQuestionConflictError(
        `the first question on material branch ${branch.id} was already dispatched with different content ` +
          `(turn ${landedDifferent.id}); the first question is immutable for this branch — ` +
          "ask the changed question as a normal continuation instead of retrying the first-question endpoint",
      );
    }
    /* 对账证据二：非终态 Run（在途/未收敛）→ 结果未知，不盲发。 */
    for (const episode of this.treeRepository.listEpisodes(branch.id)) {
      for (const run of this.treeRepository.listRuns(episode.id)) {
        if (run.terminalAt === null) {
          return {
            branch,
            dispatch: "unknown",
            outcome: null,
            error: {
              code: "dispatch-unknown",
              message:
                `the first question for material branch ${branch.id} was dispatched but never reached a ` +
                "terminal state (the process exited mid-dispatch or another dispatch may still be in flight); " +
                "it was NOT re-sent — reconcile the branch's runs, then retry",
            },
            landed: null,
          };
        }
      }
    }
    /* 未送达（从未派发 / 明确失败）→ 派发（失败重试是显式允许的新尝试）。 */
    const context = this.buildContext(origin);
    try {
      const outcome = await this.studio.prompt(tree.id, branch.id, input.firstQuestion, {
        composedPrefix: context.composed,
        turnPrefix: prefix,
      });
      return {
        branch,
        dispatch: "succeeded",
        outcome,
        error: null,
        landed: {
          runId: outcome.run.id,
          userTurnId: outcome.userTurn.id,
          assistantTurnId: outcome.assistantTurn.id,
        },
      };
    } catch (err) {
      return {
        branch,
        dispatch: "failed",
        outcome: null,
        error: { code: toErrorCode(err), message: toErrorMessage(err) },
        landed: null,
      };
    }
  }

  /* ------------------------------ 同来源恢复 / 显式另开（规则五/六） ------------------------------ */

  /**
   * 给定材料锚点：恢复该来源的既有探索（mode "restore"——打开既有 Branch
   * 并续用其 session，不新建、不重注入材料上下文），或显式另开
   * （mode "new"——新 Branch + 新 session）。同一来源 = 选区身份全等
   * （材料×版本×块×区间）；同名词/同摘录在不同材料、不同版本、不同
   * Tree、甚至同版本不同偏移都**不会**被复用（零误匹配纪律，与区间解析
   * 层同一口径——绝不以相似文字兜底）。
   */
  async restoreOrOpen(input: {
    readonly treeId: TreeId;
    readonly selection: MaterialSelection;
    readonly mode: "restore" | "new";
    readonly intentKey?: string;
  }): Promise<MaterialRestoreResult> {
    if (input.mode !== "restore" && input.mode !== "new") {
      throw new InvalidArgumentError(`mode must be 'restore' or 'new' (got '${String(input.mode)}')`);
    }
    const tree = this.treeRepository.getTree(input.treeId); // 404
    this.#assertMaterialLinked(tree.id, input.selection.materialId); // 404
    this.materialRepository.getMaterialSelection(input.selection); // 选区纪律（404/400）
    if (input.mode === "new") {
      if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
        throw new InvalidArgumentError("mode 'new' requires an intentKey (a new exploration is a new submission)");
      }
      const creation = this.createMaterialBranch({
        treeId: tree.id,
        selection: input.selection,
        intentKey: input.intentKey,
      });
      return {
        mode: "created",
        branch: creation.branch,
        origin: creation.origin,
        context: creation.context,
        created: creation.created,
        navigation: null,
        sessionAvailability: null,
      };
    }
    const target = this.#findExplorationForSelection(tree.id, input.selection);
    /* 打开既有探索：对准其续聊点（导航失败如实分离——分支与来源照常返回，
       session 不可用时 UI 给出显式新探索入口，charter §5）。 */
    let navigation: MaterialRestoreResult["navigation"];
    try {
      const cursor = await this.studio.switchBranch(tree.id, target.branch.id);
      navigation = cursor === null ? { status: "no-session" } : { status: "navigated" };
    } catch (err) {
      navigation = { status: "failed", code: toErrorCode(err), message: toErrorMessage(err) };
    }
    const view = this.studio
      .getTreeState(tree.id)
      .branches.find((candidate) => candidate.branch.id === target.branch.id);
    return {
      mode: "restored",
      branch: target.branch,
      origin: target.origin,
      context: this.buildContext(target.origin),
      created: false,
      navigation,
      sessionAvailability: view?.sessionAvailability ?? null,
    };
  }

  /** 树内以该选区为来源的最新探索（多枝时取最新；无则 404）。 */
  #findExplorationForSelection(
    treeId: TreeId,
    selection: MaterialSelection,
  ): { readonly branch: Branch; readonly origin: MaterialBranchOrigin } {
    const branches = this.treeRepository.listBranches(treeId); // created_at, rowid 序
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const branch = branches[index]!;
      const originRef = this.materialRepository.getBranchOrigin(branch.id);
      if (originRef === null || originRef.kind !== "material") continue;
      if (sameMaterialSelectionIdentity(originRef.origin.selection, selection)) {
        return { branch, origin: originRef.origin };
      }
    }
    throw new EntityNotFoundError(
      `material exploration for this source in tree ${treeId}`,
      `${selection.materialId} ${selection.versionId} ${selection.blockId} [${String(selection.start)},${String(selection.end)})`,
    );
  }

  /* ------------------------------ Return（规则七） ------------------------------ */

  /**
   * 材料 Branch 的 Return：完全复用 studio.submitReturn（保存先于导航、
   * 幂等键、采用尝试/成功分离——W1 §3.2/§3.5 既有语义），叠加材料卡片数据
   * （标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump）。targetAnchor
   * 为 null（材料来源没有主线对话锚点，主线按确认时间放置，绝不伪造）。
   */
  async submitMaterialReturn(input: {
    readonly treeId: TreeId;
    readonly fromBranchId: BranchId;
    readonly text: string;
    readonly idempotencyKey: string;
  }): Promise<MaterialReturnSubmission> {
    const tree = this.treeRepository.getTree(input.treeId); // 404
    const branch = this.treeRepository.getBranch(input.fromBranchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `branch ${input.fromBranchId} belongs to tree ${branch.treeId}, not ${tree.id}`,
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${input.fromBranchId} is not a material branch; use the standard return endpoint for turn-source branches`,
      );
    }
    const submission = await this.studio.submitReturn(
      tree.id,
      branch.id,
      input.text,
      input.idempotencyKey,
    );
    return {
      returnTurn: submission.turn,
      created: submission.created,
      navigation: submission.navigation,
      card: this.#returnCard(submission.turn, originRef.origin),
    };
  }

  /** 材料 Return 卡片（从不可变材料来源 + return turn 派生）。 */
  #returnCard(turn: Turn, origin: MaterialBranchOrigin): MaterialReturnCard {
    const anchored = this.materialRepository.getMaterialSelection(origin.selection);
    const content = this.materialRepository.getVersionContent(origin.selection.versionId);
    const block = content.blocks.find((entry) => entry.blockId === origin.selection.blockId) ?? null;
    const attempts = this.treeRepository.listReturnAdoptionAttempts(turn.id);
    const status: MaterialReturnCard["adoption"]["status"] =
      turn.deliveredRunId !== null ? "adopted" : attempts.length > 0 ? "attempted" : "saved";
    return {
      materialId: anchored.material.id,
      materialTitle: anchored.material.title,
      versionId: origin.selection.versionId,
      parserKind: content.version.parserKind,
      parserVersion: content.version.parserVersion,
      blockId: origin.selection.blockId,
      page: block?.page ?? null,
      excerpt: origin.selection.excerpt,
      sourceJump: {
        materialId: origin.selection.materialId,
        versionId: origin.selection.versionId,
        blockId: origin.selection.blockId,
        start: origin.selection.start,
        end: origin.selection.end,
        sourceHash: origin.selection.sourceHash,
      },
      confirmTime: turn.createdAt,
      adoption: { attempts: attempts.length, deliveredRunId: turn.deliveredRunId, status },
    };
  }

  /* ------------------------------ 缺 session 显式新探索（规则八） ------------------------------ */

  /**
   * 「以保存内容开始新的探索」的材料分支版（W1 §3.4 / signed v3 §4.4 语义
   * + 材料上下文随行）：仅在该分支续聊点 session **当前不可用**时成立
   * （可用 → NewExplorationConflictError 409，应走普通续聊；无历史 session
   * 同样拒绝——普通 prompt 即会新建）。新 session 的首问以
   * #newExplorationContext（显式声明旧上下文未恢复 + 材料来源上下文块 +
   * 分支已保存历史文本化带入）+ 用户问题为真实输入；旧历史保持可读，
   * 来源关系（材料 origin）不动。
   */
  async promptNewMaterialExploration(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    const tree = this.treeRepository.getTree(treeId); // 404
    const branch = this.treeRepository.getBranch(branchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branchId} is not a material branch; use the standard new-exploration endpoint for turn-source branches`,
      );
    }
    const context = this.buildContext(originRef.origin);
    return this.studio.prompt(tree.id, branch.id, text, {
      newExploration: true,
      newExplorationMaterialContext: context.composed,
    });
  }

  /* ------------------------------ 内部校验 ------------------------------ */

  /** 材料必须链接到该树（一树多材料、一材料多树——讨论/Return 按树隔离）。 */
  #assertMaterialLinked(treeId: TreeId, materialId: MaterialId): void {
    const linked = this.materialRepository
      .listTreeMaterials(treeId)
      .some((material) => material.id === materialId);
    if (!linked) {
      throw new EntityNotFoundError(`material in tree ${treeId}`, materialId);
    }
  }

  #trunkOf(treeId: TreeId): Branch {
    const trunk = this.treeRepository.listBranches(treeId).find((branch) => branch.parentBranchId === null);
    if (trunk === undefined) {
      throw new InvalidArgumentError(`tree ${treeId} has no trunk (root) branch`);
    }
    return trunk;
  }
}
