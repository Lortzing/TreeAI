/** execution owner; frozen probe bodies and order preserved. */
import { strict as assert } from "node:assert";


import type { PiPromptResult, PiRuntime, PiRuntimeEvent, RunId, TreeAIError } from "@treeai/contracts";

import { TreeRepository } from "@treeai/persistence";
import { EventRecorder } from "@treeai/event-journal";





/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}


/** Buffers runtime events (emission order) for ordered journal flushing. */
export class EventForwarder {
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


export interface PromptOutcome {
  readonly result?: PiPromptResult;
  readonly error?: { readonly code: string; readonly message: string };
}


/** Run one prompt to settlement; capture result or normalized rejection. */
export async function settlePrompt(runtime: PiRuntime, text: string): Promise<PromptOutcome> {
  try {
    const result = await runtime.prompt({ text });
    return { result };
  } catch (err) {
    const error = err as TreeAIError;
    assert.equal(typeof error.code, "string", "prompt rejection must carry a TreeAIError code");
    return { error: { code: error.code, message: error.message } };
  }
}


export function expectEcho(outcome: PromptOutcome, expected: string, label: string): void {
  assert.ok(outcome.result !== undefined, `${label} must succeed`);
  assert.equal(outcome.result.message, expected, `${label} echo mismatch`);
}
