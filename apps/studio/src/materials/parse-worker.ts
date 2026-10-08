import { parentPort, workerData } from "node:worker_threads";
import { parseMarkdownMaterial } from "./markdown-parser.ts";
import { DEFAULT_MAX_PAGES, parsePdfMaterial } from "./pdf-parser.ts";
import type { MaterialBlock } from "@treeai/contracts";
import type { MaterialParserOutcome } from "./import-service.ts";

interface ParseWorkerData {
  readonly parserKind: "markdown" | "pdf";
  readonly bytes: Uint8Array;
  readonly maxPages: number;
}

interface ParseWorkerResult {
  readonly type: "result";
  readonly outcome: MaterialParserOutcome;
}

if (parentPort === null) {
  throw new Error("material parse worker requires a parent port");
}

const data = workerData as ParseWorkerData;
if (!(data.bytes instanceof Uint8Array)) {
  throw new TypeError("material parse worker received invalid bytes");
}

function parse(): MaterialParserOutcome {
  if (data.parserKind === "markdown") {
    const result = parseMarkdownMaterial(data.bytes);
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    return {
      ok: true,
      canonicalText: result.canonicalText,
      blocks: result.blocks.map((block): MaterialBlock => ({
        blockId: block.blockId,
        kind: block.kind,
        start: block.start,
        end: block.end,
      })),
    };
  }

  const result = parsePdfMaterial(data.bytes, {
    maxPages: data.maxPages || DEFAULT_MAX_PAGES,
  });
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return {
    ok: true,
    canonicalText: result.canonicalText,
    blocks: result.blocks.map((block): MaterialBlock => ({
      blockId: block.blockId,
      kind: block.kind,
      start: block.start,
      end: block.end,
      page: block.page,
      ...(block.geometry === null ? {} : { geometry: block.geometry }),
    })),
  };
}

const outcome = parse();
const message: ParseWorkerResult = { type: "result", outcome };
parentPort.postMessage(message);
