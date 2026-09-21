/**
 * 契约编译期类型测试（正向断言）。
 *
 * 运行方式：`tsc --noEmit -p tsconfig.json`（tests 在 include 内）。
 * 任何断言失效都会使编译失败。
 * 反例（必须编译失败）在 tests/negatives/ 下由脚本单独验证。
 */
import type { Equal, Expect, NotEqual } from "./type-test-utils.js";
import type {
  AllowedRunStateTransition,
  BranchId,
  EpisodeId,
  EventId,
  ForestId,
  IsoTimestamp,
  KnownTreeAIEventType,
  NonTerminalRunState,
  PiEntryId,
  PiPromptResult,
  PiRuntime,
  PiRuntimeEvent,
  PiRuntimeEventKind,
  PiSessionId,
  PiSessionInit,
  PiSessionSnapshot,
  PiSteerInput,
  PiUnsubscribe,
  PiVersion,
  PinnedPiVersion,
  Run,
  RunId,
  RunState,
  RunStateTransitions,
  SessionAvailability,
  SessionReference,
  TerminalRunState,
  TreeAIError,
  TreeAIErrorCode,
  TreeAIEvent,
  TreeAIEventType,
  TreeId,
  ToolActionCategory,
  ToolDecision,
  ToolDecisionOutcome,
  ToolDecisionScope,
  ToolRiskLevel,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* 1. RunState 状态机（run-state.ts 不变量 I1–I7 的类型面）            */
/* ------------------------------------------------------------------ */

type _t_run_state_members = Expect<
  Equal<
    RunState,
    "queued" | "running" | "aborting" | "succeeded" | "failed" | "aborted"
  >
>;

type _t_terminal_members = Expect<
  Equal<TerminalRunState, "succeeded" | "failed" | "aborted">
>;
type _t_non_terminal_members = Expect<
  Equal<NonTerminalRunState, "queued" | "running" | "aborting">
>;

/* 合法迁移 */
type _t_ok_queued_running = Expect<
  Equal<AllowedRunStateTransition<"queued", "running">, true>
>;
type _t_ok_queued_failed = Expect<
  Equal<AllowedRunStateTransition<"queued", "failed">, true>
>;
type _t_ok_running_aborting = Expect<
  Equal<AllowedRunStateTransition<"running", "aborting">, true>
>;
type _t_ok_running_succeeded = Expect<
  Equal<AllowedRunStateTransition<"running", "succeeded">, true>
>;
type _t_ok_running_failed = Expect<
  Equal<AllowedRunStateTransition<"running", "failed">, true>
>;
type _t_ok_aborting_aborted = Expect<
  Equal<AllowedRunStateTransition<"aborting", "aborted">, true>
>;
type _t_ok_aborting_failed = Expect<
  Equal<AllowedRunStateTransition<"aborting", "failed">, true>
>;

/* 非法迁移（I2 终态吸收 / I5 无回退 / I7 表外迁移） */
type _t_no_succeeded_running = Expect<
  Equal<AllowedRunStateTransition<"succeeded", "running">, false>
>;
type _t_no_failed_running = Expect<
  Equal<AllowedRunStateTransition<"failed", "running">, false>
>;
type _t_no_aborted_anything = Expect<
  Equal<AllowedRunStateTransition<"aborted", "queued">, false>
>;
type _t_no_queued_succeeded = Expect<
  Equal<AllowedRunStateTransition<"queued", "succeeded">, false>
>;
type _t_no_running_queued = Expect<
  Equal<AllowedRunStateTransition<"running", "queued">, false>
>;
type _t_no_aborting_running = Expect<
  Equal<AllowedRunStateTransition<"aborting", "running">, false>
>;
type _t_no_queued_aborted = Expect<
  Equal<AllowedRunStateTransition<"queued", "aborted">, false>
>;

/* 终态目标集为空（吸收性的"数据"编码） */
type _t_absorbing_succeeded = Expect<
  Equal<RunStateTransitions["succeeded"][number], never>
>;
type _t_absorbing_failed = Expect<
  Equal<RunStateTransitions["failed"][number], never>
>;
type _t_absorbing_aborted = Expect<
  Equal<RunStateTransitions["aborted"][number], never>
>;

/* ------------------------------------------------------------------ */
/* 2. 领域标识品牌（identifiers.ts）                                    */
/* ------------------------------------------------------------------ */

type _t_ids_distinct = Expect<NotEqual<RunId, BranchId>>;
type _t_tree_episode_distinct = Expect<NotEqual<TreeId, EpisodeId>>;
type _t_forest_tree_distinct = Expect<NotEqual<ForestId, TreeId>>;
type _t_event_not_plain_string = Expect<NotEqual<EventId, string>>;
type _t_run_not_plain_string = Expect<NotEqual<RunId, string>>;

/* 底层仍是 string：合法构造只能经显式断言（品牌无运行时成本） */
declare const rawId: string;
const _t_branded_from_string: RunId = rawId as RunId;

/* ------------------------------------------------------------------ */
/* 3. SessionReference（session-reference.ts）                          */
/* ------------------------------------------------------------------ */

type _t_pinned_pi_version = Expect<Equal<PinnedPiVersion, "0.85.1">>;
type _t_pi_ids_distinct = Expect<NotEqual<PiSessionId, PiEntryId>>;

declare const reference: SessionReference;
const _t_ref_file: string = reference.sessionFile;
const _t_ref_session: PiSessionId = reference.sessionId;
const _t_ref_entry: PiEntryId = reference.entryId;
const _t_ref_version: PiVersion = reference.piVersion;

/* availability 判别联合：unavailable 必带 reason */
declare const unavailable: SessionAvailability & { status: "unavailable" };
const _t_unavailable_reason: string = unavailable.reason;

/* ------------------------------------------------------------------ */
/* 4. TreeAIError（errors.ts：8 类封闭枚举）                            */
/* ------------------------------------------------------------------ */

type _t_error_codes = Expect<
  Equal<
    TreeAIErrorCode,
    | "auth"
    | "model-unavailable"
    | "user-abort"
    | "timeout"
    | "policy-denied"
    | "upstream"
    | "session-corrupt"
    | "unknown"
  >
>;

declare const error: TreeAIError;
const _t_error_code: TreeAIErrorCode = error.code;
const _t_error_message: string = error.message;

/* ------------------------------------------------------------------ */
/* 5. TreeAIEvent / PiRuntimeEvent（events.ts）                         */
/* ------------------------------------------------------------------ */

declare const event: TreeAIEvent;
const _t_event_id: EventId = event.eventId;
const _t_event_run: RunId = event.runId;
const _t_event_seq: number = event.seq;
const _t_event_time: IsoTimestamp = event.occurredAt;
const _t_event_type: TreeAIEventType = event.type;
const _t_event_payload: TreeAIEvent["payload"] = { redacted: true };
const _t_event_evidence: readonly TreeAIEvent["evidence"][number][] =
  event.evidence;

/* 事件类型开放联合：已知类型 + 任意未来字符串（前向兼容，不丢事件） */
const _t_known_type: TreeAIEventType = "run.state-changed";
const _t_future_type: TreeAIEventType = "some.future.pi.event.kind";
const _t_runtime_kind_accepts_future: PiRuntimeEventKind =
  "any.future.runtime.kind";

declare const runtimeEvent: PiRuntimeEvent;
const _t_runtime_event_id: EventId = runtimeEvent.eventId;
const _t_runtime_event_kind: PiRuntimeEventKind = runtimeEvent.kind;

/* ------------------------------------------------------------------ */
/* 6. ToolDecision（tool-decision.ts）                                  */
/* ------------------------------------------------------------------ */

type _t_outcomes = Expect<
  Equal<ToolDecisionOutcome, "allow" | "deny" | "require-approval">
>;
type _t_categories = Expect<
  Equal<
    ToolActionCategory,
    "read" | "write" | "shell" | "network" | "other-high-risk"
  >
>;
type _t_risk = Expect<Equal<ToolRiskLevel, "low" | "medium" | "high">>;

declare const decision: ToolDecision;
const _t_decision_outcome: ToolDecisionOutcome = decision.outcome;
const _t_decision_rule: string | null = decision.ruleId;
const _t_decision_scope: ToolDecisionScope = decision.scope;
const _t_decision_scope_roots: readonly string[] = decision.scope.roots;

/* ------------------------------------------------------------------ */
/* 7. PiRuntime（pi-runtime.ts：方法面完整性与签名形状）                */
/* ------------------------------------------------------------------ */

declare const runtime: PiRuntime;

/* 八个冻结能力全部在接口上 */
type _t_has_create = PiRuntime["createSession"] extends (
  init: PiSessionInit,
) => Promise<PiSessionSnapshot>
  ? true
  : false;
type _t_create_ok = Expect<_t_has_create>;
type _t_has_restore = PiRuntime["restoreSession"] extends (
  reference: SessionReference,
) => Promise<PiSessionSnapshot>
  ? true
  : false;
type _t_restore_ok = Expect<_t_has_restore>;
type _t_has_prompt = PiRuntime["prompt"] extends (
  input: { readonly text: string },
) => Promise<PiPromptResult>
  ? true
  : false;
type _t_prompt_ok = Expect<_t_has_prompt>;
type _t_has_steer = PiRuntime["steer"] extends (
  input: PiSteerInput,
) => Promise<void>
  ? true
  : false;
type _t_steer_ok = Expect<_t_has_steer>;
type _t_has_abort = PiRuntime["abort"] extends () => Promise<void>
  ? true
  : false;
type _t_abort_ok = Expect<_t_has_abort>;
type _t_has_navigate = PiRuntime["navigateTree"] extends (
  target: { readonly entryId: PiEntryId },
) => Promise<SessionReference>
  ? true
  : false;
type _t_navigate_ok = Expect<_t_has_navigate>;
type _t_has_subscribe = PiRuntime["subscribe"] extends (
  listener: (event: PiRuntimeEvent) => void,
) => PiUnsubscribe
  ? true
  : false;
type _t_subscribe_ok = Expect<_t_has_subscribe>;
type _t_has_dispose = PiRuntime["dispose"] extends () => Promise<void>
  ? true
  : false;
type _t_dispose_ok = Expect<_t_has_dispose>;

const _t_runtime_version: PiVersion = runtime.piVersion;
const _t_unsubscribe: PiUnsubscribe = runtime.subscribe(() => {});

/* ------------------------------------------------------------------ */
/* 8. Run 实体（identifiers.ts：关系字段与 failure 语义）               */
/* ------------------------------------------------------------------ */

declare const run: Run;
const _t_run_episode: EpisodeId = run.episodeId;
const _t_run_state: RunState = run.state;
const _t_run_session: SessionReference = run.session;
const _t_run_terminal: IsoTimestamp | null = run.terminalAt;
const _t_run_failure: TreeAIError | undefined = run.failure;

/* 已知事件类型联合包含树导航与工具策略（D2 关键审计事件） */
type _t_known_includes_navigation = Expect<
  Equal<Extract<KnownTreeAIEventType, "tree.navigated">, "tree.navigated">
>;
type _t_known_includes_tool_decision = Expect<
  Equal<Extract<KnownTreeAIEventType, "tool.decision">, "tool.decision">
>;
