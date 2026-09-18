/**
 * Scenario: tool (task book 7.2).
 * The agent must read the fixture file numbers.json via the read tool and
 * answer a verification question. Tool whitelist is read-only. Also checks
 * the error path: reading a missing file must produce a clear failure
 * state, not a silent success.
 */

import { readFileSync } from "node:fs";
import type { ScenarioContext } from "../runner.js";
import type { ScenarioDeps } from "./basic.js";
import { prepareFixtureCwd } from "../fixture.js";
import {
  FIXTURE_FILE,
  FIXTURE_MARKER,
  FIXTURE_SUM,
  TOOL_MISSING_FILE_PROMPT,
  TOOL_PROMPT,
} from "../prompts.js";
import { isAbsolute, resolve } from "node:path";

export async function runToolScenario(ctx: ScenarioContext, deps: ScenarioDeps): Promise<void> {
  const fixture = prepareFixtureCwd("treeai-d1-tool-");
  ctx.onCleanup(fixture.cleanup);
  if (fixture.source === "local-fallback") {
    ctx.limit("Fixture source is the local fallback (Agent D's shared fixtures/ not present yet).");
  }

  // Ground truth from the fixture copy itself (what the agent should return).
  const fixtureJson = JSON.parse(readFileSync(fixture.fixturePath, "utf8")) as {
    marker: string;
    sum: number;
  };
  ctx.check(
    fixtureJson.marker === FIXTURE_MARKER && fixtureJson.sum === FIXTURE_SUM,
    "fixture ground truth matches expected marker/sum",
  );

  const session = await deps.createSession.create({ cwd: fixture.cwd, persist: false, tools: "read-only" });
  ctx.recorder.setSessionId(session.sessionId);
  // Evidence bridge: every raw Pi event is recorded to events.jsonl.
  const unsubscribe = session.subscribe((event) => {
    ctx.recorder.record(event.type as string, event);
  });
  ctx.onCleanup(unsubscribe);
  ctx.onCleanup(() => session.dispose());

  interface ToolObs {
    toolName: string | undefined;
    argsPath: string | undefined;
    isError: boolean | undefined;
  }
  let firstTool: ToolObs | undefined;
  let missingFileTool: ToolObs | undefined;
  let sawToolStart = false;
  let finalText = "";
  let missingFileFinalText = "";
  let turn = 0;

  const unsub2 = session.subscribe((event) => {
    const type = event.type as string;
    if (type === "agent_start") turn += 1;
    if (type === "tool_execution_start") {
      sawToolStart = true;
      const obs: ToolObs = {
        toolName: event.toolName as string | undefined,
        argsPath: (event.args as { path?: string } | undefined)?.path,
        isError: undefined,
      };
      if (turn === 1) firstTool = { ...obs };
      if (turn === 2) missingFileTool = { ...obs };
    }
    if (type === "tool_execution_end") {
      const err = event.isError as boolean | undefined;
      if (turn === 1 && firstTool) firstTool = { ...firstTool, isError: err };
      if (turn === 2 && missingFileTool) missingFileTool = { ...missingFileTool, isError: err };
    }
    if (type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (msg?.content ?? [])
        .map((p) => (p.type === "text" ? p.text ?? "" : ""))
        .join("");
      if (turn === 1) finalText = text;
      if (turn === 2) missingFileFinalText = text;
    }
  });
  ctx.onCleanup(unsub2);

  // Turn 1: read the fixture and report marker + sum.
  await session.prompt(TOOL_PROMPT);

  ctx.check(sawToolStart, "observed tool_execution_start");
  ctx.check(firstTool?.toolName === "read", `tool name is "read" (got ${String(firstTool?.toolName)})`);
  ctx.check(
    firstTool?.isError === false,
    `tool_execution_end for fixture read is not an error (isError=${String(firstTool?.isError)})`,
  );
  const requestedPath = firstTool?.argsPath;
  if (requestedPath !== undefined) {
    const resolved = isAbsolute(requestedPath) ? requestedPath : resolve(fixture.cwd, requestedPath);
    ctx.check(
      resolved.startsWith(fixture.cwd + "/") || resolved === fixture.cwd,
      `tool only accessed the fixture temp copy (requested ${requestedPath})`,
    );
  } else {
    ctx.check(false, "tool args contained a path to inspect");
  }
  ctx.check(
    finalText.includes(`MARKER=${FIXTURE_MARKER}`),
    `answer reports MARKER=${FIXTURE_MARKER} (answer: ${finalText.slice(0, 200)})`,
  );
  ctx.check(
    finalText.includes(`SUM=${String(FIXTURE_SUM)}`),
    `answer reports SUM=${FIXTURE_SUM}`,
  );

  // Turn 2: error path - reading a missing file must be a clear failure.
  ctx.recorder.recordMarker("error_path_start", { prompt: TOOL_MISSING_FILE_PROMPT });
  await session.prompt(TOOL_MISSING_FILE_PROMPT);

  ctx.check(
    missingFileTool?.toolName === "read",
    "error path: read tool was invoked for the missing file",
  );
  ctx.check(
    missingFileTool?.isError === true,
    `error path: tool_execution_end reports isError=true (got ${String(missingFileTool?.isError)})`,
  );
  ctx.check(
    /could not|not be read|no such|error|unable|missing|does not exist/i.test(missingFileFinalText),
    `error path: assistant states the file could not be read (answer: ${missingFileFinalText.slice(0, 200)})`,
  );
  ctx.observe(`fixture content verified through tool round-trip (${FIXTURE_FILE})`);
}
