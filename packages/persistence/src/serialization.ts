/**
 * 行 ⇄ 领域类型映射（sqlite 行 → contracts 冻结形状）。
 *
 * 品牌类型（`RunId` 等）底层为 string，从数据库读出的值以显式断言
 * 还原品牌（contracts-README §4 认可的构造方式）；写入方向由仓储层
 * 校验非空后原样存储。
 */
import type {
  Branch,
  BranchId,
  BranchOrigin,
  Episode,
  EpisodeId,
  Forest,
  ForestId,
  IsoTimestamp,
  JsonRecord,
  PiEntryId,
  ReturnTargetAnchor,
  Run,
  RunId,
  RunState,
  SessionAvailability,
  SessionReference,
  SessionUnavailableReason,
  Tree,
  TreeAIError,
  TreeAIErrorCode,
  TreeId,
  Turn,
  TurnId,
  TurnRole,
  TurnSelection,
} from "@treeai/contracts";
import { DatabaseCorruptError } from "./errors.ts";

/* ------------------------------ 行形状 ------------------------------ */

export interface ForestRow {
  id: string;
  created_at: string;
}
export interface TreeRow {
  id: string;
  forest_id: string;
  created_at: string;
}
export interface BranchRow {
  id: string;
  tree_id: string;
  parent_branch_id: string | null;
  created_at: string;
}
export interface EpisodeRow {
  id: string;
  branch_id: string;
  created_at: string;
}
export interface RunRow {
  id: string;
  episode_id: string;
  state: string;
  created_at: string;
  terminal_at: string | null;
  terminal_state: string | null;
  failure_json: string | null;
}
export interface SessionReferenceRow {
  run_id: string;
  session_id: string;
  session_file: string;
  entry_id: string;
  pi_version: string;
  availability_status: string;
  availability_reason: string | null;
  availability_detail: string | null;
  created_at: string;
  updated_at: string;
}
export interface TurnRow {
  id: string;
  tree_id: string;
  branch_id: string;
  episode_id: string;
  run_id: string | null;
  role: string;
  text: string;
  pi_entry_id: string | null;
  from_branch_id: string | null;
  delivered_run_id: string | null;
  idempotency_key: string | null;
  target_anchor: string | null;
  created_at: string;
}
export interface BranchOriginRow {
  branch_id: string;
  source_branch_id: string;
  anchor_turn_id: string;
  anchor_entry_id: string;
  sel_start: number;
  sel_end: number;
  sel_text: string;
  created_at: string;
}
export interface ReturnAdoptionAttemptRow {
  return_turn_id: string;
  run_id: string;
  attempted_at: string;
}
export interface ActiveNavigationRow {
  tree_id: string;
  branch_id: string;
  session_id: string;
  session_file: string;
  entry_id: string;
  pi_version: string;
  availability_status: string;
  availability_reason: string | null;
  availability_detail: string | null;
  updated_at: string;
}

/* ------------------------------ 领域还原 ------------------------------ */

export function rowToForest(row: ForestRow): Forest {
  return { id: row.id as ForestId, createdAt: row.created_at as IsoTimestamp };
}

export function rowToTree(row: TreeRow): Tree {
  return {
    id: row.id as TreeId,
    forestId: row.forest_id as ForestId,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export function rowToBranch(row: BranchRow): Branch {
  return {
    id: row.id as BranchId,
    treeId: row.tree_id as TreeId,
    parentBranchId: (row.parent_branch_id as BranchId | null) ?? null,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id as EpisodeId,
    branchId: row.branch_id as BranchId,
    createdAt: row.created_at as IsoTimestamp,
  };
}

const RUN_STATES: readonly string[] = ["queued", "running", "aborting", "succeeded", "failed", "aborted"];

export function isRunState(value: string): value is RunState {
  return RUN_STATES.includes(value);
}

/** 断言行内 state 是冻结状态机的合法成员（schema CHECK 之外的双保险）。 */
export function assertRunState(state: string, context: string): RunState {
  if (!isRunState(state)) {
    throw new DatabaseCorruptError(`invalid run state '${state}' in database (${context})`);
  }
  return state;
}

/** 反序列化 failure（只还原 code/message/details；cause 永不入库）。 */
export function decodeFailure(json: string | null): TreeAIError | undefined {
  if (json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DatabaseCorruptError(`stored failure_json is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DatabaseCorruptError(`stored failure_json is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    throw new DatabaseCorruptError(`stored failure_json lacks code/message`);
  }
  const code = record.code as TreeAIErrorCode;
  const message = record.message;
  const failure: TreeAIError =
    record.details === undefined
      ? { code, message }
      : { code, message, details: record.details as JsonRecord };
  return failure;
}

/** 序列化 failure（丢弃 cause——契约要求 cause 不原样入库）。 */
export function encodeFailure(failure: TreeAIError): string {
  const encoded: Record<string, unknown> = { code: failure.code, message: failure.message };
  if (failure.details !== undefined) {
    encoded.details = failure.details;
  }
  return JSON.stringify(encoded);
}

export function rowToSessionReference(row: SessionReferenceRow): SessionReference {
  const availability: SessionAvailability =
    row.availability_status === "available"
      ? { status: "available" }
      : {
          status: "unavailable",
          reason: row.availability_reason as SessionUnavailableReason,
          ...(row.availability_detail !== null ? { detail: row.availability_detail } : {}),
        };
  return {
    sessionId: row.session_id,
    sessionFile: row.session_file,
    entryId: row.entry_id,
    piVersion: row.pi_version,
    availability,
  } as SessionReference;
}

export function rowToRun(run: RunRow, sessionRow: SessionReferenceRow | undefined): Run {
  const state = assertRunState(run.state, `run ${run.id}`);
  const failure = decodeFailure(run.failure_json);
  const base: Run = {
    id: run.id as RunId,
    episodeId: run.episode_id as EpisodeId,
    state,
    session: rowToSessionReference(
      sessionRow ?? {
        run_id: run.id,
        session_id: "",
        session_file: "",
        entry_id: "",
        pi_version: "",
        availability_status: "unavailable",
        availability_reason: "unknown",
        availability_detail: "session reference row missing (schema integrity violation)",
        created_at: run.created_at,
        updated_at: run.created_at,
      },
    ),
    createdAt: run.created_at as IsoTimestamp,
    terminalAt: (run.terminal_at as IsoTimestamp | null) ?? null,
  };
  if (failure !== undefined) {
    return { ...base, failure };
  }
  return base;
}

/* ------------------------------ D3 产品层 ------------------------------ */

const TURN_ROLES: readonly string[] = ["user", "assistant", "return"];

export function isTurnRole(value: string): value is TurnRole {
  return TURN_ROLES.includes(value);
}

/** 断言行内 role 是合法 TurnRole（schema CHECK 之外的双保险）。 */
export function assertTurnRole(role: string, context: string): TurnRole {
  if (!isTurnRole(role)) {
    throw new DatabaseCorruptError(`invalid turn role '${role}' in database (${context})`);
  }
  return role;
}

/** 序列化 return 目标锚点快照（null 保持 null；不进 JSON 的字段不存在）。 */
export function encodeTargetAnchor(anchor: ReturnTargetAnchor | null): string | null {
  if (anchor === null) return null;
  return JSON.stringify(anchor);
}

/** 反序列化 return 目标锚点快照（无锚点为 null；损坏 JSON 按库损坏处理）。 */
export function decodeTargetAnchor(json: string | null | undefined): ReturnTargetAnchor | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DatabaseCorruptError(`stored target_anchor is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DatabaseCorruptError(`stored target_anchor is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const selection = record.selection as Partial<TurnSelection> | undefined;
  if (
    typeof record.sourceBranchId !== "string" ||
    typeof record.anchorTurnId !== "string" ||
    typeof record.anchorEntryId !== "string" ||
    typeof selection !== "object" ||
    selection === null ||
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end) ||
    typeof selection.text !== "string"
  ) {
    throw new DatabaseCorruptError(
      `stored target_anchor lacks the ReturnTargetAnchor shape {sourceBranchId, anchorTurnId, anchorEntryId, selection}`,
    );
  }
  return {
    sourceBranchId: record.sourceBranchId as BranchId,
    anchorTurnId: record.anchorTurnId as TurnId,
    anchorEntryId: record.anchorEntryId,
    selection: selection as TurnSelection,
  };
}

export function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id as TurnId,
    treeId: row.tree_id as TreeId,
    branchId: row.branch_id as BranchId,
    episodeId: row.episode_id as EpisodeId,
    runId: (row.run_id as RunId | null) ?? null,
    role: assertTurnRole(row.role, `turn ${row.id}`),
    text: row.text,
    piEntryId: (row.pi_entry_id as PiEntryId | null) ?? null,
    fromBranchId: (row.from_branch_id as BranchId | null) ?? null,
    deliveredRunId: (row.delivered_run_id as RunId | null) ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    targetAnchor: decodeTargetAnchor(row.target_anchor),
    createdAt: row.created_at as IsoTimestamp,
  };
}

export function rowToBranchOrigin(row: BranchOriginRow): BranchOrigin {
  return {
    branchId: row.branch_id as BranchId,
    sourceBranchId: row.source_branch_id as BranchId,
    anchorTurnId: row.anchor_turn_id as TurnId,
    anchorEntryId: row.anchor_entry_id as PiEntryId,
    selection: {
      start: Number(row.sel_start),
      end: Number(row.sel_end),
      text: row.sel_text,
    },
    createdAt: row.created_at as IsoTimestamp,
  };
}

export function rowToReturnAdoptionAttempt(row: ReturnAdoptionAttemptRow): {
  runId: RunId;
  attemptedAt: IsoTimestamp;
} {
  return { runId: row.run_id as RunId, attemptedAt: row.attempted_at as IsoTimestamp };
}

export function rowToActiveNavigation(row: ActiveNavigationRow): {
  treeId: TreeId;
  branchId: BranchId;
  reference: SessionReference;
  updatedAt: IsoTimestamp;
} {
  return {
    treeId: row.tree_id as TreeId,
    branchId: row.branch_id as BranchId,
    reference: rowToSessionReference({
      run_id: "",
      session_id: row.session_id,
      session_file: row.session_file,
      entry_id: row.entry_id,
      pi_version: row.pi_version,
      availability_status: row.availability_status,
      availability_reason: row.availability_reason,
      availability_detail: row.availability_detail,
      created_at: row.updated_at,
      updated_at: row.updated_at,
    }),
    updatedAt: row.updated_at as IsoTimestamp,
  };
}
