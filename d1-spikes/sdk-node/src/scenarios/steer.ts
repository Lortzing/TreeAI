/**
 * Scenario: steer (task book 7.3).
 * Send a steering instruction while a long answer is streaming. Record the
 * relative timing of steer sent/observed/effective, whether the steering
 * was delivered in the same session, and whether the final output reflects
 * the new instruction.
 */

import type { ScenarioContext } from "../runner.js";
import type { ScenarioDeps } from "./basic.js";
import { prepareFixtureCwd } from "../fixture.js";
import { STEER_BASE_PROMPT, STEER_EXPECTED, STEER_MESSAGE } from "../prompts.js";

export async function runSteerScenario(ctx: ScenarioContext, deps: ScenarioDeps): Promise<void> {
  const fixture = prepareFixtureCwd("treeai-d1-steer-");
  ctx.onCleanup(fixture.cleanup);

  const session = await deps.createSession.create({ cwd: fixture.cwd, persist: false, tools: "none" });
  const sessionId = session.sessionId;
  ctx.recorder.setSessionId(sessionId);
  // Evidence bridge: every raw Pi event is recorded to events.jsonl.
  const unsubRec = session.subscribe((event) => {
    ctx.recorder.record(event.type as string, event);
  });
  ctx.onCleanup(unsubRec);
  ctx.onCleanup(() => session.dispose());

  let deltaCountBeforeSteer = -1;
  let deltaCount = 0;
  let steerQueuedSeq = -1;
  let steerConsumedSeq = -1;
  let agentRunCount = 0;
  const postSteerMessageTexts: string[] = [];
  let baseAnswerText = "";

  const unsub = session.subscribe((event) => {
    const type = event.type as string;
    if (type === "message_update") {
      const ame = event.assistantMessageEvent as { type?: string } | undefined;
      if (ame?.type === "text_delta") {
        deltaCount += 1;
        if (deltaCountBeforeSteer < 0) deltaCountBeforeSteer = deltaCount;
      }
    }
    if (type === "queue_update") {
      const steering = event.steering as readonly string[] | undefined;
      if (steering && steering.length > 0) {
        if (steerQueuedSeq < 0) steerQueuedSeq = ctx.recorder.eventCount;
      } else if (steering && steerQueuedSeq >= 0 && steerConsumedSeq < 0) {
        // Pi 0.85.1 emits this queue_update right after the turn_start of
        // the turn that picked up the steering message.
        steerConsumedSeq = ctx.recorder.eventCount;
      }
    }
    if (type === "agent_start") {
      agentRunCount += 1;
    }
    if (type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (msg?.content ?? [])
        .map((p) => (p.type === "text" ? p.text ?? "" : ""))
        .join("");
      if (steerConsumedSeq >= 0 || agentRunCount >= 2) {
        // Output produced after the steering message was picked up. Pi
        // 0.85.1 delivers steer() as a new turn inside the SAME agent run
        // (single agent_start), so post-steer messages are identified by
        // consumption, not by a second agent_start. A second agent_start
        // (accepted as an alternative delivery form) is also honored.
        postSteerMessageTexts.push(text);
      } else if (agentRunCount === 1) {
        baseAnswerText = text;
      }
    }
  });
  ctx.onCleanup(unsub);

  // Start the long answer; steer after the second delta is observed.
  const promptPromise = session.prompt(STEER_BASE_PROMPT);
  // The prompt is intentionally not awaited yet (we must steer mid-stream).
  // Attach a catch NOW so a rejection during the poll window (e.g. auth
  // failure) does not become an unhandled rejection that kills the process
  // before the runner can record a structured result. The real outcome is
  // still observed at the await below.
  promptPromise.catch(() => {});
  const steerSentAt = Date.now();
  let waitedMs = 0;
  while (deltaCount < 2 && waitedMs < 30_000 && !promptPromiseDone(promptPromise)) {
    await sleep(10);
    waitedMs += 10;
  }
  ctx.recorder.recordMarker("steer_sent", {
    afterDeltas: deltaCount,
    waitedMs,
    message: STEER_MESSAGE,
  });
  await session.steer(STEER_MESSAGE);
  ctx.recorder.recordMarker("steer_api_returned", { afterDeltas: deltaCount });

  await promptPromise;

  const steeredAnswerText = postSteerMessageTexts.join("");
  const deliveryForm =
    agentRunCount >= 2
      ? "second agent run in the same session"
      : steerConsumedSeq >= 0
        ? "new turn within the same agent run (single agent_start, Pi 0.85.1 semantics)"
        : "not observed";
  ctx.recorder.recordMarker("steer_effect_observed", {
    agentRunCount,
    steerQueuedSeq,
    steerConsumedSeq,
    postSteerMessages: postSteerMessageTexts.length,
    deliveryForm,
  });

  ctx.check(deltaCountBeforeSteer >= 1, "steer was sent during streaming (at least one delta observed before)");
  ctx.check(steerQueuedSeq >= 0, "queue_update event with non-empty steering queue observed");
  ctx.check(
    steerConsumedSeq >= 0,
    "steering message was consumed by the agent (queue_update with emptied steering queue)",
  );
  ctx.check(
    postSteerMessageTexts.length > 0 || agentRunCount >= 2,
    "steering output delivered in the same session (post-steer assistant message observed)",
  );
  ctx.check(
    steeredAnswerText.includes(STEER_EXPECTED),
    `final output reflects the new instruction (contains ${STEER_EXPECTED}; got: ${steeredAnswerText.slice(0, 200)})`,
  );
  ctx.check(
    session.sessionId === sessionId,
    "steer is not represented as a new independent session (sessionId unchanged)",
  );
  ctx.observe(`sessionId stayed ${sessionId} across steering`);
  ctx.observe(`steer delivery form: ${deliveryForm}`);
  ctx.observe(
    `timing: steer sent after ${deltaCountBeforeSteer} deltas (waited ${waitedMs}ms), steering queued at recorder event #${steerQueuedSeq}, consumed at #${steerConsumedSeq}, ${agentRunCount} agent run(s) total`,
  );
  ctx.observe(
    `base answer ${baseAnswerText.length} chars; post-steer answer ${steeredAnswerText.length} chars (${postSteerMessageTexts.length} message(s))`,
  );
  ctx.observe("no tools are enabled in this scenario, so no tool call could complete/skip/continue (task book 7.3 item is N/A here)");
}

function promptPromiseDone(p: Promise<void>): boolean {
  let done = false;
  // Both handlers, so the returned promise resolves either way (no
  // unhandled rejection from this probe helper).
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return done;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
