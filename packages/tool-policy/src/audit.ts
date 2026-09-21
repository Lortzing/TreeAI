/**
 * 追加式脱敏审计记录。
 *
 * 纪律：审计记录不得包含文件正文、token、cookie、Authorization 或任何
 * 秘密。实现方式是结构性排除而非事后过滤：
 * - 只记录决策摘要（outcome/category/risk/ruleId/reason/scopeRoots）、
 *   canonical 目标路径（结构化定位所需）、授权 id 与存在性标志；
 * - shell 命令与网络主机只记录「是否存在」（hasCommand/hasHost），
 *   原值绝不进入记录——命令行与 URL 是常见凭据携带处；
 * - other-high-risk 的 action 标签仅当匹配安全字符模式时记录，否则 null；
 * - reason 为固定模板（decisions.ts），不含用户可控内容；
 * - 引擎从不读取目标文件内容，因此正文无从进入记录。
 *
 * 追加式：记录一经写入不可修改或删除（对齐 contracts events.ts 的
 * 审计纪律）。容量上限到达后丢弃最旧记录并累计 droppedCount——
 * 这是显式声明的截断，不是静默改写。
 */
import type { ToolActionCategory, ToolDecisionOutcome, ToolRiskLevel } from "@treeai/contracts";

export type ToolPolicyAuditKind =
  | "decision"
  | "grant-issued"
  | "grant-revoked"
  | "grant-consumed"
  | "grant-purged";

/** 单条脱敏审计记录。 */
export interface ToolPolicyAuditRecord {
  /** 评估/授权事件时间（UTC ISO 8601，来自引擎时钟）。 */
  readonly at: string;
  readonly kind: ToolPolicyAuditKind;
  readonly category: ToolActionCategory | null;
  readonly outcome: ToolDecisionOutcome | null;
  readonly risk: ToolRiskLevel | null;
  readonly ruleId: string | null;
  readonly reason: string;
  readonly scopeRoots: readonly string[];
  /** canonical 目标路径（结构化定位；路径本身不视为秘密，但建议
   *  event-journal 在持久化 payload 时按其统一脱敏规则处理）。 */
  readonly targetPath: string | null;
  readonly grantId: string | null;
  /** 请求是否携带 shell 命令（仅存在性，不含原值）。 */
  readonly hasCommand: boolean;
  /** 请求是否携带网络主机（仅存在性，不含原值）。 */
  readonly hasHost: boolean;
  /** other-high-risk 的 action 标签（仅安全字符模式；否则 null）。 */
  readonly actionLabel: string | null;
}

/** 追加式审计日志（内存实现；持久化由 event-journal 承担）。 */
export class ToolPolicyAuditLog {
  readonly #records: ToolPolicyAuditRecord[] = [];
  readonly #maxRecords: number;
  readonly #now: () => number;
  #dropped = 0;

  constructor(options?: { readonly maxRecords?: number; readonly now?: () => number }) {
    this.#maxRecords = options?.maxRecords ?? 10_000;
    this.#now = options?.now ?? Date.now;
  }

  /** 追加一条记录（内部 API：由引擎与授权存储调用）。 */
  append(input: {
    readonly kind: ToolPolicyAuditKind;
    readonly category?: ToolActionCategory | null;
    readonly outcome?: ToolDecisionOutcome | null;
    readonly risk?: ToolRiskLevel | null;
    readonly ruleId?: string | null;
    readonly reason?: string;
    readonly scopeRoots?: readonly string[];
    readonly targetPath?: string | null;
    readonly grantId?: string | null;
    readonly hasCommand?: boolean;
    readonly hasHost?: boolean;
    readonly actionLabel?: string | null;
  }): void {
    const record: ToolPolicyAuditRecord = Object.freeze({
      at: new Date(this.#now()).toISOString(),
      kind: input.kind,
      category: input.category ?? null,
      outcome: input.outcome ?? null,
      risk: input.risk ?? null,
      ruleId: input.ruleId ?? null,
      reason: input.reason ?? "",
      scopeRoots: Object.freeze([...(input.scopeRoots ?? [])]),
      targetPath: input.targetPath ?? null,
      grantId: input.grantId ?? null,
      hasCommand: input.hasCommand ?? false,
      hasHost: input.hasHost ?? false,
      actionLabel: input.actionLabel ?? null,
    });
    this.#records.push(record);
    if (this.#records.length > this.#maxRecords) {
      this.#records.shift();
      this.#dropped += 1;
    }
  }

  /** 当前记录快照（只读副本；内部数组不外泄，保证追加式纪律）。 */
  get records(): readonly ToolPolicyAuditRecord[] {
    return Object.freeze([...this.#records]);
  }

  /** 因容量上限被丢弃的最旧记录数（显式截断计数）。 */
  get droppedCount(): number {
    return this.#dropped;
  }

  /** 序列化整个日志（用于泄漏断言与诊断导出）。 */
  toJSON(): string {
    return JSON.stringify({ droppedCount: this.#dropped, records: this.#records });
  }
}

/** 安全 action 标签模式：字母数字开头，仅 [A-Za-z0-9._-]，长度 1–40。 */
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** 提取安全 action 标签；不匹配安全模式（或缺失）返回 null。 */
export function safeActionLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SAFE_LABEL_PATTERN.test(value) ? value : null;
}
