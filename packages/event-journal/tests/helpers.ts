/**
 * 测试共享工具。
 *
 * 秘密纪律（DELIVERY-005 / 任务书"不得输出真实秘密到日志"）：
 * - 下述 SYNTH.* 全部是**合成**凭据（非真实），且在**运行时**拼接，
 *   测试源码中不出现完整秘密字面量，避免静态 secret scanner 误报；
 * - 断言失败消息只引用变量名，不内插秘密值；
 * - 家目录用虚构用户名（alice/bob/carol），不得使用真实用户名。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EventId,
  EvidenceReference,
  IsoTimestamp,
  JsonRecord,
  RunId,
  TreeAIEvent,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 标识与时间                                                          */
/* ------------------------------------------------------------------ */

export function runIdOf(label: string): RunId {
  return `run-${label}` as RunId;
}

export function evtIdOf(label: string): EventId {
  return `evt-${label}` as EventId;
}

export const T0 = "2026-09-21T10:00:00.000Z" as IsoTimestamp;
export const T1 = "2026-09-21T10:00:01.500Z" as IsoTimestamp;
export const T2 = "2026-09-21T10:00:03.000Z" as IsoTimestamp;

/* ------------------------------------------------------------------ */
/* 事件工厂                                                            */
/* ------------------------------------------------------------------ */

export interface MakeEventOverrides {
  eventId?: unknown;
  runId?: unknown;
  seq?: unknown;
  occurredAt?: unknown;
  type?: unknown;
  payload?: unknown;
  evidence?: unknown;
}

/** 构造事件（默认合法；overrides 可注入非法字段用于拒绝路径测试）。 */
export function makeEvent(overrides: MakeEventOverrides = {}): TreeAIEvent {
  return {
    eventId: "evt-default",
    runId: "run-default",
    seq: 1,
    occurredAt: T0,
    type: "message.started",
    payload: {},
    evidence: [],
    ...overrides,
  } as unknown as TreeAIEvent;
}

export function piEvidence(refId: string): EvidenceReference[] {
  return [{ source: "pi-runtime", refId }];
}

/* ------------------------------------------------------------------ */
/* 合成秘密（运行时拼接，非真实凭据）                                  */
/* ------------------------------------------------------------------ */

const join2 = (...parts: string[]): string => parts.join("");

export const SYNTH = {
  anthropicKey: join2("sk-", "ant-", "api03SYNTH", "0000000000000000000001"),
  openaiKey: join2("sk-", "proj-", "SYNTHopenai", "0000000000000000000"),
  genericKey: join2("sk-", "genericSYNTHkey", "0000000000"),
  githubToken: join2("gh", "p_", "SyntheticGitHub", "00000000"),
  googleKey: join2("AI", "za", "SyGoogle", "0000000000000000"),
  xaiKey: join2("xai-", "syntheticgrok", "0000000"),
  bearerValue: join2("Synthetic", "BearerValue", "0000000000"),
  cookieValue: join2("synthetic", "cookievalue", "0000000000"),
  urlPassword: join2("hunter", "2synthetic", "pass"),
  urlQueryValue: join2("synthetic", "urlkeyvalue", "000000"),
  envValue: join2("synthetic", "envsecret", "0000"),
  apiKeyHeaderValue: join2("synthetic", "xapikeyvalue", "000000"),
  homeAlice: join2("al", "ice"),
  homeBob: join2("bo", "b"),
  homeCarol: join2("car", "ol"),
} as const;

/** 断言一个序列化字符串不再包含任何合成秘密（失败消息不含秘密本身）。 */
export function assertNoSynthSecrets(contextLabel: string, serialized: string): void {
  const checks: readonly [string, string][] = [
    ["anthropicKey", SYNTH.anthropicKey],
    ["openaiKey", SYNTH.openaiKey],
    ["genericKey", SYNTH.genericKey],
    ["githubToken", SYNTH.githubToken],
    ["googleKey", SYNTH.googleKey],
    ["xaiKey", SYNTH.xaiKey],
    ["bearerValue", SYNTH.bearerValue],
    ["cookieValue", SYNTH.cookieValue],
    ["urlPassword", SYNTH.urlPassword],
    ["urlQueryValue", SYNTH.urlQueryValue],
    ["envValue", SYNTH.envValue],
    ["apiKeyHeaderValue", SYNTH.apiKeyHeaderValue],
    ["homeAlice", SYNTH.homeAlice],
    ["homeBob", SYNTH.homeBob],
    ["homeCarol", SYNTH.homeCarol],
  ];
  for (const [name, value] of checks) {
    if (serialized.includes(value)) {
      throw new Error(
        `${contextLabel}: synthetic secret "${name}" leaked into output (redaction failure)`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 临时目录                                                            */
/* ------------------------------------------------------------------ */

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "treeai-event-journal-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** JSON record 快捷构造（测试字面量）。 */
export function rec(entries: Record<string, unknown>): JsonRecord {
  return entries as JsonRecord;
}
