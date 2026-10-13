import type {
  TreeDomainContext,
} from "./context.ts";
import {
  TreeEntitiesRepository,
} from "./entities.ts";
import {
  TreeRunsRepository,
} from "./runs.ts";
import {
  TreeTurnsRepository,
} from "./turns.ts";
import {
  TreeTerminologyRepository,
} from "./terminology.ts";
import {
  TreeNavigationRepository,
} from "./navigation.ts";
/** repository ownership for tree-repository.ts; compatibility entrypoint remains one level above. */
import {
  type BackupValidation,
  checkIntegrity,
  type IntegrityReport,
  openDatabase,
  vacuumInto,
  validateDatabaseFile,
} from "../database.ts";
import {
  BackupError,
  RepositoryClosedError,
} from "../errors.ts";

import type {
  ActiveNavigation,
  BranchRecovery,
  CreateBackupOptions,
  CreateBranchInput,
  CreateTerminologyAnnotationInput,
  CreateTerminologyDispatchInput,
  CreateTurnInput,
  RestoreOptions,
  ReturnAdoptionAttempt,
  SessionFileSweepResult,
  SetBranchOriginInput,
  SettleTerminologyDispatchInput,
  TreeRecovery,
  TreeRepositoryOptions,
  UpdateRunStateOptions,
} from "./model.ts";

import {
  assertNonEmptyString,
} from "./validation.ts";
import type {
  Branch,
  BranchId,
  BranchOrigin,
  Episode,
  EpisodeId,
  Forest,
  ForestId,
  IsoTimestamp,
  NavTreeExpandState,
  Run,
  RunId,
  RunState,
  SessionAvailability,
  SessionReference,
  TerminologyAnnotation,
  TerminologyPromotionDispatch,
  Tree,
  TreeAIError,
  TreeId,
  Turn,
  TurnId,
} from "@treeai/contracts";
import {
  randomUUID,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import type {
  DatabaseSync,
} from "node:sqlite";

export class TreeRepository {
  readonly path: string;
  readonly now: () => IsoTimestamp;
  readonly #generateId: () => string;
  readonly #busyTimeoutMs: number;
  #db: DatabaseSync | null;
  #txDepth: number;
  readonly #entities: TreeEntitiesRepository;
  readonly #runs: TreeRunsRepository;
  readonly #turns: TreeTurnsRepository;
  readonly #terminology: TreeTerminologyRepository;
  readonly #navigation: TreeNavigationRepository;

  private constructor(options: TreeRepositoryOptions, db: DatabaseSync) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.#db = db;
    this.#txDepth = 0;
    const domainContext: TreeDomainContext = {
      database: () => { this.#assertOpen(); return this.#db!; },
      assertOpen: () => this.#assertOpen(),
      now: () => this.now(),
      newId: (prefix) => this.#newId(prefix),
      repository: this,
    };
    this.#entities = new TreeEntitiesRepository(domainContext);
    this.#runs = new TreeRunsRepository(domainContext);
    this.#turns = new TreeTurnsRepository(domainContext);
    this.#terminology = new TreeTerminologyRepository(domainContext);
    this.#navigation = new TreeNavigationRepository(domainContext);
  }

  /**
   * 打开（必要时迁移）数据库并返回仓储实例。
   * 失败语义见 `openDatabase`（损坏/外来库/版本过新/migration 失败均明确抛错）。
   */
  static open(options: TreeRepositoryOptions): TreeRepository {
    const opened = openDatabase({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    return new TreeRepository(options, opened.db);
  }

  /** 当前 schema 版本（user_version）。 */
  get schemaVersion(): number {
    this.#assertOpen();
    const row = this.#db!.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  isClosed(): boolean {
    return this.#db === null;
  }

  close(): void {
    const db = this.#db;
    if (db === null) return;
    this.#db = null;
    this.#txDepth = 0;
    db.close();
  }

  #assertOpen(): void {
    if (this.#db === null) throw new RepositoryClosedError();
  }

  #newId(prefix: string): string {
    return `${prefix}_${this.#generateId()}`;
  }

  /* ------------------------------ 事务 ------------------------------ */

  /**
   * 在事务中执行 `fn`。
   * - 顶层：`BEGIN IMMEDIATE` … `COMMIT`；`fn` 抛错则 `ROLLBACK` 并原样重抛；
   * - 嵌套：`SAVEPOINT`，内层失败只回滚内层（调用方捕获后外层可继续）。
   */
  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    const db = this.#db!;
    if (this.#txDepth === 0) {
      db.exec("BEGIN IMMEDIATE");
      this.#txDepth = 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        this.#txDepth = 0;
        return result;
      } catch (error) {
        this.#txDepth = 0;
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务已不存在（驱动已自动回滚）——保留原始错误。
        }
        throw error;
      }
    }
    const depth = this.#txDepth;
    const sp = `treeai_sp_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    this.#txDepth = depth + 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      this.#txDepth = depth;
      return result;
    } catch (error) {
      this.#txDepth = depth;
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {
        // savepoint 已不存在——保留原始错误。
      }
      throw error;
    }
  }

  #assertNoTransaction(context: string): void {
    if (this.#txDepth !== 0) {
      throw new BackupError(`${context} cannot run inside a transaction`);
    }
  }
  createForest(input?: { id?: ForestId }): Forest {
    return this.#entities.createForest(input);
  }

  getForest(id: ForestId): Forest {
    return this.#entities.getForest(id);
  }

  findForest(id: ForestId): Forest | null {
    return this.#entities.findForest(id);
  }

  listForests(): Forest[] {
    return this.#entities.listForests();
  }

  createTree(forestId: ForestId, input?: { id?: TreeId }): Tree {
    return this.#entities.createTree(forestId, input);
  }

  getTree(id: TreeId): Tree {
    return this.#entities.getTree(id);
  }

  findTree(id: TreeId): Tree | null {
    return this.#entities.findTree(id);
  }

  listTrees(forestId: ForestId): Tree[] {
    return this.#entities.listTrees(forestId);
  }

  createBranch(treeId: TreeId, input?: CreateBranchInput): Branch {
    return this.#entities.createBranch(treeId, input);
  }

  getBranch(id: BranchId): Branch {
    return this.#entities.getBranch(id);
  }

  findBranch(id: BranchId): Branch | null {
    return this.#entities.findBranch(id);
  }

  listBranches(treeId: TreeId): Branch[] {
    return this.#entities.listBranches(treeId);
  }

  createEpisode(branchId: BranchId, input?: { id?: EpisodeId }): Episode {
    return this.#runs.createEpisode(branchId, input);
  }

  getEpisode(id: EpisodeId): Episode {
    return this.#runs.getEpisode(id);
  }

  findEpisode(id: EpisodeId): Episode | null {
    return this.#runs.findEpisode(id);
  }

  listEpisodes(branchId: BranchId): Episode[] {
    return this.#runs.listEpisodes(branchId);
  }

  createRun(episodeId: EpisodeId, session: SessionReference, input?: { id?: RunId }): Run {
    return this.#runs.createRun(episodeId, session, input);
  }

  getRun(id: RunId): Run {
    return this.#runs.getRun(id);
  }

  findRun(id: RunId): Run | null {
    return this.#runs.findRun(id);
  }

  listRuns(episodeId: EpisodeId): Run[] {
    return this.#runs.listRuns(episodeId);
  }

  updateRunState(runId: RunId, to: RunState, options?: UpdateRunStateOptions): Run {
    return this.#runs.updateRunState(runId, to, options);
  }

  listNonTerminalRuns(): Run[] {
    return this.#runs.listNonTerminalRuns();
  }

  failNonTerminalRuns(failure: TreeAIError): Run[] {
    return this.#runs.failNonTerminalRuns(failure);
  }

  updateRunSessionReference(runId: RunId, reference: SessionReference): void {
    return this.#runs.updateRunSessionReference(runId, reference);
  }

  updateSessionAvailability(runId: RunId, availability: SessionAvailability): void {
    return this.#runs.updateSessionAvailability(runId, availability);
  }

  markSessionFileAvailability(sessionFile: string, exists: boolean): number {
    return this.#runs.markSessionFileAvailability(sessionFile, exists);
  }

  refreshSessionAvailability(
    exists: (sessionFile: string) => boolean = (f) => existsSync(f),
  ): SessionFileSweepResult[] {
    return this.#runs.refreshSessionAvailability(exists);
  }

  getSessionReferencesByFile(sessionFile: string): Array<{ runId: RunId; reference: SessionReference }> {
    return this.#runs.getSessionReferencesByFile(sessionFile);
  }

  createTurn(input: CreateTurnInput): Turn {
    return this.#turns.createTurn(input);
  }

  getTurn(id: TurnId): Turn {
    return this.#turns.getTurn(id);
  }

  findTurn(id: TurnId): Turn | null {
    return this.#turns.findTurn(id);
  }

  listTurns(branchId: BranchId): Turn[] {
    return this.#turns.listTurns(branchId);
  }

  listTurnsForTree(treeId: TreeId): Turn[] {
    return this.#turns.listTurnsForTree(treeId);
  }

  findReturnByIdempotencyKey(treeId: TreeId, idempotencyKey: string): Turn | null {
    return this.#turns.findReturnByIdempotencyKey(treeId, idempotencyKey);
  }

  setBranchOrigin(input: SetBranchOriginInput): BranchOrigin {
    return this.#turns.setBranchOrigin(input);
  }

  getBranchOrigin(branchId: BranchId): BranchOrigin {
    return this.#turns.getBranchOrigin(branchId);
  }

  findBranchOrigin(branchId: BranchId): BranchOrigin | null {
    return this.#turns.findBranchOrigin(branchId);
  }

  hasMaterialBranchOrigin(branchId: BranchId): boolean {
    return this.#turns.hasMaterialBranchOrigin(branchId);
  }

  markReturnDelivered(turnId: TurnId, runId: RunId): void {
    return this.#turns.markReturnDelivered(turnId, runId);
  }

  recordReturnAdoptionAttempt(turnId: TurnId, runId: RunId): void {
    return this.#turns.recordReturnAdoptionAttempt(turnId, runId);
  }

  listReturnAdoptionAttempts(turnId: TurnId): ReturnAdoptionAttempt[] {
    return this.#turns.listReturnAdoptionAttempts(turnId);
  }

  createTerminologyAnnotation(input: CreateTerminologyAnnotationInput): TerminologyAnnotation {
    return this.#terminology.createTerminologyAnnotation(input);
  }

  getTerminologyAnnotation(id: string): TerminologyAnnotation {
    return this.#terminology.getTerminologyAnnotation(id);
  }

  findTerminologyAnnotation(id: string): TerminologyAnnotation | null {
    return this.#terminology.findTerminologyAnnotation(id);
  }

  listTerminologyAnnotations(treeId: TreeId): TerminologyAnnotation[] {
    return this.#terminology.listTerminologyAnnotations(treeId);
  }

  findTerminologyAnnotationByRange(
    treeId: TreeId,
    anchorTurnId: TurnId,
    start: number,
    end: number,
  ): TerminologyAnnotation | null {
    return this.#terminology.findTerminologyAnnotationByRange(treeId, anchorTurnId, start, end);
  }

  bindTerminologyPromotion(annotationId: string, promotionKey: string, branchId: BranchId): boolean {
    return this.#terminology.bindTerminologyPromotion(annotationId, promotionKey, branchId);
  }

  findTerminologyAnnotationByPromotionKey(treeId: TreeId, promotionKey: string): TerminologyAnnotation | null {
    return this.#terminology.findTerminologyAnnotationByPromotionKey(treeId, promotionKey);
  }

  createTerminologyDispatch(input: CreateTerminologyDispatchInput): TerminologyPromotionDispatch {
    return this.#terminology.createTerminologyDispatch(input);
  }

  findTerminologyDispatchByAnnotation(annotationId: string): TerminologyPromotionDispatch | null {
    return this.#terminology.findTerminologyDispatchByAnnotation(annotationId);
  }

  getTerminologyDispatchByAnnotation(annotationId: string): TerminologyPromotionDispatch {
    return this.#terminology.getTerminologyDispatchByAnnotation(annotationId);
  }

  markTerminologyDispatchSent(annotationId: string): TerminologyPromotionDispatch {
    return this.#terminology.markTerminologyDispatchSent(annotationId);
  }

  settleTerminologyDispatch(
    annotationId: string,
    outcome: SettleTerminologyDispatchInput,
  ): TerminologyPromotionDispatch {
    return this.#terminology.settleTerminologyDispatch(annotationId, outcome);
  }

  getTerminologyState(key: string): string | null {
    return this.#terminology.getTerminologyState(key);
  }

  setTerminologyState(key: string, value: string): void {
    return this.#terminology.setTerminologyState(key, value);
  }

  saveActiveNavigation(treeId: TreeId, branchId: BranchId, reference: SessionReference): ActiveNavigation {
    return this.#navigation.saveActiveNavigation(treeId, branchId, reference);
  }

  findActiveNavigation(treeId: TreeId): ActiveNavigation | null {
    return this.#navigation.findActiveNavigation(treeId);
  }

  saveNavExpandState(input: {
    readonly treeId: TreeId;
    readonly expandedBranchIds: readonly BranchId[];
    readonly selectedBranchId: BranchId | null;
  }): NavTreeExpandState {
    return this.#navigation.saveNavExpandState(input);
  }

  findNavExpandState(treeId: TreeId): NavTreeExpandState | null {
    return this.#navigation.findNavExpandState(treeId);
  }

  getBranchRecovery(branchId: BranchId): BranchRecovery {
    return this.#navigation.getBranchRecovery(branchId);
  }

  getTreeRecovery(treeId: TreeId): TreeRecovery {
    return this.#navigation.getTreeRecovery(treeId);
  }


  /* ------------------------------ 备份 / 完整性 ------------------------------ */

  /** 在线备份（`VACUUM INTO`，生成自包含快照；不能在事务中调用）。 */
  createBackup(destination: string, options?: CreateBackupOptions): void {
    this.#assertOpen();
    this.#assertNoTransaction("createBackup");
    assertNonEmptyString(destination, "backup destination");
    if (options?.overwrite === true && existsSync(destination)) {
      rmSync(destination);
    }
    vacuumInto(this.#db!, destination);
  }

  /** 校验备份文件（可读、完整、schema 版本不高于当前支持）。 */
  static validateBackup(path: string): BackupValidation {
    return validateDatabaseFile(path);
  }

  /** `PRAGMA integrity_check`。 */
  integrityCheck(): IntegrityReport {
    this.#assertOpen();
    return checkIntegrity(this.#db!);
  }

  /**
   * 从备份恢复：校验备份 →（可选）把当前库另存 → 关闭连接 →
   * 备份覆盖当前库文件 → 重新打开（旧备份版本更低时自动前向迁移）。
   * 内存库不支持（无文件可覆盖）。
   */
  restoreFromBackup(backupPath: string, options?: RestoreOptions): void {
    this.#assertOpen();
    this.#assertNoTransaction("restoreFromBackup");
    assertNonEmptyString(backupPath, "backup path");
    const validation = validateDatabaseFile(backupPath);
    if (!validation.valid) {
      throw new BackupError(
        `backup file is not a valid TreeAI database: ${backupPath} ` +
          `(schema version ${validation.schemaVersion}, integrity ok=${validation.integrity.ok})`,
      );
    }
    if (this.path === ":memory:" || this.path.startsWith("file::memory:")) {
      throw new BackupError("restoreFromBackup is not supported for in-memory repositories");
    }
    if (options?.backupCurrentTo !== undefined) {
      assertNonEmptyString(options.backupCurrentTo, "backupCurrentTo");
      vacuumInto(this.#db!, options.backupCurrentTo);
    }

    this.close();
    try {
      copyFileSync(backupPath, this.path);
      // 移除旧 WAL/SHM 侧车文件，防止陈旧 WAL 与新主文件组合。
      rmSync(`${this.path}-wal`, { force: true });
      rmSync(`${this.path}-shm`, { force: true });
    } catch (error) {
      throw new BackupError(`failed to copy backup '${backupPath}' over '${this.path}'`, { cause: error });
    }
    const reopened = openDatabase({ path: this.path, busyTimeoutMs: this.#busyTimeoutMs });
    this.#db = reopened.db;
  }
}
