/** Preserve pending Return context assembly semantics. */
import type { Turn } from "@treeai/contracts";

/** 把未送达的 return 拼进下一次 prompt 文本（送入 Pi 上下文的载体）。 */
export function composePromptText(pendingReturns: readonly Turn[], text: string): string {
  if (pendingReturns.length === 0) return text;
  const blocks = pendingReturns.map(
    (turn) => `[Return from branch ${turn.fromBranchId}]\n${turn.text}`,
  );
  return `${blocks.join("\n\n")}\n\n${text}`;
}

