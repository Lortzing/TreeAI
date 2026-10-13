/** materials ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import {
  parseMarkdownMaterial,
} from "../../materials/markdown-parser.ts";
import type {
  MaterialSpec,
  ParsedMaterial,
} from "./model.ts";

export function parseMaterialSpec(spec: MaterialSpec): ParsedMaterial {
  const bytes = new TextEncoder().encode(spec.markdown);
  const parsed = parseMarkdownMaterial(bytes);
  if (!parsed.ok) {
    throw new Error(`b9-dataset: built-in material ${spec.materialId} failed d4-md-v1 parse (${parsed.reason}): ${parsed.message}`);
  }
  return {
    spec,
    canonicalText: parsed.canonicalText,
    blocks: parsed.blocks.map((block) => ({ blockId: block.blockId, start: block.start, end: block.end })),
  };
}
