/** context ownership for branching.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialContextBlockRange,
  MaterialContextView,
} from "./model.ts";
import {
  MATERIAL_CONTEXT_LIMIT_UNITS,
  MATERIAL_CONTEXT_RESERVE_UNITS,
  MATERIAL_CONTEXT_TITLE_UNITS,
} from "./policy.ts";
import type {
  Material,
  MaterialBlock,
  MaterialBranchOrigin,
  MaterialSelection,
  MaterialVersion,
} from "@treeai/contracts";

/**
 * 首问用户 turn 的显式标记前缀（可审计、不冒充历史——对齐
 * NEW_EXPLORATION_TURN_PREFIX / TERMINOLOGY_PROMOTION_TURN_PREFIX 模式）。
 * ADR-003 §4 的示意是 `[exploration from material <标题> v<版本>]`；ADR-004
 * 决策三把它细化为**只含 versionId**：材料标题是可编辑显示名（不是身份，
 * charter §3.1），把它写进 turn 前缀会让「同键异问」的对账基准随改名漂移
 * ——versionId 不可变，前缀因此稳定。
 */
export function materialExplorationTurnPrefix(origin: MaterialBranchOrigin): string {
  return `[exploration from material ${origin.selection.versionId}]`;
}

export function truncateTitle(title: string): string {
  if (title.length <= MATERIAL_CONTEXT_TITLE_UNITS) return title;
  return `${title.slice(0, MATERIAL_CONTEXT_TITLE_UNITS)}…`;
}

/**
 * 组合材料上下文（charter §3.3 规则二：「将选区、必要邻近段落、材料标题/
 * 版本和用户问题作为真实输入」）。确定性算法：
 * 1. 标题/版本头（标题截断到 MATERIAL_CONTEXT_TITLE_UNITS 并以 … 标记）；
 * 2. 选区摘录（完整引用——锚定事实，绝不截断用户的选区）；
 * 3. 有界邻近块窗口：从选区所在块开始，向两侧按整块交替扩展，直到预算
 *    用尽或覆盖整份材料；所在块自身超预算时改为选区两侧对称切片；
 * 4. 截断标记：窗口未覆盖整份材料（windowStart > 0 或 windowEnd <
 *    canonicalText.length）时，在组合文本内显式标注省略量与上限。
 */
export function composeMaterialContext(input: {
  readonly material: Material;
  readonly version: MaterialVersion;
  readonly canonicalText: string;
  readonly blocks: readonly MaterialBlock[];
  readonly selection: MaterialSelection;
}): MaterialContextView {
  const { material, version, canonicalText, blocks, selection } = input;
  const header =
    `[Exploration context from material "${truncateTitle(material.title)}" — ` +
    `version ${version.id} (${version.parserKind} ${version.parserVersion})]`;
  const excerptLine =
    `[Selected excerpt]: "${selection.excerpt}" ` +
    `(block ${selection.blockId}, units ${String(selection.start)}–${String(selection.end)} ` +
    "of the version canonical text)";
  const label = "[Surrounding material]:";

  /* 邻近块窗口（含选区；整块交替扩展，预算 = 上限 − 摘录行 − 预留）。 */
  const windowBudget = Math.max(
    0,
    MATERIAL_CONTEXT_LIMIT_UNITS - excerptLine.length - MATERIAL_CONTEXT_RESERVE_UNITS,
  );
  const containing = blocks.find((block) => block.blockId === selection.blockId);
  const blockStart = containing?.start ?? selection.start;
  const blockEnd = containing?.end ?? selection.end;
  let windowStart = blockStart;
  let windowEnd = blockEnd;
  if (windowEnd - windowStart <= windowBudget) {
    /* 整块交替扩展：优先补下一块、再补上一块（首选侧放不下/到边界时回落
       另一侧），直至预算或材料边界——确定性，两端任意一端先到边界即全力
       扩另一端。 */
    const anchorIndex = blocks.findIndex((block) => block.blockId === selection.blockId);
    let lowIndex = anchorIndex;
    let highIndex = anchorIndex;
    let growNext = true;
    if (anchorIndex >= 0) {
      for (;;) {
        const next = highIndex + 1 < blocks.length ? blocks[highIndex + 1] : undefined;
        const previous = lowIndex - 1 >= 0 ? blocks[lowIndex - 1] : undefined;
        const canNext = next !== undefined && next.end - windowStart <= windowBudget;
        const canPrevious = previous !== undefined && windowEnd - previous.start <= windowBudget;
        if (canNext && (growNext || !canPrevious)) {
          windowEnd = next!.end;
          highIndex += 1;
        } else if (canPrevious) {
          windowStart = previous!.start;
          lowIndex -= 1;
        } else {
          break;
        }
        growNext = !growNext;
      }
    }
  } else {
    /* 所在块超预算：选区两侧对称切片（选区本身完整保留在切片内——
       选区长度 ≤ MATERIAL_MAX_SELECTION_UNITS < 预算下界的构造保证）。 */
    const selectionLength = selection.end - selection.start;
    if (windowBudget <= selectionLength) {
      windowStart = selection.start;
      windowEnd = selection.end;
    } else {
      const sideBudget = Math.floor((windowBudget - selectionLength) / 2);
      windowStart = Math.max(blockStart, selection.start - sideBudget);
      windowEnd = Math.min(blockEnd, selection.end + (windowBudget - (selection.end - windowStart)));
    }
  }
  const windowText = canonicalText.slice(windowStart, windowEnd);
  const truncated = windowStart > 0 || windowEnd < canonicalText.length;
  const truncationNote = truncated
    ? `[Context truncated: the surrounding-material window shows units ${String(windowStart)}–${String(windowEnd)} ` +
      `of ${String(canonicalText.length)}; the composed context is capped at ` +
      `${String(MATERIAL_CONTEXT_LIMIT_UNITS)} UTF-16 units]`
    : null;

  const parts = [header, excerptLine, `${label}\n"${windowText}"`];
  if (truncationNote !== null) parts.push(truncationNote);
  parts.push("");
  let composed = parts.join("\n");
  /* 防御性钳制（各上限的构造下不应触发；如触发则收窄窗口，绝不超过上限）。 */
  if (composed.length > MATERIAL_CONTEXT_LIMIT_UNITS) {
    const excess = composed.length - MATERIAL_CONTEXT_LIMIT_UNITS;
    const clampedWindow = windowText.slice(0, Math.max(0, windowText.length - excess));
    composed =
      `${header}\n${excerptLine}\n${label}\n"${clampedWindow}"\n` +
      `[Context truncated: the composed context is capped at ${String(MATERIAL_CONTEXT_LIMIT_UNITS)} UTF-16 units]\n`;
  }

  const contextBlocks: MaterialContextBlockRange[] = blocks
    .filter((block) => block.start >= windowStart && block.end <= windowEnd)
    .map((block) => ({ blockId: block.blockId, start: block.start, end: block.end }));

  return {
    materialId: material.id,
    materialTitle: material.title,
    versionId: version.id,
    parserKind: version.parserKind,
    parserVersion: version.parserVersion,
    selection,
    window: { start: windowStart, end: windowEnd },
    contextBlocks,
    limitUnits: MATERIAL_CONTEXT_LIMIT_UNITS,
    composedUnits: composed.length,
    truncated,
    truncationNote,
    composed,
  };
}
