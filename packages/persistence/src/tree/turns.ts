/** turns SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";
import {
  type BranchOriginRow,
  encodeTargetAnchor,
  type ReturnAdoptionAttemptRow,
  rowToBranchOrigin,
  rowToReturnAdoptionAttempt,
  rowToTurn,
  type TurnRow,
} from "../serialization.ts";
import type {
  CreateTurnInput,
  ReturnAdoptionAttempt,
  SetBranchOriginInput,
} from "./model.ts";
import {
  TURN_ROLES,
} from "./policy.ts";
import {
  assertNonEmptyString,
  assertValidTargetAnchor,
} from "./validation.ts";
import type {
  BranchId,
  BranchOrigin,
  RunId,
  TreeId,
  Turn,
  TurnId,
} from "@treeai/contracts";

import type {
  TreeDomainContext,
} from "./context.ts";

export class TreeTurnsRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }


  /* --------------------- D3 产品层：Turn（turns 表） --------------------- */

  /**
   * 创建 Turn（contracts product.ts 不变量的仓储层防御；
   * schema CHECK 为第二层）。分支/回合/Run 的存在性与归属先显式校验，
   * 给出可定位的错误而非裸外键失败。
   */
  createTurn(input: CreateTurnInput): Turn {
    this.#context.assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.episodeId, "episode id");
    if (typeof input.text !== "string" || (input.role !== "assistant" && input.text.trim().length === 0)) {
      throw new InvalidArgumentError(`turn text must be a non-empty string for role '${input.role}'`);
    }
    if (!TURN_ROLES.includes(input.role)) {
      throw new InvalidArgumentError(`turn role must be one of {${TURN_ROLES.join(", ")}}`);
    }
    const branch = this.#context.repository.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    if (branch.treeId !== input.treeId) {
      throw new InvalidArgumentError(
        `branch ${input.branchId} belongs to tree ${branch.treeId}, not ${input.treeId}`,
      );
    }
    const episode = this.#context.repository.findEpisode(input.episodeId);
    if (episode === null) throw new EntityNotFoundError("episode", input.episodeId);
    if (episode.branchId !== input.branchId) {
      throw new InvalidArgumentError(
        `episode ${input.episodeId} belongs to branch ${episode.branchId}, not ${input.branchId}`,
      );
    }
    const runId = input.runId ?? null;
    const fromBranchId = input.fromBranchId ?? null;
    const piEntryId = input.piEntryId ?? null;
    const idempotencyKey = input.idempotencyKey ?? null;
    const targetAnchor = input.targetAnchor ?? null;
    if (input.role === "return") {
      if (runId !== null) {
        throw new InvalidArgumentError("a return turn must not reference a run (returns are not model-executed)");
      }
      if (fromBranchId === null) {
        throw new InvalidArgumentError("a return turn requires fromBranchId (its originating branch)");
      }
      if (piEntryId !== null) {
        throw new InvalidArgumentError("a return turn carries no Pi entry anchor");
      }
      if (idempotencyKey !== null) {
        assertNonEmptyString(idempotencyKey, "idempotency key");
      }
      if (targetAnchor !== null) {
        assertValidTargetAnchor(targetAnchor);
      }
    } else {
      if (runId === null) {
        throw new InvalidArgumentError(`a '${input.role}' turn requires runId`);
      }
      if (fromBranchId !== null) {
        throw new InvalidArgumentError("fromBranchId is only valid for return turns");
      }
      if (idempotencyKey !== null) {
        throw new InvalidArgumentError("idempotencyKey is only valid for return turns");
      }
      if (targetAnchor !== null) {
        throw new InvalidArgumentError("targetAnchor is only valid for return turns");
      }
      if (this.#context.repository.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    }
    if (fromBranchId !== null && this.#context.repository.findBranch(fromBranchId) === null) {
      throw new EntityNotFoundError("branch", fromBranchId);
    }
    const id = input.id ?? (this.#context.newId("turn") as TurnId);
    assertNonEmptyString(id, "turn id");
    const createdAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO turns
             (id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
              delivered_run_id, idempotency_key, target_anchor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          input.treeId,
          input.branchId,
          input.episodeId,
          runId,
          input.role,
          input.text,
          piEntryId,
          fromBranchId,
          idempotencyKey,
          encodeTargetAnchor(targetAnchor),
          createdAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "creating turn");
    }
    return this.getTurn(id);
  }


  getTurn(id: TurnId): Turn {
    const found = this.findTurn(id);
    if (found === null) throw new EntityNotFoundError("turn", id);
    return found;
  }


  findTurn(id: TurnId): Turn | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "turn id");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE id = ?`,
      )
      .get(id) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }


  /** 分支上的全部 Turn，按追加序（created_at, rowid）。 */
  listTurns(branchId: BranchId): Turn[] {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE branch_id = ? ORDER BY created_at, rowid`,
      )
      .all(branchId) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }


  /** Tree 内按分支创建序、再按 Turn 追加序列出全部 Turn。 */
  listTurnsForTree(treeId: TreeId): Turn[] {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT t.id, t.tree_id, t.branch_id, t.episode_id, t.run_id, t.role, t.text, t.pi_entry_id,
                t.from_branch_id, t.delivered_run_id, t.idempotency_key, t.target_anchor, t.created_at
         FROM branches AS b
         INNER JOIN turns AS t ON t.branch_id = b.id
         WHERE b.tree_id = ?
         ORDER BY b.created_at, b.rowid, t.created_at, t.rowid`,
      )
      .all(treeId) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }

  /**
   * 按幂等键查找 return turn（树内定位；无键/无匹配为 null）。
   * 同键唯一由树内部分唯一索引保证（idx_turns_idempotency_key_tree，
   * UNIQUE(tree_id, idempotency_key)——已签署 W1 v3.0 §3.4：幂等键是
   * Tree 内命名空间，跨 Tree 同键各自有效），本查询是幂等重放与并发
   * 竞争后对齐的读取路径。
   */
  findReturnByIdempotencyKey(treeId: TreeId, idempotencyKey: string): Turn | null {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(idempotencyKey, "idempotency key");
    const row = this.#context.database()!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE tree_id = ? AND idempotency_key = ? AND role = 'return'`,
      )
      .get(treeId, idempotencyKey) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }


  /* --------------------- D3 产品层：BranchOrigin（branch_origins 表） --------------------- */

  /**
   * 设置分支出处锚点。锚点完整性（选区切片一致、anchorEntryId 与
   * anchor turn 的 piEntryId 相等）在此校验；每分支至多一条。
   */
  setBranchOrigin(input: SetBranchOriginInput): BranchOrigin {
    this.#context.assertOpen();
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.sourceBranchId, "source branch id");
    assertNonEmptyString(input.anchorTurnId, "anchor turn id");
    assertNonEmptyString(input.anchorEntryId, "anchor entry id");
    const branch = this.#context.repository.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    const source = this.#context.repository.findBranch(input.sourceBranchId);
    if (source === null) throw new EntityNotFoundError("branch", input.sourceBranchId);
    if (source.treeId !== branch.treeId) {
      throw new InvalidArgumentError(
        `source branch ${input.sourceBranchId} belongs to tree ${source.treeId}, not ${branch.treeId}`,
      );
    }
    if (source.id === branch.id) {
      throw new InvalidArgumentError(`branch ${input.branchId} cannot anchor to itself`);
    }
    const anchorTurn = this.findTurn(input.anchorTurnId);
    if (anchorTurn === null) throw new EntityNotFoundError("turn", input.anchorTurnId);
    if (anchorTurn.branchId !== input.sourceBranchId) {
      throw new InvalidArgumentError(
        `anchor turn ${input.anchorTurnId} belongs to branch ${anchorTurn.branchId}, not source branch ${input.sourceBranchId}`,
      );
    }
    if (anchorTurn.role !== "assistant") {
      throw new InvalidArgumentError("branch anchors must reference an assistant turn (an answer)");
    }
    if (anchorTurn.piEntryId === null) {
      throw new InvalidArgumentError(`anchor turn ${input.anchorTurnId} has no Pi entry id`);
    }
    if (anchorTurn.piEntryId !== input.anchorEntryId) {
      throw new InvalidArgumentError("anchorEntryId must equal the anchor turn's piEntryId");
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
    if (this.findBranchOrigin(input.branchId) !== null) {
      throw new InvalidArgumentError(`branch ${input.branchId} already has an origin`);
    }
    const createdAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare(
          `INSERT INTO branch_origins
             (branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, sel_start, sel_end, sel_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.branchId,
          input.sourceBranchId,
          input.anchorTurnId,
          input.anchorEntryId,
          selection.start,
          selection.end,
          selection.text,
          createdAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "setting branch origin");
    }
    return this.getBranchOrigin(input.branchId);
  }


  getBranchOrigin(branchId: BranchId): BranchOrigin {
    const found = this.findBranchOrigin(branchId);
    if (found === null) throw new EntityNotFoundError("branch origin", branchId);
    return found;
  }


  findBranchOrigin(branchId: BranchId): BranchOrigin | null {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const row = this.#context.database()!
      .prepare(
        `SELECT branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, sel_start, sel_end, sel_text, created_at
         FROM branch_origins WHERE branch_id = ?`,
      )
      .get(branchId) as BranchOriginRow | undefined;
    return row ? rowToBranchOrigin(row) : null;
  }


  /**
   * 材料来源存在性探针（D4-3，ADR-004）：该分支是否带有
   * material_branch_origins 行。材料来源的**完整读取**归
   * MaterialRepository.getBranchOrigin（ADR-003 §2 统一读取），本探针只
   * 服务产品服务的续聊点/Return 前置判定——材料分支无 Turn 来源也无 run
   * 时的 new-session 语义、材料分支 Return 的 targetAnchor=null 路径——
   * 不复制来源读模型。表随 migration 0008 落地，打开即存在。
   */
  hasMaterialBranchOrigin(branchId: BranchId): boolean {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    return (
      this.#context.database()!.prepare("SELECT 1 AS hit FROM material_branch_origins WHERE branch_id = ?").get(branchId) !==
      undefined
    );
  }


  /**
   * 标记 return turn 已由某次主干 Run 成功采用（deliveredRunId 只记录
   * **首次成功采用**的 Run——条件 UPDATE 保证至多写一次；不可二次送达，
   * 成功之后的 Run 不再重复注入）。采用尝试的完整历史（含失败/中止的
   * Run）由 return_adoption_attempts 记录，与本标记互补。
   */
  markReturnDelivered(turnId: TurnId, runId: RunId): void {
    this.#context.assertOpen();
    assertNonEmptyString(turnId, "turn id");
    assertNonEmptyString(runId, "run id");
    const turn = this.findTurn(turnId);
    if (turn === null) throw new EntityNotFoundError("turn", turnId);
    if (turn.role !== "return") {
      throw new InvalidArgumentError(`turn ${turnId} is not a return`);
    }
    if (this.#context.repository.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    const result = this.#context.database()!
      .prepare(
        `UPDATE turns SET delivered_run_id = ? WHERE id = ? AND delivered_run_id IS NULL AND role = 'return'`,
      )
      .run(runId, turnId);
    if (Number(result.changes) === 0) {
      if (turn.deliveredRunId !== null) {
        throw new InvalidArgumentError(
          `return ${turnId} was already delivered by run ${turn.deliveredRunId}`,
        );
      }
      throw new DatabaseCorruptError(`turn ${turnId} not updatable (schema integrity violation)`);
    }
  }


  /* --------------------- D3 产品层：Return 采用尝试（return_adoption_attempts 表） --------------------- */

  /**
   * 记录一次 Return 采用尝试：组装该 Return 的主干 Run 与它的关联
   * （已签署 W1 v3.0 §3.2——Run 的确定输入已包含该 Return 即为一次尝试，
   * 与该 Run 最终 succeeded/failed/aborted 无关；Run 结果由 runs 行记录）。
   * 复合主键 (return_turn_id, run_id)：同一 Return 在同一 Run 至多一条；
   * 重复记录（编程错误）以 ConstraintViolationError 拒绝，不静默去重。
   */
  recordReturnAdoptionAttempt(turnId: TurnId, runId: RunId): void {
    this.#context.assertOpen();
    assertNonEmptyString(turnId, "turn id");
    assertNonEmptyString(runId, "run id");
    const turn = this.findTurn(turnId);
    if (turn === null) throw new EntityNotFoundError("turn", turnId);
    if (turn.role !== "return") {
      throw new InvalidArgumentError(`turn ${turnId} is not a return`);
    }
    if (this.#context.repository.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    const attemptedAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare(
          "INSERT INTO return_adoption_attempts (return_turn_id, run_id, attempted_at) VALUES (?, ?, ?)",
        )
        .run(turnId, runId, attemptedAt);
    } catch (error) {
      throw mapSqliteError(error, "recording return adoption attempt");
    }
  }


  /** 某 return turn 的全部采用尝试（追加序；Run 结果经 runId 关联 runs 读取）。 */
  listReturnAdoptionAttempts(turnId: TurnId): ReturnAdoptionAttempt[] {
    this.#context.assertOpen();
    assertNonEmptyString(turnId, "turn id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT return_turn_id, run_id, attempted_at
         FROM return_adoption_attempts WHERE return_turn_id = ? ORDER BY attempted_at, rowid`,
      )
      .all(turnId) as unknown as ReturnAdoptionAttemptRow[];
    return rows.map(rowToReturnAdoptionAttempt);
  }
}
