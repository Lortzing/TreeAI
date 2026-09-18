/**
 * Scenario dispatch shared by the real CLI (src/run.ts) and tests.
 */

import type { ScenarioContext } from "../runner.js";
import type { ProbeSessionFactory, ResumeChildRunner, ScenarioName } from "../types.js";
import { runBasicScenario, type ScenarioDeps } from "./basic.js";
import { runToolScenario } from "./tool.js";
import { runSteerScenario } from "./steer.js";
import { runAbortScenario } from "./abort.js";
import { runResumeScenario } from "./resume.js";

export interface AllScenarioDeps extends ScenarioDeps {
  childRunner: ResumeChildRunner;
}

export async function executeScenario(
  scenario: ScenarioName,
  ctx: ScenarioContext,
  deps: AllScenarioDeps,
): Promise<void> {
  switch (scenario) {
    case "basic":
      return runBasicScenario(ctx, deps);
    case "tool":
      return runToolScenario(ctx, deps);
    case "steer":
      return runSteerScenario(ctx, deps);
    case "abort":
      return runAbortScenario(ctx, deps);
    case "resume":
      return runResumeScenario(ctx, deps.childRunner);
  }
}
