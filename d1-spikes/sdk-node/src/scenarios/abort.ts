/**
 * Scenario: abort (task book 7.4).
 * Abort while the answer is streaming. Must settle within 60s, record the
 * final state and last event, leave no uncontrollable work behind, and a
 * new session must be usable afterwards.
 */

import type { ScenarioContext } from "../runner.js";
import type { ScenarioDeps } from "./basic.js";
import { prepareFixtureCwd } from "../fixture.js";
import {
  ABORT_POST_EXPECTED,
  ABORT_POST_PROMPT,
  ABORT_PROMPT,
  ABORT_SETTLE_BUDGET_MS,
} from "../prompts.js";

export async function runAbortScenario(ctx: ScenarioContext, deps: ScenarioDeps): Promise<void> {
  const fixture = prepareFixtureCwd("treeai-d1-abort-");
  ctx.onCleanup(fixture.cleanup);

  const activeResourcesBefore = process.getActiveResourcesInfo();

  const session = await deps.createSession.create({ cwd: fixture.cwd, persist: false, tools: "none" });
  ctx.recorder.setSessionId(session.sessionId);
  // Evidence bridge: every raw Pi event is recorded to events.jsonl.
  const unsubRec = session.subscribe((event) => {
    ctx.recorder.record(event.type as string, event);
  });
  ctx.onCleanup(unsubRec);
  ctx.onCleanup(() => session.dispose());

  let deltaCount = 0;
  let lastEventType = "";
  let stopReason: string | undefined;
  const unsub = session.subscribe((event) => {
    lastEventType = event.type as string;
    if (lastEventType === "message_update") {
      const ame = event.assistantMessageEvent as { type?: string } | undefined;
      if (ame?.type === "text_delta") deltaCount += 1;
    }
    if (lastEventType === "message_end") {
      const msg = event.message as { stopReason?: string } | undefined;
      stopReason = msg?.stopReason;
    }
  });
  ctx.onCleanup(unsub);

  // Start a long answer; abort as soon as the first delta arrives.
  const promptPromise = session.prompt(ABORT_PROMPT);
  // Not awaited yet (we must abort mid-stream); attach a catch NOW so a
  // rejection during the poll window cannot crash the process before the
  // runner records a structured result. The outcome is observed in the
  // settle race below.
  promptPromise.catch(() => {});
  let waitedMs = 0;
  while (deltaCount < 1 && waitedMs < 30_000) {
    await sleep(25);
    waitedMs += 25;
  }
  ctx.recorder.recordMarker("abort_called", { afterDeltas: deltaCount, waitedMs });
  const abortStart = Date.now();
  await session.abort();
  const abortSettleMs = Date.now() - abortStart;
  ctx.recorder.recordMarker("abort_returned", { abortSettleMs });

  // The prompt promise must settle (resolve or reject) after abort; both
  // are acceptable, but it must not hang. The race timer is cleared so it
  // never keeps the process alive.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settleTimeout = new Promise<"still-pending">((resolve) => {
    settleTimer = setTimeout(() => resolve("still-pending"), ABORT_SETTLE_BUDGET_MS);
  });
  const promptOutcome = await Promise.race([
    promptPromise.then(
      () => "resolved" as const,
      (err: unknown) => `rejected: ${(err as Error).message.slice(0, 120)}` as string,
    ),
    settleTimeout,
  ]);
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  ctx.recorder.recordMarker("prompt_settled_after_abort", { outcome: promptOutcome });

  ctx.check(deltaCount >= 1, `abort happened during streaming (after ${deltaCount} deltas)`);
  ctx.check(abortSettleMs <= ABORT_SETTLE_BUDGET_MS, `abort() settled within ${ABORT_SETTLE_BUDGET_MS}ms (took ${abortSettleMs}ms)`);
  ctx.check(promptOutcome !== "still-pending", `prompt promise settled after abort (${promptOutcome})`);
  ctx.check(session.isStreaming === false, "session.isStreaming is false after abort");
  ctx.check(lastEventType !== "", `last event recorded (${lastEventType})`);
  ctx.observe(`stopReason after abort: ${String(stopReason)}`);
  ctx.observe(`last event type before settle: ${lastEventType}`);

  // No residual work: the old session is disposed (cleanup above); compare
  // process-active resources as a coarse leak indicator.
  const activeResourcesAfter = process.getActiveResourcesInfo();
  ctx.observe(
    `active resources before=[${activeResourcesBefore.join(",")}] after=[${activeResourcesAfter.join(",")}]`,
  );

  // A new session must be creatable and usable after the abort.
  const session2 = await deps.createSession.create({ cwd: fixture.cwd, persist: false, tools: "none" });
  ctx.recorder.recordMarker("post_abort_session_created", { sessionId: session2.sessionId });
  ctx.onCleanup(() => session2.dispose());
  const unsub2 = session2.subscribe((event) => {
    ctx.recorder.record(event.type as string, event);
  });
  ctx.onCleanup(unsub2);
  let answer2 = "";
  const unsub2b = session2.subscribe((event) => {
    if (event.type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      answer2 = (msg?.content ?? [])
        .map((p) => (p.type === "text" ? p.text ?? "" : ""))
        .join("");
    }
  });
  ctx.onCleanup(unsub2b);
  await session2.prompt(ABORT_POST_PROMPT);
  ctx.check(
    answer2.includes(ABORT_POST_EXPECTED),
    `new session works after abort (answer contains ${ABORT_POST_EXPECTED}: ${answer2.slice(0, 120)})`,
  );
  ctx.observe(`post-abort new session answered: ${answer2.slice(0, 80)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
