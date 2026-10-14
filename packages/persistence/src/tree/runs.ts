/** runs SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  InvalidRunStateTransitionError,
  mapSqliteError,
  RunTerminalConflictError,
} from "../errors.ts";
import {
  encodeFailure,
  type EpisodeRow,
  rowToEpisode,
  rowToRun,
  rowToSessionReference,
  type RunRow,
  type SessionReferenceRow,
} from "../serialization.ts";
import type {
  SessionFileSweepResult,
  UpdateRunStateOptions,
} from "./model.ts";
import {
  MISSING_FILE_DETAIL,
} from "./policy.ts";
import {
  assertNonEmptyString,
  assertValidSessionReference,
  availabilityToColumns,
  isAllowedRunTransition,
  isTerminalRunState,
} from "./validation.ts";
import type {
  BranchId,
  Episode,
  EpisodeId,
  Run,
  RunId,
  RunState,
  SessionAvailability,
  SessionReference,
  TreeAIError,
} from "@treeai/contracts";

import {
  existsSync,
} from "node:fs";

import type {
  TreeDomainContext,
} from "./context.ts";

export class TreeRunsRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }


  /* ------------------------------ Episode ------------------------------ */

  createEpisode(branchId: BranchId, input?: { id?: EpisodeId }): Episode {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const branch = this.#context.repository.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    const id = input?.id ?? (this.#context.newId("episode") as EpisodeId);
    assertNonEmptyString(id, "episode id");
    const createdAt = this.#context.now();
    try {
      this.#context.database()!.prepare("INSERT INTO episodes (id, branch_id, created_at) VALUES (?, ?, ?)").run(
        id,
        branchId,
        createdAt,
      );
    } catch (error) {
      throw mapSqliteError(error, "creating episode");
    }
    return { id, branchId, createdAt };
  }


  getEpisode(id: EpisodeId): Episode {
    const found = this.findEpisode(id);
    if (found === null) throw new EntityNotFoundError("episode", id);
    return found;
  }


  findEpisode(id: EpisodeId): Episode | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "episode id");
    const row = this.#context.database()!.prepare("SELECT id, branch_id, created_at FROM episodes WHERE id = ?").get(id) as
      | EpisodeRow
      | undefined;
    return row ? rowToEpisode(row) : null;
  }


  listEpisodes(branchId: BranchId): Episode[] {
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const rows = this.#context.database()!
      .prepare("SELECT id, branch_id, created_at FROM episodes WHERE branch_id = ? ORDER BY created_at, rowid")
      .all(branchId) as unknown as EpisodeRow[];
    return rows.map(rowToEpisode);
  }


  /* ------------------------------ Run ------------------------------ */

  /** 创建 Run（初始态 `queued`，contracts run-state I1）并保存其 session 引用。 */
  createRun(episodeId: EpisodeId, session: SessionReference, input?: { id?: RunId }): Run {
    this.#context.assertOpen();
    assertNonEmptyString(episodeId, "episode id");
    const episode = this.findEpisode(episodeId);
    if (episode === null) throw new EntityNotFoundError("episode", episodeId);
    assertValidSessionReference(session, "session reference");
    const id = input?.id ?? (this.#context.newId("run") as RunId);
    assertNonEmptyString(id, "run id");
    const createdAt = this.#context.now();
    const availability = availabilityToColumns(session.availability);

    const insert = (): void => {
      try {
        this.#context.database()!
          .prepare(
            `INSERT INTO runs (id, episode_id, state, created_at, terminal_at, terminal_state, failure_json)
             VALUES (?, ?, 'queued', ?, NULL, NULL, NULL)`,
          )
          .run(id, episodeId, createdAt);
        this.#context.database()!
          .prepare(
            `INSERT INTO session_references
               (run_id, session_id, session_file, entry_id, pi_version,
                availability_status, availability_reason, availability_detail, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            session.sessionId,
            session.sessionFile,
            session.entryId,
            session.piVersion,
            availability.status,
            availability.reason,
            availability.detail,
            createdAt,
            createdAt,
          );
      } catch (error) {
        throw mapSqliteError(error, "creating run");
      }
    };
    this.#context.repository.transaction(insert);

    const created = this.findRun(id);
    if (created === null) {
      throw new DatabaseCorruptError(`run ${id} not readable after insert (schema integrity violation)`);
    }
    return created;
  }


  getRun(id: RunId): Run {
    const found = this.findRun(id);
    if (found === null) throw new EntityNotFoundError("run", id);
    return found;
  }


  findRun(id: RunId): Run | null {
    this.#context.assertOpen();
    assertNonEmptyString(id, "run id");
    const runRow = this.#runRow(id);
    if (runRow === undefined) return null;
    return this.#hydrateRun(runRow);
  }


  listRuns(episodeId: EpisodeId): Run[] {
    this.#context.assertOpen();
    assertNonEmptyString(episodeId, "episode id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json
         FROM runs WHERE episode_id = ? ORDER BY created_at, rowid`,
      )
      .all(episodeId) as unknown as RunRow[];
    return rows.map((r) => this.#hydrateRun(r));
  }


  /**
   * 更新 Run 状态。
   *
   * - 迁移合法性对照冻结迁移表（I5/I7）：非法迁移抛 `InvalidRunStateTransitionError`；
   * - 终态互斥（I3）：目标为终态时，若 run 已终态抛 `RunTerminalConflictError`
   *   （跨连接并发下条件 UPDATE 保证恰好一胜）；
   * - `failure` 当且仅当目标态为 `failed`（contracts identifiers.ts Run 不变量）；
   * - 终态写入后该 run 不可再变更（I2 吸收性）。
   */
  updateRunState(runId: RunId, to: RunState, options?: UpdateRunStateOptions): Run {
    this.#context.assertOpen();
    assertNonEmptyString(runId, "run id");
    const failure = options?.failure;
    if (isTerminalRunState(to)) {
      if (to === "failed") {
        if (failure === undefined) {
          throw new InvalidArgumentError(`transition to 'failed' requires a failure (contracts: failure iff failed)`);
        }
      } else if (failure !== undefined) {
        throw new InvalidArgumentError(`failure must not be provided for terminal state '${to}'`);
      }
    } else if (failure !== undefined) {
      throw new InvalidArgumentError(`failure must not be provided for non-terminal state '${to}'`);
    }

    const updated = this.#context.repository.transaction((): Run => this.#updateRunStateUnchecked(runId, to, failure));
    return updated;
  }


  #updateRunStateUnchecked(runId: RunId, to: RunState, failure: TreeAIError | undefined): Run {
    const db = this.#context.database()!;
    const current = db
      .prepare("SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (current === undefined) throw new EntityNotFoundError("run", runId);
    if (current.terminal_state !== null) {
      throw new RunTerminalConflictError(runId, current.terminal_state);
    }
    if (!isAllowedRunTransition(current.state as RunState, to)) {
      throw new InvalidRunStateTransitionError(runId, current.state, to);
    }

    const terminal = isTerminalRunState(to);
    const terminalAt = terminal ? this.#context.now() : null;
    const failureJson = to === "failed" && failure !== undefined ? encodeFailure(failure) : null;

    const result = db
      .prepare(
        `UPDATE runs
         SET state = ?, terminal_at = ?, terminal_state = ?, failure_json = ?
         WHERE id = ? AND terminal_state IS NULL AND state = ?`,
      )
      .run(to, terminalAt, terminal ? to : null, failureJson, runId, current.state);
    if (Number(result.changes) === 0) {
      // 并发竞争：另一写入方已改变该 run。重新读取判定冲突种类。
      const after = db
        .prepare(
          "SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?",
        )
        .get(runId) as RunRow | undefined;
      if (after === undefined) throw new EntityNotFoundError("run", runId);
      if (after.terminal_state !== null) {
        throw new RunTerminalConflictError(runId, after.terminal_state);
      }
      throw new InvalidRunStateTransitionError(runId, after.state, to);
    }

    const updated = this.findRun(runId);
    if (updated === null) {
      throw new DatabaseCorruptError(`run ${runId} not readable after update (schema integrity violation)`);
    }
    return updated;
  }


  /** 全部非终态 run（重启恢复 I6 清扫的输入）。 */
  listNonTerminalRuns(): Run[] {
    this.#context.assertOpen();
    const rows = this.#context.database()!
      .prepare(
        `SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json
         FROM runs WHERE terminal_state IS NULL ORDER BY created_at, rowid`,
      )
      .all() as unknown as RunRow[];
    return rows.map((r) => this.#hydrateRun(r));
  }


  /**
   * I6 重启恢复清扫：把所有非终态（queued/running/aborting）run 置为
   * `failed` 并记录 failure（宿主崩溃语义：code "unknown" + 建议携带
   * `{ hostInterrupted: true }`——由调用方构造）。返回被收敛的 run。
   * 已终态的 run 不受影响（条件 UPDATE 保证）。
   */
  failNonTerminalRuns(failure: TreeAIError): Run[] {
    this.#context.assertOpen();
    return this.#context.repository.transaction((): Run[] => {
      const before = this.listNonTerminalRuns();
      if (before.length === 0) return [];
      const terminalAt = this.#context.now();
      const failureJson = encodeFailure(failure);
      this.#context.database()!
        .prepare(
          `UPDATE runs
           SET state = 'failed', terminal_at = ?, terminal_state = 'failed', failure_json = ?
           WHERE terminal_state IS NULL`,
        )
        .run(terminalAt, failureJson);
      return before.map((r) => this.getRun(r.id));
    });
  }


  /* ------------------------------ SessionReference ------------------------------ */

  /**
   * 更新 run 的 session 引用（prompt/navigateTree 之后 entryId 前进；
   * contracts：以新引用更新，不就地修改——本方法整体替换）。
   */
  updateRunSessionReference(runId: RunId, reference: SessionReference): void {
    this.#context.assertOpen();
    assertNonEmptyString(runId, "run id");
    assertValidSessionReference(reference, "session reference");
    const existing = this.#runRow(runId);
    if (existing === undefined) throw new EntityNotFoundError("run", runId);
    const availability = availabilityToColumns(reference.availability);
    const updated = this.#context.now();
    const result = this.#context.database()!
      .prepare(
        `UPDATE session_references
         SET session_id = ?, session_file = ?, entry_id = ?, pi_version = ?,
             availability_status = ?, availability_reason = ?, availability_detail = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(
        reference.sessionId,
        reference.sessionFile,
        reference.entryId,
        reference.piVersion,
        availability.status,
        availability.reason,
        availability.detail,
        updated,
        runId,
      );
    if (Number(result.changes) === 0) {
      throw new DatabaseCorruptError(
        `session reference row missing for run ${runId} (schema integrity violation)`,
      );
    }
  }


  /** 更新单个 run 的 availability（缓存评估；运行时恢复时自行实时校验）。 */
  updateSessionAvailability(runId: RunId, availability: SessionAvailability): void {
    this.#context.assertOpen();
    assertNonEmptyString(runId, "run id");
    const existing = this.#runRow(runId);
    if (existing === undefined) throw new EntityNotFoundError("run", runId);
    const columns = availabilityToColumns(availability);
    const updated = this.#context.now();
    const result = this.#context.database()!
      .prepare(
        `UPDATE session_references
         SET availability_status = ?, availability_reason = ?, availability_detail = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(columns.status, columns.reason, columns.detail, updated, runId);
    if (Number(result.changes) === 0) {
      throw new DatabaseCorruptError(
        `session reference row missing for run ${runId} (schema integrity violation)`,
      );
    }
  }


  /**
   * 按 session 文件批量更新 availability。
   * `exists=false` → 全部指向该文件的引用标记 `unavailable/missing-file`
   * （域数据不受影响——不级联删除）；`exists=true` → 恢复为 available。
   * 返回更新的引用行数。
   */
  markSessionFileAvailability(sessionFile: string, exists: boolean): number {
    this.#context.assertOpen();
    assertNonEmptyString(sessionFile, "session file");
    const updated = this.#context.now();
    const result = exists
      ? this.#context.database()!
          .prepare(
            `UPDATE session_references
             SET availability_status = 'available', availability_reason = NULL, availability_detail = NULL,
                 updated_at = ?
             WHERE session_file = ?`,
          )
          .run(updated, sessionFile)
      : this.#context.database()!
          .prepare(
            `UPDATE session_references
             SET availability_status = 'unavailable', availability_reason = 'missing-file',
                 availability_detail = ?, updated_at = ?
             WHERE session_file = ?`,
          )
          .run(MISSING_FILE_DETAIL, updated, sessionFile);
    return Number(result.changes);
  }


  /**
   * 扫描全部去重 session 文件并刷新 availability。
   * `exists` 探针由调用方注入（默认 `fs.existsSync`——仅存在性检查，
   * **不读取 Pi session 内容**）。返回每个文件更新的引用数。
   */
  refreshSessionAvailability(
    exists: (sessionFile: string) => boolean = (f) => existsSync(f),
  ): SessionFileSweepResult[] {
    this.#context.assertOpen();
    const files = this.#context.database()!.prepare("SELECT DISTINCT session_file FROM session_references").all() as unknown as Array<{
      session_file: string;
    }>;
    const results: SessionFileSweepResult[] = [];
    for (const row of files) {
      const file = row.session_file;
      const updated = this.markSessionFileAvailability(file, exists(file));
      results.push({ sessionFile: file, updatedReferences: updated });
    }
    return results;
  }


  /** 指向给定 session 文件的全部引用（含 run id）。 */
  getSessionReferencesByFile(sessionFile: string): Array<{ runId: RunId; reference: SessionReference }> {
    this.#context.assertOpen();
    assertNonEmptyString(sessionFile, "session file");
    const rows = this.#context.database()!
      .prepare("SELECT * FROM session_references WHERE session_file = ? ORDER BY created_at, rowid")
      .all(sessionFile) as unknown as SessionReferenceRow[];
    return rows.map((row) => ({ runId: row.run_id as RunId, reference: rowToSessionReference(row) }));
  }


  /* ------------------------------ 内部读取辅助 ------------------------------ */

  #runRow(runId: string): RunRow | undefined {
    return this.#context.database()!.prepare(
      "SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?",
    ).get(runId) as RunRow | undefined;
  }


  #sessionRow(runId: string): SessionReferenceRow | undefined {
    return this.#context.database()!.prepare("SELECT * FROM session_references WHERE run_id = ?").get(runId) as
      | SessionReferenceRow
      | undefined;
  }


  #hydrateRun(runRow: RunRow): Run {
    return rowToRun(runRow, this.#sessionRow(runRow.id));
  }
}
