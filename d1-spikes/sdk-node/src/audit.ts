/**
 * TreeAI D1 spike - audit metrics (task book 9.6).
 *
 * Measures the adapter code this spike would have to maintain if the
 * SDK-embedding route were chosen, and lists the directly-accessible Pi
 * state/types (no guessing: the list mirrors src/pi-bridge.ts imports).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SDK_NODE_DIR } from "./paths.js";

export interface FileMetrics {
  path: string;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

export interface AdapterMetrics {
  adapter: { files: FileMetrics[]; totalCodeLines: number; totalLines: number };
  harness: { files: FileMetrics[]; totalCodeLines: number; totalLines: number };
  countedAt: string;
}

/** Files that directly adapt Pi SDK behavior (the "maintenance cost"). */
const ADAPTER_FILES = ["src/pi-bridge.ts", "src/scenarios/resume-child.ts"];

/** Probe-harness files (evidence, runner, redaction - not Pi-specific). */
const HARNESS_FILES = [
  "src/recorder.ts",
  "src/redact.ts",
  "src/runner.ts",
  "src/validate.ts",
  "src/env.ts",
  "src/types.ts",
  "src/prompts.ts",
  "src/paths.ts",
  "src/audit.ts",
  "src/blocked.ts",
  "src/run.ts",
  "src/tree-nav-run.ts",
  "src/scenarios/basic.ts",
  "src/scenarios/tool.ts",
  "src/scenarios/steer.ts",
  "src/scenarios/abort.ts",
  "src/scenarios/resume.ts",
  "src/scenarios/tree-nav.ts",
  "src/scenarios/index.ts",
];

function measureFile(relPath: string): FileMetrics {
  const abs = join(SDK_NODE_DIR, relPath);
  if (!existsSync(abs)) {
    return { path: relPath, totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0 };
  }
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  let code = 0;
  let comments = 0;
  let blank = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      blank += 1;
      continue;
    }
    if (inBlockComment) {
      comments += 1;
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      comments += 1;
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//")) {
      comments += 1;
      continue;
    }
    code += 1;
  }
  return {
    path: relPath,
    totalLines: lines.length,
    codeLines: code,
    commentLines: comments,
    blankLines: blank,
  };
}

export function adapterMetrics(): AdapterMetrics {
  const adapterFiles = ADAPTER_FILES.map(measureFile).filter((f) => f.totalLines > 0);
  const harnessFiles = HARNESS_FILES.map(measureFile).filter((f) => f.totalLines > 0);
  return {
    adapter: {
      files: adapterFiles,
      totalCodeLines: adapterFiles.reduce((a, f) => a + f.codeLines, 0),
      totalLines: adapterFiles.reduce((a, f) => a + f.totalLines, 0),
    },
    harness: {
      files: harnessFiles,
      totalCodeLines: harnessFiles.reduce((a, f) => a + f.codeLines, 0),
      totalLines: harnessFiles.reduce((a, f) => a + f.totalLines, 0),
    },
    countedAt: new Date().toISOString(),
  };
}

/**
 * Directly accessible Pi state and types through the in-process SDK
 * (recorded as an auditable list; each item is read somewhere in
 * src/pi-bridge.ts or the scenarios).
 */
export const DIRECT_PI_ACCESS: Array<{ what: string; where: string }> = [
  { what: "session.sessionId", where: "identity, recorded in every event" },
  { what: "session.sessionFile", where: "restart-recovery external identifier" },
  { what: "session.isStreaming", where: "abort settle check" },
  { what: "session.messages (AgentMessage[])", where: "history summary, resume checks" },
  { what: "session.agent.state.errorMessage", where: "error propagation after prompt()" },
  { what: "session.model / thinkingLevel", where: "model identity recording" },
  { what: "SessionManager.getEntries() (SessionEntry[])", where: "persisted history read-back" },
  { what: "AgentSessionEvent (typed union)", where: "subscribe() listener, compile-time exhaustiveness" },
  { what: "AssistantMessage.stopReason", where: "finish reason check" },
  { what: "ModelRuntime.getAvailable()", where: "credential availability check" },
  { what: "AgentSession.navigateTree(targetId)", where: "in-place tree navigation (tree-nav scenario)" },
  { what: "SessionManager.getLeafId()", where: "tree leaf pointer before/after navigation (tree-nav scenario)" },
];
