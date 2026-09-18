/**
 * Scenario: basic (task book 7.1).
 * Create a session, send a fixed question to a fixed model, receive the
 * full streamed answer. Run three times consecutively; each run must end.
 */

import type { ScenarioContext } from "../runner.js";
import type { ProbeSessionFactory } from "../types.js";
import { prepareFixtureCwd } from "../fixture.js";
import { BASIC_EXPECTED, BASIC_PROMPT } from "../prompts.js";
import type { PreparedFixture } from "../fixture.js";

export interface ScenarioDeps {
  createSession: ProbeSessionFactory;
}

interface SubRunObservation {
  run: number;
  deltas: string[];
  events: string[];
  stopReason: string | undefined;
  finalText: string | undefined;
  durationMs: number;
}

export async function runBasicScenario(
  ctx: ScenarioContext,
  deps: ScenarioDeps,
): Promise<void> {
  const fixture: PreparedFixture = prepareFixtureCwd("treeai-d1-basic-");
  ctx.onCleanup(fixture.cleanup);
  if (fixture.source === "local-fallback") {
    ctx.limit("Fixture source is the local fallback (Agent D's shared fixtures/ not present yet).");
  }
  ctx.observe(`fixture cwd: ${fixture.cwd} (temp copy, source=${fixture.source})`);

  const subRuns: SubRunObservation[] = [];

  for (let run = 1; run <= 3; run++) {
    const session = await deps.createSession.create({ cwd: fixture.cwd, persist: false, tools: "none" });
    ctx.recorder.setSessionId(session.sessionId);
    ctx.recorder.recordMarker("subrun_start", { run });

    const deltas: string[] = [];
    const events: string[] = [];
    let stopReason: string | undefined;
    let finalText: string | undefined;

    const unsubscribe = session.subscribe((event) => {
      const type = event.type as string;
      // Every raw Pi event goes into the evidence stream (task book 6.1).
      ctx.recorder.record(type, event);
      if (type === "message_update") {
        const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          deltas.push(ame.delta);
        }
      }
      if (type === "message_end") {
        const msg = event.message as
          | { stopReason?: string; content?: Array<{ type?: string; text?: string }> }
          | undefined;
        stopReason = msg?.stopReason;
        finalText = (msg?.content ?? [])
          .map((p) => (p.type === "text" ? p.text ?? "" : ""))
          .join("");
      }
    });
    ctx.onCleanup(unsubscribe);
    ctx.onCleanup(() => session.dispose());

    const t0 = Date.now();
    try {
      await session.prompt(BASIC_PROMPT);
    } catch (err) {
      ctx.recorder.recordError(err, { run });
      throw err;
    }
    const durationMs = Date.now() - t0;
    subRuns.push({ run, deltas, events, stopReason, finalText, durationMs });
    ctx.recorder.recordMarker("subrun_end", { run, durationMs, deltaCount: deltas.length });
  }

  for (const r of subRuns) {
    const streamed = r.deltas.join("");
    ctx.check(r.deltas.length > 0, `run${r.run}: observed text_delta events`);
    ctx.check(
      r.stopReason !== undefined && r.stopReason !== "",
      `run${r.run}: observed finish/stop reason (${String(r.stopReason)})`,
    );
    ctx.check(
      r.finalText !== undefined && r.finalText.length > 0,
      `run${r.run}: final assistant text present`,
    );
    ctx.check(
      streamed === r.finalText,
      `run${r.run}: streamed deltas concatenate to final text without duplication or loss (streamed ${streamed.length} chars vs final ${r.finalText?.length ?? 0})`,
    );
    ctx.check(
      (r.finalText ?? "").includes(BASIC_EXPECTED),
      `run${r.run}: answer contains expected value ${BASIC_EXPECTED}`,
    );
    ctx.observe(
      `run${r.run}: ${r.deltas.length} deltas, ${r.durationMs}ms, stopReason=${String(r.stopReason)}`,
    );
  }
  ctx.observe(
    `three consecutive sub-runs completed (durations: ${subRuns.map((r) => r.durationMs).join(", ")}ms)`,
  );
}
