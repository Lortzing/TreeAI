/**
 * Pi 事件 → PiRuntimeEvent 载荷归一化。
 *
 * 契约（packages/contracts/src/events.ts）：
 * - seq 由 PiRuntime 实例统一分配（生命周期内严格递增，跨会话替换连续），
 *   本模块只负责 kind + payload。
 * - payload 必须已脱敏：这里采取白名单字段策略——只提取非敏感的
 *   判别字段（role/stopReason/toolName/queue 计数等），绝不搬运
 *   消息正文、工具参数/结果、命令输出、文件内容。
 * - 未知 Pi 事件保留原始 type 字符串作为 kind（开放联合），
 *   payload 携带 rawKind 以便 journal 侧映射为 pi.unknown。
 * - agent_end 不做已知映射（内部簿记；收敛权威信号是 agent_settled，
 *   见 README 已知限制）。queue_update 等高频/内部事件保留原始 kind。
 */

import type { JsonRecord, JsonValue } from "@treeai/contracts";
import type { PiEventLike } from "./pi-sdk-port.ts";

/** 构造期使用的可变载荷（JsonRecord 的可写形态，返回时向上转型）。 */
type MutablePayload = { [key: string]: JsonValue };

/**
 * 归一化结果：null 表示有意丢弃（agent_end），否则 {kind, payload}。
 */
export interface NormalizedPiEvent {
  readonly kind: string;
  readonly payload: JsonRecord;
}

/** 安全读取事件上的字符串字段（缺失/非字符串 → undefined）。 */
function str(source: PiEventLike, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** 安全读取数字字段。 */
function num(source: PiEventLike, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 安全读取布尔字段。 */
function bool(source: PiEventLike, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/** 从 message_update 的 assistantMessageEvent 提取文本增量。 */
function textDelta(event: PiEventLike): string | undefined {
  const inner = event.assistantMessageEvent;
  if (inner === null || typeof inner !== "object") {
    return undefined;
  }
  const candidate = inner as Record<string, unknown>;
  if (candidate.type === "text_delta" && typeof candidate.delta === "string") {
    return candidate.delta;
  }
  return undefined;
}

/** 从消息形态事件（message_start/end）提取 role。 */
function messageRole(event: PiEventLike): string | undefined {
  const message = event.message;
  if (message === null || typeof message !== "object") {
    return undefined;
  }
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
}

/** 从消息形态事件提取 stopReason / errorMessage 存在性（不含正文）。 */
function assistantOutcome(event: PiEventLike): MutablePayload {
  const message = event.message;
  if (message === null || typeof message !== "object") {
    return {};
  }
  const record = message as Record<string, unknown>;
  const payload: MutablePayload = {};
  const stopReason = record.stopReason;
  if (typeof stopReason === "string") {
    payload.stopReason = stopReason;
  }
  if (typeof record.errorMessage === "string" && record.errorMessage.length > 0) {
    // 只报告存在性与失败标记，不搬运错误正文（可能含上游响应细节）。
    payload.hasError = true;
  }
  return payload;
}

/**
 * 归一化单个 Pi 会话事件。
 * 已知事件族映射到冻结的已知 kind；未列举的保留原始 type。
 */
export function normalizePiEvent(event: PiEventLike): NormalizedPiEvent | null {
  switch (event.type) {
    case "agent_start":
      return { kind: "agent.started", payload: {} };
    case "agent_settled":
      return { kind: "agent.settled", payload: {} };
    case "agent_end":
      // 内部簿记（含重试衔接）；收敛权威信号是 agent_settled。有意丢弃。
      return null;
    case "turn_start":
      return { kind: "turn.started", payload: {} };
    case "turn_end": {
      const payload: MutablePayload = {};
      const stopReason = assistantOutcome(event).stopReason;
      if (stopReason !== undefined) {
        payload.stopReason = stopReason;
      }
      return { kind: "turn.completed", payload };
    }
    case "message_start": {
      const role = messageRole(event);
      return { kind: "message.started", payload: role === undefined ? {} : { role } };
    }
    case "message_update": {
      const delta = textDelta(event);
      return {
        kind: "message.updated",
        payload: delta === undefined ? {} : { delta },
      };
    }
    case "message_end": {
      const payload: MutablePayload = assistantOutcome(event);
      const role = messageRole(event);
      if (role !== undefined) {
        payload.role = role;
      }
      return { kind: "message.completed", payload };
    }
    case "tool_execution_start": {
      const toolName = str(event, "toolName");
      return {
        kind: "tool.execution.started",
        payload: toolName === undefined ? {} : { toolName },
      };
    }
    case "tool_execution_end": {
      const toolName = str(event, "toolName");
      const payload: MutablePayload = toolName === undefined ? {} : { toolName };
      const isError = bool(event, "isError");
      if (isError !== undefined) {
        payload.isError = isError;
      }
      return { kind: "tool.execution.finished", payload };
    }
    case "queue_update": {
      const payload: MutablePayload = {};
      const steering = num(event, "steering");
      const followUp = num(event, "followUp");
      if (steering !== undefined) payload.steering = steering;
      if (followUp !== undefined) payload.followUp = followUp;
      return { kind: "queue_update", payload };
    }
    case "entry_appended": {
      const entry = event.entry;
      let payload: MutablePayload = {};
      if (entry !== null && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : undefined;
        const id = typeof record.id === "string" ? record.id : undefined;
        payload = {
          ...(type === undefined ? {} : { entryType: type }),
          ...(id === undefined ? {} : { entryId: id }),
        };
      }
      return { kind: "entry_appended", payload };
    }
    case "session_info_changed": {
      const name = str(event, "name");
      return { kind: "session_info_changed", payload: { nameSet: name !== undefined } };
    }
    case "bash_execution_update":
      // 命令输出可能包含文件内容，不搬运正文。
      return { kind: "bash_execution_update", payload: {} };
    default: {
      // 未知事件：保留原始 kind + rawKind 载荷标记。
      return { kind: event.type, payload: { rawKind: event.type } };
    }
  }
}
