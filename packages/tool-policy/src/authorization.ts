/**
 * 授权存储：写入与其他高风险操作的逐次/限时授权。
 *
 * 边界（任务书 §5 Agent D / DECISION-005）：
 * - 写入必须位于批准 workspace，且需要逐次授权或有明确 expiry 的
 *   限时授权。本实现的规则：**每笔授权都必须带显式有效期**
 *   （expiresInMs > 0）；`singleUse: true`（默认）为逐次授权——
 *   产生一次 allow 即被消费，不可复用；`singleUse: false` 为限时
 *   多次授权，同样必须有 expiry。不存在无期限授权。
 * - 授权匹配要求四要素全部一致：目标 action（类别）、规范化目标
 *   路径（严格字符串相等——不可复用到其他目标）、目标位于 workspace
 *   范围内（签发时校验并固化）、未过期且（单次授权）未消费。
 * - 仅 write 与 other-high-risk 可授权。read 由 readRoots 配置决定
 *   （无需逐次授权）；shell/network 属负责人级显式配置
 *   （allowShell/allowNetwork），不通过逐次授权开口子。
 *
 * 本接口是宿主侧编程接口（实现审批 UI 是宿主的职责，不在本模块）。
 * 误用（类别不支持、目标越界、缺失有效期）属编程错误，抛 TypeError。
 */
import { randomUUID } from "node:crypto";
import type { ToolActionCategory } from "@treeai/contracts";
import type { ToolPolicyAuditLog } from "./audit.js";
import { canonicalizePath, isPathWithin } from "./paths.js";

/** 可授权的动作类别。 */
export const GRANTABLE_CATEGORIES: readonly ToolActionCategory[] = ["write", "other-high-risk"];

/** 授权签发请求（宿主在审批通过后调用）。 */
export interface ToolAuthorizationRequest {
  readonly category: ToolActionCategory;
  /** 目标路径（绝对或相对；相对按引擎 cwd 解析；签发时规范化）。 */
  readonly targetPath: string;
  /** 有效期（毫秒）。必须 > 0；每笔授权都有显式 expiry。 */
  readonly expiresInMs: number;
  /** 逐次授权（默认 true）：产生一次 allow 即消费。false 为限时多次。 */
  readonly singleUse?: boolean;
  /** 审批主体标签（诊断用；请使用结构化标识，不要放秘密）。 */
  readonly grantedBy?: string;
}

/** 一笔授权。 */
export interface ToolAuthorizationGrant {
  readonly grantId: string;
  readonly category: ToolActionCategory;
  /** 规范化目标路径（签发时固化；匹配用严格相等）。 */
  readonly targetPath: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly singleUse: boolean;
  readonly grantedBy: string | null;
  /** 单次授权是否已被消费。 */
  readonly consumed: boolean;
}

/** 授权存储。由 ToolPolicyEngine 构造并持有；宿主经 engine.authorizations 访问。 */
export class AuthorizationStore {
  readonly #workspaceRoots: readonly string[];
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #audit: ToolPolicyAuditLog;
  readonly #grants = new Map<string, ToolAuthorizationGrant>();

  constructor(options: {
    readonly workspaceRoots: readonly string[];
    readonly cwd: string;
    readonly now: () => number;
    readonly audit: ToolPolicyAuditLog;
  }) {
    this.#workspaceRoots = options.workspaceRoots;
    this.#cwd = options.cwd;
    this.#now = options.now;
    this.#audit = options.audit;
  }

  /**
   * 签发一笔授权。校验并固化：
   * 类别可授权、目标可规范化且位于 workspace 内、有效期显式且 > 0。
   * 返回的授权不可变；singleUse 授权被消费后以 consumed=true 的新快照替换。
   */
  issue(request: ToolAuthorizationRequest): ToolAuthorizationGrant {
    if (request === null || typeof request !== "object") {
      throw new TypeError("ToolAuthorizationRequest must be an object");
    }
    if (!GRANTABLE_CATEGORIES.includes(request.category)) {
      throw new TypeError(
        `authorization supports only write and other-high-risk categories (got ${String(request.category)}); ` +
          `shell/network require owner-configured policy and reads are governed by readRoots`,
      );
    }
    if (typeof request.targetPath !== "string" || request.targetPath.trim().length === 0) {
      throw new TypeError("ToolAuthorizationRequest.targetPath must be a non-empty string");
    }
    if (typeof request.expiresInMs !== "number" || !Number.isFinite(request.expiresInMs) || request.expiresInMs <= 0) {
      throw new TypeError(
        "ToolAuthorizationRequest.expiresInMs must be a finite number > 0; every grant carries an explicit expiry",
      );
    }
    const singleUse = request.singleUse ?? true;
    if (typeof singleUse !== "boolean") {
      throw new TypeError("ToolAuthorizationRequest.singleUse must be a boolean when provided");
    }
    const canonical = canonicalizePath(request.targetPath, this.#cwd);
    if (canonical === null) {
      throw new TypeError(
        "ToolAuthorizationRequest.targetPath could not be canonicalized; refusing to issue an unverifiable grant",
      );
    }
    const inWorkspace = this.#workspaceRoots.some((root) => isPathWithin(canonical, root));
    if (!inWorkspace) {
      throw new TypeError(
        "ToolAuthorizationRequest.targetPath resolves outside every approved workspace root; refusing to issue grant",
      );
    }

    const now = this.#now();
    const grant: ToolAuthorizationGrant = Object.freeze({
      grantId: `grant-${randomUUID()}`,
      category: request.category,
      targetPath: canonical,
      issuedAt: now,
      expiresAt: now + request.expiresInMs,
      singleUse,
      grantedBy: typeof request.grantedBy === "string" && request.grantedBy.length > 0 ? request.grantedBy : null,
      consumed: false,
    });
    this.#grants.set(grant.grantId, grant);
    this.#audit.append({
      kind: "grant-issued",
      category: grant.category,
      targetPath: grant.targetPath,
      grantId: grant.grantId,
      reason: "authorization issued",
    });
    return grant;
  }

  /**
   * 查找匹配授权：类别相等 + canonical 目标路径严格相等 + 未过期 +
   * （单次授权）未消费。有效期语义：now < expiresAt 时有效，
   * 到达 expiresAt 即失效。
   */
  findMatchingGrant(category: ToolActionCategory, canonicalTargetPath: string): ToolAuthorizationGrant | null {
    const now = this.#now();
    for (const grant of this.#grants.values()) {
      if (grant.category !== category) continue;
      if (grant.targetPath !== canonicalTargetPath) continue;
      if (now >= grant.expiresAt) continue;
      if (grant.singleUse && grant.consumed) continue;
      return grant;
    }
    return null;
  }

  /** 消费单次授权（引擎在授权产生 allow 后调用）。幂等。 */
  consume(grantId: string): void {
    const grant = this.#grants.get(grantId);
    if (grant === undefined || grant.consumed || !grant.singleUse) return;
    const consumed: ToolAuthorizationGrant = Object.freeze({ ...grant, consumed: true });
    this.#grants.set(grantId, consumed);
    this.#audit.append({
      kind: "grant-consumed",
      category: grant.category,
      targetPath: grant.targetPath,
      grantId: grant.grantId,
      reason: "single-use authorization consumed by an allowed decision",
    });
  }

  /** 撤销授权（宿主随时可调用）。返回是否存在该授权。 */
  revoke(grantId: string): boolean {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) return false;
    this.#grants.delete(grantId);
    this.#audit.append({
      kind: "grant-revoked",
      category: grant.category,
      targetPath: grant.targetPath,
      grantId: grant.grantId,
      reason: "authorization revoked",
    });
    return true;
  }

  /** 清理已过期授权；返回清理数量。 */
  purgeExpired(): number {
    const now = this.#now();
    let purged = 0;
    for (const grant of this.#grants.values()) {
      if (now >= grant.expiresAt) {
        this.#grants.delete(grant.grantId);
        purged += 1;
        this.#audit.append({
          kind: "grant-purged",
          category: grant.category,
          targetPath: grant.targetPath,
          grantId: grant.grantId,
          reason: "expired authorization purged",
        });
      }
    }
    return purged;
  }

  /** 当前仍有效（未过期、未消费）的授权快照。 */
  listActive(): readonly ToolAuthorizationGrant[] {
    const now = this.#now();
    const active: ToolAuthorizationGrant[] = [];
    for (const grant of this.#grants.values()) {
      if (now < grant.expiresAt && !(grant.singleUse && grant.consumed)) active.push(grant);
    }
    return active;
  }
}
