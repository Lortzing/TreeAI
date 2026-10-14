import type { PiPortSession, PiPortSessionManager } from "./pi-sdk-port.ts";

/** 会话消息表里最后一条 assistant 消息（失败判定的权威位置）。 */
export function lastAssistantMessage(session: PiPortSession): { stopReason?: string; errorMessage?: string } | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== null && typeof message === "object" && message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/**
 * 沿当前分支（叶→根）找最近的 model_change 条目，
 * 返回其 provider/modelId（restore 的模型固定来源）。
 */
export function findStoredModelOnBranch(
  manager: PiPortSessionManager,
): { provider: string; modelId: string } | undefined {
  let cursor = manager.getLeafId();
  let steps = 0;
  while (cursor !== null) {
    steps += 1;
    if (steps > 100_000) {
      return undefined; // 防御：异常环形结构不至于死循环。
    }
    const entry = manager.getEntry(cursor);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
    cursor = entry.parentId;
  }
  return undefined;
}
