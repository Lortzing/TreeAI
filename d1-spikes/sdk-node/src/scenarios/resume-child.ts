/**
 * Resume scenario child process (task book 7.5).
 *
 * Runs in its OWN process, twice:
 *   phaseA: create a persistent session, send the first prompt, persist,
 *           print a JSON summary line, exit.
 *   phaseB: open the persisted session file, read history, send a second
 *           prompt, print a JSON summary line, exit.
 *
 * Nothing crosses the process boundary except the session file path and
 * the JSON summary on stdout - which is the point of the scenario: resume
 * must not depend on in-memory objects from the original process.
 *
 * Usage:
 *   resume-child.ts A <cwd> <sessionDir> <eventsDir> <prompt>
 *   resume-child.ts B <cwd> <sessionFile> <eventsDir> <prompt>
 */

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { EvidenceRecorder } from "../recorder.js";
import { RealProbeSession, resolveProbeModel } from "../pi-bridge.js";
import type { ScenarioName } from "../types.js";

function fail(msg: string): never {
  console.error(`resume-child: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [phase, cwd, target, eventsDir, prompt] = process.argv.slice(2);
  if (phase !== "A" && phase !== "B") fail(`unknown phase ${String(phase)}`);
  if (!cwd || !target || !eventsDir || !prompt) fail("missing args");

  const recorder = EvidenceRecorder.open({
    dir: eventsDir,
    scenario: "resume" as ScenarioName,
    probePhase: phase,
  });

  try {
    if (phase === "A") {
      const sessionDir = target;
      mkdirSync(sessionDir, { recursive: true });
      const model = await resolveProbeModel();
      const session = await RealProbeSession.create({
        cwd,
        persist: true,
        sessionDir,
        tools: "none",
        resolvedModel: model,
      });
      recorder.setSessionId(session.sessionId);
      session.attachRecorder((event) => {
        recorder.record(event.type as string, event as unknown as Record<string, unknown>);
      });
      recorder.recordMarker("phaseA_prompt_sent", {});
      await session.prompt(prompt);
      const sessionFile = session.sessionFile;
      recorder.recordMarker("phaseA_done", { sessionFile, sessionId: session.sessionId });
      session.dispose();
      recorder.finalize();
      if (sessionFile === undefined) fail("sessionFile missing after persist");
      printSummary({ sessionFile, sessionId: session.sessionId });
      process.exit(0);
    }

    // phase === "B"
    const sessionFile = target;
    if (!existsSync(sessionFile)) fail(`session file not found: ${sessionFile}`);
    const fileText = readFileSync(sessionFile, "utf8");
    const fileEntryCount = fileText.split("\n").filter((l) => l.trim() !== "").length;

    const model = await resolveProbeModel();
    // SessionManager.open() reads the persisted file; createAgentSession
    // then restores model/history from it (no in-memory state from phase A).
    const session = await RealProbeSession.create({
      cwd,
      persist: true,
      openSessionFile: sessionFile,
      tools: "none",
      resolvedModel: model,
    });
    recorder.setSessionId(session.sessionId);
    session.attachRecorder((event) => {
      recorder.record(event.type as string, event as unknown as Record<string, unknown>);
    });

    const historyBeforePrompt = session.getHistorySummary();
    recorder.recordMarker("phaseB_history_read", {
      persistedFileEntries: fileEntryCount,
      history: historyBeforePrompt,
    });

    await session.prompt(prompt);

    const historyAfter = session.getHistorySummary();
    recorder.recordMarker("phaseB_done", {
      sessionId: session.sessionId,
      history: historyAfter,
    });
    session.dispose();
    recorder.finalize();
    printSummary({
      sessionId: session.sessionId,
      sessionFile,
      history: historyAfter,
      answer: historyAfter.lastAssistantText,
      persistedFileEntriesBefore: fileEntryCount,
      historyEntriesBeforePrompt: historyBeforePrompt.entries,
    });
    process.exit(0);
  } catch (err) {
    recorder.recordError(err, { phase });
    recorder.finalize();
    const blocked = err as { blockedReason?: string };
    if (typeof blocked.blockedReason === "string") {
      printSummary({ blockedReason: blocked.blockedReason });
      console.error(`resume-child phase ${String(phase)} blocked: ${blocked.blockedReason}`);
      process.exit(2);
    }
    console.error(`resume-child phase ${String(phase)} failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printSummary(data: Record<string, unknown>): void {
  process.stdout.write(`RESUME_SUMMARY ${JSON.stringify(data)}\n`);
}

void main();
