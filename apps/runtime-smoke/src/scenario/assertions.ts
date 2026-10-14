/** assertions owner; frozen probe bodies and order preserved. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventId, IsoTimestamp, PiPromptResult, PiRuntimeEvent, RunId, TreeAIError, TreeAIEvent } from "@treeai/contracts";


import { EventRecorder, JsonlEventJournal, findRemainingSecrets } from "@treeai/event-journal";





/* ------------------------------------------------------------------ */
/* Abort helper                                                        */
/* ------------------------------------------------------------------ */

export async function settleAbort(promise: Promise<PiPromptResult>): Promise<{ code: string }> {
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
/* Step 15: journal discipline                                         */
/* ------------------------------------------------------------------ */

export async function assertJournalDiscipline(
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

export async function assertRedaction(
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

export function getEventsAcrossJournals(
  journal1: JsonlEventJournal,
  journal2: JsonlEventJournal,
  runId: RunId,
): readonly TreeAIEvent[] {
  // A run's events never span journal files in this design, but the union
  // is computed defensively and order-checked by seq below.
  return [...journal1.getRunEvents(runId), ...journal2.getRunEvents(runId)];
}
