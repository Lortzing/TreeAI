/**
 * Scenario: resume (task book 7.5).
 * One persisted conversation turn in process A; process exit; process B
 * restarts, opens the same session file, reads prior history, and
 * continues the conversation. Only file-based identifiers may cross the
 * process boundary.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runner.js";
import { mergeEventFiles } from "../recorder.js";
import type { ResumeChildRunner } from "../types.js";
import { prepareFixtureCwd } from "../fixture.js";
import { RESUME_EXPECTED, RESUME_PROMPT_A, RESUME_PROMPT_B } from "../prompts.js";

export async function runResumeScenario(
  ctx: ScenarioContext,
  childRunner: ResumeChildRunner,
): Promise<void> {
  const fixture = prepareFixtureCwd("treeai-d1-resume-");
  ctx.onCleanup(fixture.cleanup);
  if (fixture.source === "local-fallback") {
    ctx.limit("Fixture source is the local fallback (Agent D's shared fixtures/ not present yet).");
  }

  const sessionDir = join(ctx.scenarioDir, "session-store");
  const eventsA = join(ctx.scenarioDir, "phase-a");
  const eventsB = join(ctx.scenarioDir, "phase-b");
  mkdirSync(sessionDir, { recursive: true });

  ctx.recorder.recordMarker("phaseA_spawn", { sessionDir });
  const phaseAStart = Date.now();
  const a = await childRunner.phaseA({
    cwd: fixture.cwd,
    sessionDir,
    eventsDir: eventsA,
    prompt: RESUME_PROMPT_A,
  });
  const phaseADuration = Date.now() - phaseAStart;
  ctx.recorder.recordMarker("phaseA_exited", {
    exitCode: a.exitCode,
    durationMs: phaseADuration,
    blockedReason: a.blockedReason ?? null,
  });

  if (a.blockedReason !== undefined) {
    ctx.markBlocked(
      a.blockedReason,
      `phase A child process was blocked (${a.blockedReason}); see phase-a/ evidence`,
    );
  }

  ctx.check(a.exitCode === 0, `phase A child exited 0 (got ${a.exitCode})`);
  ctx.check(
    a.sessionFile !== undefined && existsSync(a.sessionFile),
    `phase A produced a persisted session file (${String(a.sessionFile)})`,
  );

  if (a.sessionFile === undefined || !existsSync(a.sessionFile)) {
    // A crash (not an environmental block) is a scenario FAIL.
    throw new Error(`phase A produced no usable session file (exitCode=${a.exitCode})`);
  }

  // The ONLY state crossing the process boundary:
  ctx.observe(`restart-recovery external identifier: sessionFile=${a.sessionFile}`);
  ctx.observe(`restart-recovery external identifier: sessionId=${String(a.sessionId)}`);
  ctx.limit(
    "Resume depends only on the session file path (plus Pi's own config). No in-memory object from phase A is referenced by phase B.",
  );

  ctx.recorder.recordMarker("phaseB_spawn", { sessionFile: a.sessionFile });
  const phaseBStart = Date.now();
  const b = await childRunner.phaseB({
    cwd: fixture.cwd,
    sessionFile: a.sessionFile,
    eventsDir: eventsB,
    prompt: RESUME_PROMPT_B,
  });
  const phaseBDuration = Date.now() - phaseBStart;
  ctx.recorder.recordMarker("phaseB_exited", {
    exitCode: b.exitCode,
    durationMs: phaseBDuration,
    blockedReason: b.blockedReason ?? null,
  });

  if (b.blockedReason !== undefined) {
    ctx.markBlocked(
      b.blockedReason,
      `phase B child process was blocked (${b.blockedReason}); see phase-b/ evidence`,
    );
  }

  ctx.check(b.exitCode === 0, `phase B child exited 0 (got ${b.exitCode})`);

  // History read-back BEFORE the second prompt is proven by the phase B
  // child marker phaseB_history_read; the summary carries counts. Both the
  // phase A turn (u/a >= 1 each) and the phase B turn (u/a >= 2 each) must
  // be present - a restore that "forgets" phase A fails here.
  const history = b.history;
  ctx.check(
    history !== undefined && history.userMessages >= 2 && history.assistantMessages >= 2,
    `phase B read prior history from the session file (entries=${String(history?.entries)}, u=${String(history?.userMessages)}, a=${String(history?.assistantMessages)})`,
  );
  const answer = b.answer ?? "";
  ctx.check(
    answer.includes(RESUME_EXPECTED),
    `phase B continued the conversation with a new prompt; answer recalls the passphrase (got: ${answer.slice(0, 200)})`,
  );
  if (a.sessionId !== undefined && b.sessionId !== undefined) {
    ctx.observe(
      a.sessionId === b.sessionId
        ? `session identity preserved across processes (${a.sessionId})`
        : `session identity changed across processes (A=${a.sessionId}, B=${b.sessionId}); file-based linkage remains the durable identifier`,
    );
  }
  ctx.observe(
    `durations: phaseA=${phaseADuration}ms, phaseB=${phaseBDuration}ms; history after resume: ${JSON.stringify(history)}`,
  );

  // Merge child event files into this scenario's events.jsonl with global seq.
  const merged = mergeEventFiles(
    [
      { path: join(eventsA, "events.jsonl"), probePhase: "A" },
      { path: join(eventsB, "events.jsonl"), probePhase: "B" },
    ],
    ctx.recorder,
  );
  ctx.observe(`merged ${merged} child events into the scenario event stream (probePhase-tagged)`);
  ctx.check(merged > 0, "child events merged into scenario evidence");
}
