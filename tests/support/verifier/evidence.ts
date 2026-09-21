/**
 * Evidence run-directory management for the D2 verifier (Agent F).
 *
 * Discipline implemented here (task book §5 Agent F 证据要求):
 *   - every run appends evidence/d2/runs/<UTC-run-id>/{environment.json,
 *     result.json, events.jsonl, checks.json, logs/} and NEVER overwrites a
 *     historical run (collision → fresh suffixed directory);
 *   - every byte written is redacted (home paths) and secret-scanned BEFORE
 *     it touches the disk; detected leaks are masked, recorded and must fail
 *     the run;
 *   - after the final write, the whole run directory is rescanned; any new
 *     finding overrides the verdict to FAIL (exit 2).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  maskSecretsInText,
  redactHomePaths,
  scanFiles,
  scanFilename,
  scanText,
  type Finding,
} from "./secret-scanner.ts";
import { utcNowIso } from "./util.ts";

export interface GuardedWriteResult {
  /** Path relative to the run directory (used in evidenceFiles references). */
  relPath: string;
  /** Leaks found in the pre-write scan (already masked in the stored copy). */
  leaks: Finding[];
}

export interface JournalEventInput {
  type: string;
  payload: Record<string, unknown>;
  evidence?: ReadonlyArray<{
    source: "pi-runtime" | "treeai-journal" | "external";
    refId: string;
    locator?: string;
  }>;
}

export class EvidenceWriter {
  readonly runDir: string;
  readonly runId: string;
  /** Accumulated pre-write leaks across all writes. */
  readonly preWriteLeaks: Finding[] = [];
  private seq = 0;
  private eventLineCount = 0;

  constructor(runsRoot: string, desiredRunId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(desiredRunId)) {
      throw new Error(`invalid run id: ${desiredRunId}`);
    }
    let dir = join(runsRoot, desiredRunId);
    let runId = desiredRunId;
    let n = 2;
    while (existsSync(dir)) {
      runId = `${desiredRunId}-${n}`;
      dir = join(runsRoot, runId);
      n++;
      if (n > 999) throw new Error("cannot allocate a fresh run directory");
    }
    this.runDir = dir;
    this.runId = runId;
    mkdirSync(join(dir, "logs"), { recursive: true });
  }

  /**
   * Redact + secret-scan + write a text file inside the run directory.
   * The stored copy always has home paths replaced by [HOME]; content-rule
   * matches are additionally masked and recorded as leaks.
   */
  writeTextGuarded(relPath: string, content: string): GuardedWriteResult {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new Error(`refusing to write outside the run directory: ${relPath}`);
    }
    const homeRedacted = redactHomePaths(content);
    const direct = scanText(homeRedacted, relPath);
    let stored = homeRedacted;
    if (direct.length > 0) {
      const { masked } = maskSecretsInText(homeRedacted);
      stored = masked;
    }
    // Filename rules apply to what we are about to create, too.
    const nameLeaks = scanFilename(relPath.split("/").pop() ?? relPath, relPath);
    const leaks = [...direct, ...nameLeaks];
    const abs = join(this.runDir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, stored, "utf8");
    this.preWriteLeaks.push(...leaks);
    return { relPath, leaks };
  }

  /** Guarded JSON write (stable 2-space formatting, trailing newline). */
  writeJsonGuarded(relPath: string, value: unknown): GuardedWriteResult {
    return this.writeTextGuarded(relPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Append one journal event (guarded) to events.jsonl. */
  journal(input: JournalEventInput): void {
    this.seq += 1;
    this.eventLineCount += 1;
    const event = {
      eventId: `${this.runId}-e${this.seq}`,
      runId: this.runId,
      seq: this.seq,
      occurredAt: utcNowIso(),
      type: input.type,
      payload: input.payload,
      evidence: input.evidence ?? [],
    };
    const line = `${JSON.stringify(event)}\n`;
    // Guard the line, then append. Scan uses the run-relative path.
    const homeRedacted = redactHomePaths(line);
    const leaks = scanText(homeRedacted, "events.jsonl");
    let stored = homeRedacted;
    if (leaks.length > 0) {
      const { masked } = maskSecretsInText(homeRedacted);
      stored = masked;
    }
    appendFileSync(join(this.runDir, "events.jsonl"), stored, "utf8");
    this.preWriteLeaks.push(...leaks);
  }

  /** Read back the journal file and verify the cross-line seq discipline. */
  verifyJournalOnDisk(): { ok: boolean; problems: string[]; lineCount: number } {
    const problems: string[] = [];
    let lineCount = 0;
    const abs = join(this.runDir, "events.jsonl");
    if (!existsSync(abs)) {
      return { ok: false, problems: ["events.jsonl missing"], lineCount: 0 };
    }
    const text = readFileSync(abs, "utf8");
    const lastSeqByRun = new Map<string, number>();
    const seenSeq = new Set<string>();
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      lineCount += 1;
      let evt: { runId?: unknown; seq?: unknown; eventId?: unknown };
      try {
        evt = JSON.parse(line) as typeof evt;
      } catch {
        problems.push(`line ${lineCount}: not valid JSON`);
        continue;
      }
      const key = `${String(evt.runId)}#${String(evt.seq)}`;
      if (seenSeq.has(key)) {
        problems.push(`line ${lineCount}: duplicate seq ${String(evt.seq)} for run ${String(evt.runId)}`);
      }
      seenSeq.add(key);
      const last = lastSeqByRun.get(String(evt.runId));
      if (last !== undefined && typeof evt.seq === "number" && evt.seq <= last) {
        problems.push(
          `line ${lineCount}: seq ${String(evt.seq)} not strictly greater than previous ${String(last)} (run ${String(evt.runId)})`,
        );
      }
      if (typeof evt.seq === "number") lastSeqByRun.set(String(evt.runId), evt.seq);
    }
    if (lineCount !== this.eventLineCount) {
      problems.push(`journal line count on disk (${lineCount}) differs from emitted (${this.eventLineCount})`);
    }
    return { ok: problems.length === 0, problems, lineCount };
  }

  /**
   * Post-write rescan of the whole run directory (content AND file names).
   * The caller supplies `alreadyKnown` findings (pre-write leaks, which are
   * recorded but whose masked copies remain in evidence by design) so only
   * NEW findings count as an override trigger.
   */
  postWriteScan(): { findings: Finding[]; filesScanned: number } {
    const report = scanFiles([this.runDir], this.runDir);
    return { findings: report.findings, filesScanned: report.stats.filesScanned };
  }

  /** Relative path of an absolute path inside the run dir (for evidenceFiles). */
  rel(absPath: string): string {
    return relative(this.runDir, absPath).split(/[\\/]/).join("/");
  }
}
