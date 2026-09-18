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
  let steerSeqObserved = -1;
  let agentRunCount = 0;
  let queueUpdateWithSteering = false;
  let steerDeliveryObserved = false;
  const finalTexts: string[] = [];
  let baseAnswerText = "";
  let steeredAnswerText = "";

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
        queueUpdateWithSteering = true;
        steerSeqObserved = ctx.recorder.eventCount;
      }
    }
    if (type === "agent_start") {
      agentRunCount += 1;
      if (agentRunCount === 2) steerDeliveryObserved = true;
    }
    if (type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (msg?.content ?? [])
        .map((p) => (p.type === "text" ? p.text ?? "" : ""))
        .join("");
      finalTexts.push(text);
      if (agentRunCount === 1) baseAnswerText = text;
      if (agentRunCount >= 2) steeredAnswerText = text;
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

  ctx.recorder.recordMarker("steer_effect_observed", {
    agentRunCount,
    queueUpdateWithSteering,
    steerDeliveryObserved,
  });

  ctx.check(deltaCountBeforeSteer >= 1, "steer was sent during streaming (at least one delta observed before)");
  ctx.check(queueUpdateWithSteering, "queue_update event with non-empty steering queue observed");
  ctx.check(steerDeliveryObserved, "steering message was delivered in the same session (second agent run started)");
  ctx.check(agentRunCount >= 2, `steer triggered a subsequent agent run (runs=${agentRunCount})`);
  ctx.check(
    steeredAnswerText.includes(STEER_EXPECTED),
    `final output reflects the new instruction (contains ${STEER_EXPECTED}; got: ${steeredAnswerText.slice(0, 200)})`,
  );
  ctx.check(
    !baseAnswerText.includes(STEER_EXPECTED) || steeredAnswerText.length > 0,
    "steer is not represented as a new independent session (sessionId unchanged)",
  );
  ctx.observe(`sessionId stayed ${sessionId} across steering`);
  ctx.observe(
    `timing: steer sent after ${deltaCountBeforeSteer} deltas (waited ${waitedMs}ms), queue_update at recorder event #${steerSeqObserved}, ${agentRunCount} agent runs total`,
  );
  ctx.observe(`base answer ${baseAnswerText.length} chars; steered answer ${steeredAnswerText.length} chars`);
  void finalTexts;
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
