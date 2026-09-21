/**
 * Wave 2 offline integration scenario (task book §6.1, 11 steps).
 *
 * Drives the REAL implementations of five Wave 1 packages end-to-end, fully
 * offline, through their frozen public interfaces:
 *
 *   contracts (types) + runtime-pi (createPiRuntimeFromConfig + injected
 *   deterministic fake port) + persistence (TreeRepository/SQLite) +
 *   event-journal (JsonlEventJournal/EventRecorder/projector/recovery) +
 *   tool-policy (ToolPolicyEngine via the #tool-policy import alias).
 *
 * Covered flow:
 *  1. Forest/Tree/main branch/second branch + episodes/runs/references.
 *  2. Two prompt rounds on the main branch (deterministic echo answers).
 *  3. Second branch forks INSIDE the same session file via navigateTree
 *     (user-message target -> parent fork point); branch context isolation
 *     is proven by the echo answers (second branch never sees main turns).
 *  4. Host-crash simulation: an in-flight (hang) run is abandoned without
 *     dispose; gen-2 restart recovers it via journal recovery + DB update.
 *  5. Restart recovery of BOTH branches from the same append-only session
 *     file (restore main -> full context echo; restore second -> isolated
 *     context echo; session replacement keeps seq continuous).
 *  6. navigateTree branch switch after restart: same sessionId/sessionFile/
 *     entry count, no new session (invariants asserted by the runtime and
 *     re-asserted here).
 *  7. Abort: run.abort-requested -> aborting -> aborted terminal state,
 *     prompt rejected with code "user-abort".
 *  8. Session-missing degradation: deleted session file -> availability
 *     unavailable/missing-file + restore rejected session-corrupt.
 *  9. ToolPolicy: read/write/shell/network decisions incl. grant flow.
 * 10. Journal discipline: per-run strict contiguous seq, duplicate-seq and
 *     duplicate-eventId rejections (the latter demonstrates the documented
 *     journal-global eventId x per-instance pi-runtime-<seq> collision —
 *     hence one journal file per process generation in this app).
 * 11. Redaction: a planted synthetic bearer header never reaches disk;
 *     findRemainingSecrets over every persisted payload returns [].
 *
 * Final cross-check: every run's journal projection state equals its DB
 * state, with zero projection anomalies.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  EventId,
  IsoTimestamp,
  PiEntryId,
  PiPromptResult,
  PiRuntime,
  PiRuntimeEvent,
  Run,
  RunId,
  TreeAIError,
  TreeAIEvent,
} from "@treeai/contracts";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import {
  EventRecorder,
  JsonlEventJournal,
  findRemainingSecrets,
  projectRunEvents,
} from "@treeai/event-journal";
import { ToolPolicyEngine } from "#tool-policy";
import { SmokeSdkPort } from "./fake-pi-port.ts";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Buffers runtime events (emission order) for ordered journal flushing. */
class EventForwarder {
  readonly buffer: PiRuntimeEvent[] = [];
  private unsubscribe: (() => void) | null = null;

  attach(runtime: PiRuntime): void {
    this.unsubscribe = runtime.subscribe((event) => {
      this.buffer.push(event);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  has(kind: string): boolean {
    return this.buffer.some((event) => event.kind === kind);
  }

  async waitFor(kind: string, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.has(kind) && Date.now() < deadline) {
      await delay(2);
    }
    return this.has(kind);
  }

  /**
   * Flush buffered events to the journal under runId (emission order =
   * journal per-run seq order) and mirror state-affecting kinds to the DB.
   *
   * Payload-shape adaptation (integration finding): the runtime emits
   * `runtime.error` with `{code, message}` at the payload top level, while
   * the journal's projector expects the recorder's `{error: {code, message}}`
   * shape. Forwarding the raw payload through recordPiRuntimeEvent would
   * produce an invalid-payload projection anomaly, so this host-side
   * forwarder adapts the shape and keeps the pi-runtime evidence chain.
   */
  async flush(
    recorder: EventRecorder,
    repo: TreeRepository,
    runId: RunId,
    label: string,
  ): Promise<number> {
    const pending = this.buffer.splice(0);
    for (const event of pending) {
      if (event.kind === "runtime.error") {
        const raw = (event.payload ?? {}) as { code?: unknown; message?: unknown };
        const outcome = await recorder.recordCustom(
          runId,
          "runtime.error",
          {
            error: {
              code: typeof raw.code === "string" ? raw.code : "unknown",
              message: typeof raw.message === "string" ? raw.message : "runtime error",
            },
          },
          {
            eventId: event.eventId,
            occurredAt: event.occurredAt,
            evidence: [{ source: "pi-runtime", refId: event.eventId }],
          },
        );
        assert.equal(outcome.status, "appended", `journal append failed while flushing ${label}`);
        continue;
      }
      const outcome = await recorder.recordPiRuntimeEvent(runId, event);
      assert.equal(outcome.status, "appended", `journal append failed while flushing ${label}`);
      if (event.kind === "agent.started") {
        repo.updateRunState(runId, "running");
      } else if (event.kind === "run.abort-requested") {
        repo.updateRunState(runId, "aborting");
      }
    }
    return pending.length;
  }
}

interface PromptOutcome {
  readonly result?: PiPromptResult;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Run one prompt to settlement; capture result or normalized rejection. */
async function settlePrompt(runtime: PiRuntime, text: string): Promise<PromptOutcome> {
  try {
    const result = await runtime.prompt({ text });
    return { result };
  } catch (err) {
    const error = err as TreeAIError;
    assert.equal(typeof error.code, "string", "prompt rejection must carry a TreeAIError code");
    return { error: { code: error.code, message: error.message } };
  }
}

function expectEcho(outcome: PromptOutcome, expected: string, label: string): void {
  assert.ok(outcome.result !== undefined, `${label} must succeed`);
  assert.equal(outcome.result.message, expected, `${label} echo mismatch`);
}

/* ------------------------------------------------------------------ */
/* Scenario report                                                     */
/* ------------------------------------------------------------------ */

export interface ScenarioReport {
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly aborted: number;
  readonly journalEventsGen1: number;
  readonly journalEventsGen2: number;
  readonly recoveredRuns: number;
  readonly policyDecisions: number;
  readonly sessionFilesCreated: number;
  readonly sessionFilesPersisted: number;
}

interface RunBook {
  readonly id: RunId;
  readonly label: string;
  readonly expected: "succeeded" | "failed" | "aborted";
}

/* ------------------------------------------------------------------ */
/* Main scenario                                                       */
/* ------------------------------------------------------------------ */

export async function runWave2Scenario(root: string): Promise<ScenarioReport> {
  const sessionsDir = join(root, "sessions");
  const journalsDir = join(root, "journals");
  const workspace = join(root, "workspace");
  const readRoot = join(root, "read-root");
  const elsewhere = join(root, "elsewhere");
  const agentDir = join(root, "agent-dir");
  for (const dir of [sessionsDir, journalsDir, workspace, readRoot, elsewhere, agentDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const dbPath = join(root, "treeai.db");
  const journalGen1Path = join(journalsDir, "journal-gen-1.jsonl");
  const journalGen2Path = join(journalsDir, "journal-gen-2.jsonl");

  const runs: RunBook[] = [];
  const track = (id: RunId, label: string, expected: RunBook["expected"]): RunId => {
    runs.push({ id, label, expected });
    return id;
  };

  let journalGen2: JsonlEventJournal | null = null;
  let journalGen1Replay: JsonlEventJournal | null = null;
  let repo: TreeRepository | null = null;
  let forwarder1: EventForwarder | null = null;
  let forwarder2: EventForwarder | null = null;

  try {
    /* ================================================================
     * GENERATION 1 (process 1)
     * ================================================================ */

    repo = TreeRepository.open({ path: dbPath });

    // Step 1: Forest / Tree / main branch / second branch.
    const forest = repo.createForest();
    const tree = repo.createTree(forest.id);
    const mainBranch = repo.createBranch(tree.id);
    const secondBranch = repo.createBranch(tree.id, { parentBranchId: mainBranch.id });
    assert.ok(mainBranch.id.length > 0 && secondBranch.id.length > 0);

    const journal1 = await JsonlEventJournal.open(journalGen1Path);
    const recorder1 = new EventRecorder(journal1);

    // Step 2: real runtime, injected fake port (offline; no real SDK calls).
    const port1 = new SmokeSdkPort(["echo", "echo", "echo", "hang"]);
    const runtime1 = createPiRuntimeFromConfig({
      port: port1,
      agentDir,
      defaultCwd: workspace,
    });
    assert.equal(runtime1.piVersion, "0.85.1");
    forwarder1 = new EventForwarder();
    forwarder1.attach(runtime1);

    // Step 3: session A + first run on the main branch.
    const episodeMain1 = repo.createEpisode(mainBranch.id);
    const snapA = await runtime1.createSession({
      model: { providerId: "smoke-provider", modelId: "smoke-model" },
      cwd: workspace,
      sessionDir: sessionsDir,
    });
    let refMain = snapA.reference;
    assert.equal(refMain.piVersion, "0.85.1");
    const sessionAFile = refMain.sessionFile;

    const runMain1 = track(
      repo.createRun(episodeMain1.id, refMain).id,
      "main-turn-1",
      "succeeded",
    );
    await forwarder1.flush(recorder1, repo, runMain1, "runMain1 prelude");

    // Step 4: prompt round 1 on main.
    const outcome1 = await settlePrompt(runtime1, "turn-1@main");
    expectEcho(outcome1, "echo:[turn-1@main]", "main turn-1");
    await forwarder1.flush(recorder1, repo, runMain1, "runMain1 prompt");
    repo.updateRunState(runMain1, "succeeded");
    repo.updateRunSessionReference(runMain1, outcome1.result!.reference);
    refMain = outcome1.result!.reference;

    // Step 5: prompt round 2 on main.
    const runMain2 = track(repo.createRun(episodeMain1.id, refMain).id, "main-turn-2", "succeeded");
    const outcome2 = await settlePrompt(runtime1, "turn-2@main");
    expectEcho(outcome2, "echo:[turn-1@main|turn-2@main]", "main turn-2");
    await forwarder1.flush(recorder1, repo, runMain2, "runMain2 prompt");
    repo.updateRunState(runMain2, "succeeded");
    repo.updateRunSessionReference(runMain2, outcome2.result!.reference);
    refMain = outcome2.result!.reference;

    // Step 6: second branch forks INSIDE session A via navigateTree.
    const managerA = port1.createdManagers[0]!;
    const userTurn1 = managerA
      .getEntries()
      .find((entry) => entry.type === "message" && entry.role === "user" && entry.text === "turn-1@main");
    assert.ok(userTurn1 !== undefined, "turn-1 user entry must exist in session A");
    const forkParentId = userTurn1.parentId;
    assert.ok(forkParentId !== null, "turn-1 user entry must have a parent entry");

    const episodeSecond = repo.createEpisode(secondBranch.id);
    const runSecond1 = track(
      repo.createRun(episodeSecond.id, refMain).id,
      "second-turn-1",
      "succeeded",
    );

    const beforeCount = managerA.getEntries().length;
    const beforeSessions = port1.createdSessions.length;
    const navFork = await runtime1.navigateTree({ entryId: userTurn1.id as PiEntryId });
    // Same session / same file / append-only tree (runtime asserts these too).
    assert.equal(navFork.sessionId, refMain.sessionId, "fork navigation must keep sessionId");
    assert.equal(navFork.sessionFile, sessionAFile, "fork navigation must keep sessionFile");
    assert.equal(
      managerA.getEntries().length,
      beforeCount,
      "fork navigation must not change entry count",
    );
    assert.equal(
      port1.createdSessions.length,
      beforeSessions,
      "fork navigation must not create a new session",
    );
    assert.equal(navFork.entryId, forkParentId, "user-message target lands on its parent");
    repo.updateRunSessionReference(runSecond1, navFork);

    const outcome3 = await settlePrompt(runtime1, "turn-1@second");
    // Branch context isolation: the fork sees only its own user texts.
    expectEcho(outcome3, "echo:[turn-1@second]", "second turn-1");
    await forwarder1.flush(recorder1, repo, runSecond1, "runSecond1 prompt");
    repo.updateRunState(runSecond1, "succeeded");
    repo.updateRunSessionReference(runSecond1, outcome3.result!.reference);
    const refSecond = outcome3.result!.reference;
    assert.notEqual(refSecond.entryId, refMain.entryId, "branches rest on different leaves");
    assert.equal(refSecond.sessionFile, sessionAFile, "both branches share ONE session file");
    assert.ok(managerA.getEntries().length > beforeCount, "the fork appended new entries");

    // Step 7: host-crash simulation — an in-flight run is abandoned.
    const episodeCrash = repo.createEpisode(mainBranch.id);
    const runCrash = track(repo.createRun(episodeCrash.id, refSecond).id, "crash-run", "failed");
    const crashPromise = runtime1.prompt({ text: "turn-crash@main" });
    crashPromise.catch(() => {
      // Never settled in this generation; guard against unhandled rejection.
    });
    assert.ok(
      await forwarder1.waitFor("agent.started"),
      "hang run must emit agent.started before the crash",
    );
    await forwarder1.flush(recorder1, repo, runCrash, "runCrash prefix");
    // "Process death": no dispose, no settle, no recovery in this generation.
    await journal1.close();
    repo.close();
    forwarder1.detach();
    repo = null;
    // ...and the OS would reap every in-flight task. The scenario keeps
    // running in this OS process, so it must stop the abandoned hang run's
    // loop itself: the fake's pacing is ref-counted (an in-flight run must
    // be able to wake the process), so an undisposed zombie would keep the
    // process alive forever and starve the standalone CLI run. Disposal
    // adds no journal events (the forwarder is detached) and no session
    // file writes (no assistant entry is appended on the hang path).
    for (const zombie of port1.createdSessions) {
      zombie.dispose();
    }

    /* ================================================================
     * GENERATION 2 (process 2: restart recovery)
     * ================================================================ */

    repo = TreeRepository.open({ path: dbPath });

    // Step 8: interrupted-run recovery (journal I6 + DB mirror).
    const journal1b = await JsonlEventJournal.open(journalGen1Path);
    const nonTerminal = repo.listNonTerminalRuns();
    assert.ok(
      nonTerminal.some((run) => run.id === runCrash),
      "the crashed run must be non-terminal in the DB before recovery",
    );
    const recovery = await journal1b.recoverInterruptedRuns("host-crash");
    assert.equal(recovery.recovered.length, 1, "exactly one run must be recovered");
    const recoveredRun = recovery.recovered[0]!;
    assert.equal(recoveredRun.runId, runCrash);
    assert.equal(recoveredRun.resolvedTo, "failed");
    assert.equal(recoveredRun.error.code, "unknown");
    const projectionCrash = journal1b.projectRunState(runCrash);
    assert.equal(projectionCrash?.state, "failed", "recovered projection must be failed");
    repo.updateRunState(runCrash, "failed", {
      failure: {
        code: recoveredRun.error.code,
        message: recoveredRun.error.message,
        details: { hostInterrupted: true },
      },
    });
    await journal1b.close();

    // Step 9: generation-2 journal (fresh eventId space; see known finding
    // on journal-global eventId uniqueness x per-instance pi-runtime-<seq>).
    journalGen2 = await JsonlEventJournal.open(journalGen2Path);
    const recorder2 = new EventRecorder(journalGen2);

    const port2 = new SmokeSdkPort(["echo", "echo", "hang"]);
    const runtime2 = createPiRuntimeFromConfig({
      port: port2,
      agentDir,
      defaultCwd: workspace,
    });
    forwarder2 = new EventForwarder();
    forwarder2.attach(runtime2);

    // Step 10: restart recovery — main branch (full context echo).
    const episodeMain2 = repo.createEpisode(mainBranch.id);
    const runMain3 = track(repo.createRun(episodeMain2.id, refMain).id, "main-turn-3", "succeeded");
    const restoredMain = await runtime2.restoreSession(refMain);
    assert.equal(restoredMain.reference.sessionId, refMain.sessionId, "main restore keeps sessionId");
    assert.equal(restoredMain.reference.entryId, refMain.entryId, "main restore keeps the leaf entry");
    await forwarder2.flush(recorder2, repo, runMain3, "runMain3 restore");
    const outcome4 = await settlePrompt(runtime2, "turn-3@main");
    expectEcho(
      outcome4,
      "echo:[turn-1@main|turn-2@main|turn-3@main]",
      "main turn-3 after restart",
    );
    await forwarder2.flush(recorder2, repo, runMain3, "runMain3 prompt");
    repo.updateRunState(runMain3, "succeeded");
    repo.updateRunSessionReference(runMain3, outcome4.result!.reference);
    refMain = outcome4.result!.reference;

    // Step 11: restart recovery — second branch (isolated context echo).
    const runSecond2 = track(
      repo.createRun(episodeSecond.id, refSecond).id,
      "second-turn-2",
      "succeeded",
    );
    const restoredSecond = await runtime2.restoreSession(refSecond);
    assert.equal(
      restoredSecond.reference.sessionId,
      refSecond.sessionId,
      "second-branch restore keeps sessionId",
    );
    assert.equal(
      restoredSecond.reference.entryId,
      refSecond.entryId,
      "second-branch restore keeps the leaf entry",
    );
    await forwarder2.flush(recorder2, repo, runSecond2, "runSecond2 restore");
    const secondEvents = journalGen2.getRunEvents(runSecond2);
    assert.ok(secondEvents.length >= 2, "session replacement events must be recorded");
    assert.equal(secondEvents[0]?.type, "session.replaced", "restore replaces the active session");
    assert.equal(secondEvents[1]?.type, "session.restored", "restore then records session.restored");
    const outcome5 = await settlePrompt(runtime2, "turn-2@second");
    expectEcho(outcome5, "echo:[turn-1@second|turn-2@second]", "second turn-2 after restart");
    await forwarder2.flush(recorder2, repo, runSecond2, "runSecond2 prompt");
    repo.updateRunState(runSecond2, "succeeded");
    repo.updateRunSessionReference(runSecond2, outcome5.result!.reference);

    // Step 12: navigateTree branch switch after restart (same-session proof).
    const activeManager = port2.createdManagers[port2.createdManagers.length - 1]!;
    const mainLeafEntry = activeManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.role === "assistant" &&
          entry.text === "echo:[turn-1@main|turn-2@main|turn-3@main]",
      );
    assert.ok(mainLeafEntry !== undefined, "main turn-3 assistant entry must exist");
    const switchBefore = {
      count: activeManager.getEntries().length,
      sessions: port2.createdSessions.length,
    };
    const navSwitch = await runtime2.navigateTree({ entryId: mainLeafEntry.id as PiEntryId });
    assert.equal(navSwitch.sessionId, refSecond.sessionId, "switch keeps sessionId");
    assert.equal(navSwitch.sessionFile, sessionAFile, "switch keeps sessionFile");
    assert.equal(
      activeManager.getEntries().length,
      switchBefore.count,
      "switch must not change entry count",
    );
    assert.equal(
      port2.createdSessions.length,
      switchBefore.sessions,
      "switch must not create a new session",
    );
    assert.equal(navSwitch.entryId, mainLeafEntry.id, "switch lands on the target leaf");
    await forwarder2.flush(recorder2, repo, runSecond2, "runSecond2 navigate");

    // Step 13: abort -> terminal "aborted" state.
    const episodeAbort = repo.createEpisode(mainBranch.id);
    const runAbort = track(repo.createRun(episodeAbort.id, navSwitch).id, "abort-run", "aborted");
    const abortPromise = runtime2.prompt({ text: "turn-abort@main" });
    abortPromise.catch(() => {
      // Expected rejection below; guard against unhandled rejection.
    });
    assert.ok(await forwarder2.waitFor("agent.started"), "abort run must start");
    await forwarder2.flush(recorder2, repo, runAbort, "runAbort prefix");
    await runtime2.abort();
    const abortOutcome = await settleAbort(abortPromise);
    assert.equal(abortOutcome.code, "user-abort", "aborted prompt rejects with user-abort");
    await forwarder2.flush(recorder2, repo, runAbort, "runAbort settle");
    repo.updateRunState(runAbort, "aborted");

    // Step 14: session-missing degradation + ToolPolicy probes (one run).
    const episodeGuard = repo.createEpisode(secondBranch.id);
    const snapB = await runtime2.createSession({
      model: { providerId: "smoke-provider", modelId: "smoke-model" },
      cwd: workspace,
      sessionDir: sessionsDir,
    });
    const refB = snapB.reference;
    const runGuard = track(repo.createRun(episodeGuard.id, refB).id, "guardrail-run", "failed");
    await forwarder2.flush(recorder2, repo, runGuard, "runGuard prelude");

    // 14a: ToolPolicy matrix (default deny; explicit roots/grants only).
    const policyDecisions = await runToolPolicyProbes(recorder2, runGuard, {
      workspace,
      readRoot,
      elsewhere,
    });

    // 14b: session file goes missing -> degraded availability + rejected restore.
    rmSync(refB.sessionFile, { force: true });
    const marked = repo.markSessionFileAvailability(refB.sessionFile, false);
    assert.ok(marked >= 1, "the deleted session file must mark at least one reference");
    const sweep = repo.refreshSessionAvailability();
    const sweptB = sweep.find((entry) => entry.sessionFile === refB.sessionFile);
    assert.ok(sweptB !== undefined && sweptB.updatedReferences >= 1, "sweep must cover the file");
    const refsByFile = repo.getSessionReferencesByFile(refB.sessionFile);
    const guardRef = refsByFile.find((entry) => entry.runId === runGuard);
    assert.ok(guardRef !== undefined, "guard run reference must be found by file");
    assert.equal(guardRef.reference.availability.status, "unavailable");
    assert.equal(
      (guardRef.reference.availability as { reason?: string }).reason,
      "missing-file",
    );

    let degradeError: TreeAIError | null = null;
    let restoreSucceeded = false;
    try {
      await runtime2.restoreSession(refB);
      restoreSucceeded = true;
    } catch (err) {
      degradeError = err as TreeAIError;
    }
    assert.ok(!restoreSucceeded, "restoring a deleted session file must reject");
    assert.ok(degradeError !== null, "degradation must reject with a TreeAIError");
    assert.equal(degradeError.code, "session-corrupt", "degradation must reject as session-corrupt");
    assert.equal(
      (degradeError.details as { reason?: string } | undefined)?.reason,
      "missing-file",
      "degradation reason must be missing-file",
    );
    // The runtime's restore precheck throws without emitting a runtime.error
    // event (prompt-path failures emit it; precheck failures do not), so the
    // host records the observed failure itself — recorder.recordError
    // produces the projector-compatible {error: {...}} payload.
    const degradeOutcome = await recorder2.recordError(runGuard, degradeError);
    assert.equal(degradeOutcome.status, "appended", "degradation error must be journaled");
    await forwarder2.flush(recorder2, repo, runGuard, "runGuard degradation");
    repo.updateRunState(runGuard, "failed", { failure: degradeError });

    // Step 15: journal discipline — strict seq + duplicate rejections.
    await assertJournalDiscipline(journalGen2, recorder2, runGuard);

    // Step 16: redaction — planted credential never reaches disk.
    await assertRedaction(journalGen2, recorder2, runGuard, journalGen2Path);

    /* ================================================================
     * Final cross-consistency: projection state === DB state, no anomalies.
     * ================================================================ */

    forwarder2.detach();
    await journalGen2.close();
    journalGen1Replay = await JsonlEventJournal.open(journalGen1Path);
    const eventsGen1 = journalGen1Replay
      .getRunIds()
      .reduce((sum, id) => sum + journalGen1Replay!.getRunEvents(id).length, 0);
    const eventsGen2 = journalGen2
      .getRunIds()
      .reduce((sum, id) => sum + journalGen2!.getRunEvents(id).length, 0);

    for (const book of runs) {
      const events = getEventsAcrossJournals(journalGen1Replay, journalGen2, book.id);
      assert.ok(events.length > 0, `run ${book.label} must have journal events`);
      const seqs = events.map((event) => event.seq).sort((a, b) => a - b);
      seqs.forEach((seq, index) => {
        assert.equal(seq, index + 1, `run ${book.label} journal seq must be 1..N contiguous`);
      });
      const projection = projectRunEvents(book.id, events);
      const dbRun: Run = repo.getRun(book.id);
      assert.equal(projection.state, book.expected, `run ${book.label} projection state`);
      assert.equal(dbRun.state, book.expected, `run ${book.label} DB state`);
      assert.equal(
        projection.state,
        dbRun.state,
        `run ${book.label} projection must match the DB state`,
      );
      assert.deepEqual(projection.anomalies, [], `run ${book.label} must have no anomalies`);
      if (book.expected !== "succeeded") {
        assert.ok(dbRun.terminalAt !== null, `run ${book.label} must record terminalAt`);
      }
    }
    const dbRunIds = new Set(runs.map((book) => book.id as string));
    for (const journalId of [
      ...journalGen1Replay.getRunIds(),
      ...journalGen2.getRunIds(),
    ]) {
      assert.ok(
        dbRunIds.has(journalId as string),
        "every journal run id must exist in the TreeAI DB",
      );
    }

    // Session A (shared by both branches) persists; session B was deleted
    // for the degradation scenario.
    assert.ok(existsSync(sessionAFile), "session A file must persist (append-only)");
    assert.ok(!existsSync(refB.sessionFile), "session B file must stay deleted");
    const sessionFilesPersisted = 1;

    return {
      runs: runs.length,
      succeeded: runs.filter((book) => book.expected === "succeeded").length,
      failed: runs.filter((book) => book.expected === "failed").length,
      aborted: runs.filter((book) => book.expected === "aborted").length,
      journalEventsGen1: eventsGen1,
      journalEventsGen2: eventsGen2,
      recoveredRuns: recovery.recovered.length,
      policyDecisions,
      sessionFilesCreated: 2,
      sessionFilesPersisted,
    };
  } finally {
    forwarder1?.detach();
    forwarder2?.detach();
    await journalGen2?.close().catch(() => {});
    await journalGen1Replay?.close().catch(() => {});
    try {
      repo?.close();
    } catch {
      // Already closed or never opened.
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Abort helper                                                        */
/* ------------------------------------------------------------------ */

async function settleAbort(promise: Promise<PiPromptResult>): Promise<{ code: string }> {
  try {
    const result = await promise;
    void result;
    assert.fail("aborted prompt must reject");
  } catch (err) {
    if (err instanceof assert.AssertionError) {
      throw err;
    }
    return { code: (err as TreeAIError).code };
  }
}

/* ------------------------------------------------------------------ */
/* Step 14a: ToolPolicy probe matrix                                   */
/* ------------------------------------------------------------------ */

async function runToolPolicyProbes(
  recorder: EventRecorder,
  runId: RunId,
  dirs: { readonly workspace: string; readonly readRoot: string; readonly elsewhere: string },
): Promise<number> {
  const engine = new ToolPolicyEngine({
    cwd: dirs.workspace,
    readRoots: [dirs.readRoot],
    workspaceRoots: [dirs.workspace],
  });

  engine.authorizations.issue({
    category: "write",
    targetPath: join(dirs.workspace, "granted.txt"),
    expiresInMs: 60_000,
  });

  const probes: ReadonlyArray<{
    readonly label: string;
    readonly request: Parameters<ToolPolicyEngine["evaluate"]>[0];
    readonly expect: "allow" | "deny" | "require-approval";
  }> = [
    {
      label: "read-inside-roots",
      request: { category: "read", targetPath: join(dirs.readRoot, "notes.txt") },
      expect: "allow",
    },
    {
      label: "read-outside-roots",
      request: { category: "read", targetPath: join(dirs.elsewhere, "outside.txt") },
      expect: "deny",
    },
    {
      label: "write-outside-workspace",
      request: { category: "write", targetPath: join(dirs.elsewhere, "x.txt") },
      expect: "deny",
    },
    {
      label: "write-inside-without-grant",
      request: { category: "write", targetPath: join(dirs.workspace, "draft.txt") },
      expect: "require-approval",
    },
    {
      label: "write-inside-with-grant",
      request: { category: "write", targetPath: join(dirs.workspace, "granted.txt") },
      expect: "allow",
    },
    {
      label: "write-inside-after-grant-consumed",
      request: { category: "write", targetPath: join(dirs.workspace, "granted.txt") },
      expect: "require-approval",
    },
    {
      label: "shell-denied-by-default",
      request: { category: "shell", command: "printf treeai-smoke" },
      expect: "deny",
    },
    {
      label: "network-denied-by-default",
      request: { category: "network", host: "treeai-smoke.invalid" },
      expect: "deny",
    },
  ];

  let recorded = 0;
  for (const probe of probes) {
    const decision = engine.evaluate(probe.request);
    assert.equal(
      decision.outcome,
      probe.expect,
      `policy probe ${probe.label} outcome`,
    );
    assert.equal(decision.category, probe.request.category);
    const outcome = await recorder.recordCustom(runId, "tool.decision", {
      probe: probe.label,
      category: decision.category,
      outcome: decision.outcome,
      risk: decision.risk,
      ruleId: decision.ruleId,
    });
    assert.equal(outcome.status, "appended", `policy probe ${probe.label} must be journaled`);
    recorded += 1;
  }
  assert.ok(engine.audit.records.length >= probes.length, "audit log must record the probes");
  assert.equal(engine.audit.droppedCount, 0, "no audit records may be dropped");
  return recorded;
}

/* ------------------------------------------------------------------ */
/* Step 15: journal discipline                                         */
/* ------------------------------------------------------------------ */

async function assertJournalDiscipline(
  journal: JsonlEventJournal,
  recorder: EventRecorder,
  runId: RunId,
): Promise<void> {
  const events = journal.getRunEvents(runId);
  assert.ok(events.length > 0, "guard run must have events before discipline checks");
  const last = events[events.length - 1]!;
  const beforeCount = events.length;

  // Duplicate seq is detectably rejected.
  const dupSeqEvent: TreeAIEvent = {
    eventId: "probe-duplicate-seq" as EventId,
    runId,
    seq: last.seq,
    occurredAt: new Date().toISOString() as IsoTimestamp,
    type: "tool.decision",
    payload: { probe: "duplicate-seq" },
    evidence: [],
  };
  const dupSeqOutcome = await journal.append(dupSeqEvent);
  assert.equal(dupSeqOutcome.status, "rejected", "duplicate seq must be rejected");
  assert.equal(
    (dupSeqOutcome as { reason?: string }).reason,
    "duplicate-seq",
    "duplicate seq rejection reason",
  );

  // Duplicate eventId: demonstrates the documented integration finding —
  // journal eventId uniqueness is journal-GLOBAL while runtime instances
  // assign per-instance "pi-runtime-<seq>" ids, so a second generation of
  // the same runtime cannot write into the same journal file (this app
  // therefore uses one journal file per process generation).
  const collisionEvent: PiRuntimeEvent = {
    eventId: "pi-runtime-1" as EventId,
    seq: 4242,
    occurredAt: new Date().toISOString(),
    kind: "message.updated",
    payload: { probe: "event-id-collision" },
  };
  const collisionOutcome = await recorder.recordPiRuntimeEvent(runId, collisionEvent);
  assert.equal(collisionOutcome.status, "rejected", "duplicate eventId must be rejected");
  assert.equal(
    (collisionOutcome as { reason?: string }).reason,
    "duplicate-event-id",
    "duplicate eventId rejection reason",
  );

  // Rejections must not mutate the journal.
  assert.equal(
    journal.getRunEvents(runId).length,
    beforeCount,
    "rejected appends must not change the journal",
  );
}

/* ------------------------------------------------------------------ */
/* Step 16: redaction                                                  */
/* ------------------------------------------------------------------ */

async function assertRedaction(
  journal: JsonlEventJournal,
  recorder: EventRecorder,
  runId: RunId,
  journalPath: string,
): Promise<void> {
  // Synthetic credential, assembled at runtime and NEVER printed.
  const planted = ["smoke-probe", "token", "7f3a9c2e5b8d1a4f6c0e"].join("-");
  const plantedHeader = `Bearer ${planted}`;
  const outcome = await recorder.recordCustom(runId, "tool.decision", {
    probe: "redaction",
    credential: plantedHeader,
  });
  assert.equal(outcome.status, "appended", "redaction probe must be appended");
  assert.ok(
    (outcome as { redactionApplied?: readonly string[] }).redactionApplied !== undefined &&
      (outcome as { redactionApplied?: readonly string[] }).redactionApplied!.length > 0,
    "the planted credential must trigger bottom-line redaction",
  );

  const text = readFileSync(journalPath, "utf8");
  assert.ok(!text.includes(planted), "the planted credential must not reach the journal file");

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as { payload?: unknown };
    const remaining = findRemainingSecrets(parsed.payload);
    assert.deepEqual(
      remaining,
      [],
      "every persisted payload must be free of remaining secrets",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getEventsAcrossJournals(
  journal1: JsonlEventJournal,
  journal2: JsonlEventJournal,
  runId: RunId,
): readonly TreeAIEvent[] {
  // A run's events never span journal files in this design, but the union
  // is computed defensively and order-checked by seq below.
  return [...journal1.getRunEvents(runId), ...journal2.getRunEvents(runId)];
}
