/** identity ownership for branching.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialSelection,
} from "@treeai/contracts";

/** 选区身份（同一来源判定的全部维度：材料×版本×块×区间，缺一不可）。 */
export function sameMaterialSelectionIdentity(a: MaterialSelection, b: MaterialSelection): boolean {
  return (
    a.materialId === b.materialId &&
    a.versionId === b.versionId &&
    a.blockId === b.blockId &&
    a.start === b.start &&
    a.end === b.end
  );
}
