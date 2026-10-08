/** Safe runtime/Studio event projection; redact by allowlisted fields only. */
import type { JsonValue, TreeAIEvent } from "@treeai/contracts";
import { parseSerializedError } from "@treeai/event-journal";

export function payloadString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** 安全读取事件 payload 上的 ruleId 字段（string → 值；否则 → null，null 即默认拒绝）。 */
export function payloadRuleId(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)["ruleId"];
  return typeof value === "string" ? value : null;
}

/**
 * journal 事件的保守 summary：只从白名单字段构造（状态/角色/工具名/
 * 错误码等非敏感判别字段），绝不透出原始 payload（参数、路径、命令、
 * 消息正文、session 引用）。未知类型回退为类型字符串本身。
 */
export function summarizeJournalEvent(event: TreeAIEvent): string {
  const payload = event.payload;
  const str = (key: string): string | undefined => payloadString(payload, key);
  switch (event.type) {
    case "run.state-changed": {
      const from = str("from");
      const to = str("to");
      return from === undefined || to === undefined
        ? "run state change recorded"
        : `run state changed: ${from} → ${to}`;
    }
    case "run.abort-requested":
      return "abort requested";
    case "run.steer-enqueued":
      return "steer input enqueued";
    case "agent.started":
      return "agent run started";
    case "agent.settled":
      return `agent run settled${str("status") === undefined ? "" : ` (${str("status")})`}`;
    case "turn.started":
      return "turn started";
    case "turn.completed":
      return `turn completed${str("stopReason") === undefined ? "" : ` (stop: ${str("stopReason")})`}`;
    case "message.started":
      return `message started${str("role") === undefined ? "" : ` (${str("role")})`}`;
    case "message.updated": {
      const delta = str("delta");
      return delta === undefined ? "message update received" : `message delta received (${delta.length} chars)`;
    }
    case "message.completed": {
      const role = str("role");
      const stop = str("stopReason");
      const roleNote = role === undefined ? "" : ` (${role})`;
      const stopNote = stop === undefined ? "" : `, stop: ${stop}`;
      return `message completed${roleNote}${stopNote}`;
    }
    case "tool.execution.started":
      return `tool execution started: ${str("toolName") ?? "unknown tool"}`;
    case "tool.execution.finished": {
      const name = str("toolName") ?? "unknown tool";
      return `tool execution finished: ${name}${payload["isError"] === true ? " (error)" : ""}`;
    }
    case "tool.decision": {
      const tool = str("toolName");
      const decision = str("decision");
      const rawRule = payload["ruleId"];
      const ruleNote =
        typeof rawRule === "string"
          ? ` (rule: ${rawRule})`
          : rawRule === null
            ? " (no rule)"
            : "";
      const toolNote = tool === undefined ? "" : ` on ${tool}`;
      return `tool policy decision${toolNote}${decision === undefined ? "" : `: ${decision}`}${ruleNote}`;
    }
    case "session.created":
      return "session created";
    case "session.restored":
      return "session restored";
    case "session.replaced":
      return "session replaced";
    case "tree.navigated":
      return "session tree navigation";
    case "runtime.error": {
      // 复用投影器的序列化错误解析（code/message 已由上游脱敏；details 不进 summary）。
      const error = parseSerializedError(payload, "error");
      return error === null ? "runtime error" : `runtime error ${error.code}: ${error.message}`;
    }
    case "runtime.recovered": {
      const cause = str("cause");
      const resolved = str("resolvedTo");
      return `run recovered after ${cause ?? "host exit"}${resolved === undefined ? "" : ` (converged to ${resolved})`}`;
    }
    case "pi.unknown":
      return `unknown runtime event${str("rawKind") === undefined ? "" : ` (${str("rawKind")})`}`;
    default:
      return String(event.type);
  }
}

