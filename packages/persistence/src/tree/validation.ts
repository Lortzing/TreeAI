/** validation ownership for tree-repository.ts; compatibility entrypoint remains one level above. */
import {
  InvalidArgumentError,
} from "../errors.ts";
import type {
  AvailabilityColumns,
} from "./model.ts";
import {
  RUN_STATE_TRANSITIONS,
  TERMINAL_STATES,
  UNAVAILABLE_REASONS,
} from "./policy.ts";
import type {
  ReturnTargetAnchor,
  RunState,
  SessionAvailability,
  SessionReference,
} from "@treeai/contracts";

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isAllowedRunTransition(from: RunState, to: RunState): boolean {
  return (RUN_STATE_TRANSITIONS[from] as readonly RunState[]).includes(to);
}

/* ------------------------------------------------------------------ */
/* 校验辅助                                                             */
/* ------------------------------------------------------------------ */

export function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
}

/** 校验 Return 目标锚点快照形状（定位字段非空 + 选区整数偏移有序）。 */
export function assertValidTargetAnchor(anchor: ReturnTargetAnchor): void {
  assertNonEmptyString(anchor.sourceBranchId, "targetAnchor.sourceBranchId");
  assertNonEmptyString(anchor.anchorTurnId, "targetAnchor.anchorTurnId");
  assertNonEmptyString(anchor.anchorEntryId, "targetAnchor.anchorEntryId");
  const selection = anchor.selection;
  if (
    typeof selection !== "object" ||
    selection === null ||
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end) ||
    selection.start < 0 ||
    selection.end < selection.start ||
    typeof selection.text !== "string"
  ) {
    throw new InvalidArgumentError("targetAnchor.selection must be a TurnSelection {start, end, text}");
  }
}

/** 校验 SessionReference 形状（引用三元组 + 版本 + availability 一致性）。 */
export function assertValidSessionReference(reference: SessionReference, context: string): void {
  assertNonEmptyString(reference.sessionId, `${context}.sessionId`);
  assertNonEmptyString(reference.sessionFile, `${context}.sessionFile`);
  assertNonEmptyString(reference.entryId, `${context}.entryId`);
  assertNonEmptyString(reference.piVersion, `${context}.piVersion`);
  assertValidAvailability(reference.availability, `${context}.availability`);
}

export function assertValidAvailability(availability: SessionAvailability, context: string): void {
  if (availability.status === "available") {
    // available 变体在类型层不存在 reason 字段（contracts）；
    // 存储层一致性由 schema CHECK 保证。
    return;
  }
  if (typeof availability.reason !== "string" || !UNAVAILABLE_REASONS.includes(availability.reason)) {
    throw new InvalidArgumentError(
      `${context}: unavailable reference requires a reason in {${UNAVAILABLE_REASONS.join(", ")}}`,
    );
  }
}

export function availabilityToColumns(availability: SessionAvailability): AvailabilityColumns {
  assertValidAvailability(availability, "availability");
  if (availability.status === "available") {
    return { status: "available", reason: null, detail: null };
  }
  return {
    status: "unavailable",
    reason: availability.reason,
    detail: availability.detail ?? null,
  };
}
