/**
 * 测试辅助：临时目录、可注入时钟、SessionReference/失败工厂。
 * 全部测试仅使用系统临时目录与内存库，不触碰真实 Pi 配置或 session 目录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IsoTimestamp,
  PiEntryId,
  PiSessionId,
  PiVersion,
  RunId,
  SessionReference,
  TreeAIError,
} from "@treeai/contracts";

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-persistence-"));
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function dbPath(dir: string, name = "treeai.db"): string {
  return join(dir, name);
}

/**
 * 固定时钟：从 2026-09-21T00:00:00.000Z 起，每次调用前进 1ms。
 * 保证 created_at 严格递增（测试断言排序稳定）。
 */
export function makeClock(startMs = Date.UTC(2026, 8, 21)): () => IsoTimestamp {
  let t = startMs;
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

/** 顺序 id 生成器（确定性、可断言）。 */
export function makeIdGenerator(prefix = "test"): () => string {
  let n = 0;
  return () => `${prefix}-${(++n).toString().padStart(4, "0")}`;
}

/**
 * 构造 SessionReference（引用三元组 + 版本 + available）。
 * sessionFile 只是字符串引用，持久化层从不读取该文件。
 */
export function makeSessionReference(input?: {
  sessionId?: string;
  sessionFile?: string;
  entryId?: string;
  piVersion?: string;
}): SessionReference {
  return {
    sessionId: (input?.sessionId ?? "pi-session-0001") as PiSessionId,
    sessionFile: input?.sessionFile ?? "session-store/session-0001.jsonl",
    entryId: (input?.entryId ?? "entry-0001") as PiEntryId,
    piVersion: (input?.piVersion ?? "0.85.1") as PiVersion,
    availability: { status: "available" },
  };
}

/** I6 宿主崩溃语义的失败（contracts run-state.ts I6 建议）。 */
export function hostInterruptedFailure(): TreeAIError {
  return {
    code: "unknown",
    message: "host process interrupted before run reached a terminal state",
    details: { hostInterrupted: true },
  };
}

/** 模型/上游类失败。 */
export function modelFailure(): TreeAIError {
  return {
    code: "upstream",
    message: "model request failed",
    details: { provider: "test-provider", model: "test-model" },
  };
}

export function asRunId(id: string): RunId {
  return id as RunId;
}
