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
  Episode,
  EpisodeId,
  Forest,
  ForestId,
  IsoTimestamp,
  JsonRecord,
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
