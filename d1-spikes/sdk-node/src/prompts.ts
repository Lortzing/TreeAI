/**
 * TreeAI D1 spike - canonical scenario prompts and expected values.
 *
 * These strings are the single source of truth for the SDK probe. Agent C
 * (rpc-python) must use byte-identical prompts and fixture values for a
 * fair SDK/RPC comparison (task book section 5). Synchronisation across
 * implementations is tracked as PENDING_OWNER in limitations.
 */

import type { ProbeScenarioName } from "./types.js";

export const FIXTURE_FILE = "numbers.json";
export const FIXTURE_COUNT = 16;
export const FIXTURE_SUM = 80;
export const FIXTURE_MIN = 1;
export const FIXTURE_MAX = 9;
export const FIXTURE_MEDIAN = 5;
export const BASIC_PROMPT = "What is 17 + 25? Reply with just the number, nothing else.";
export const BASIC_EXPECTED = "42";

export const TOOL_PROMPT =
  'Read the file numbers.json in the current working directory using the read tool. ' +
  'Then answer with exactly five lines: first "COUNT=<number of values>", then "SUM=<sum of values>", ' +
  'then "MIN=<minimum value>", then "MAX=<maximum value>", then "MEDIAN=<median value>". No other text.';

export const TOOL_MISSING_FILE_PROMPT =
  "Read the file definitely-missing-9b1c.json in the current working directory using the read tool, " +
  "then briefly state that the file could not be read.";

export const STEER_BASE_PROMPT =
  "List the numbers from 1 to 20, one per line, each followed by one short sentence about the number.";
export const STEER_MESSAGE =
  "NEW INSTRUCTION: Stop listing numbers. Reply with exactly the word STEERED-OK and nothing else.";
export const STEER_EXPECTED = "STEERED-OK";

export const ABORT_PROMPT =
  "List the numbers from 1 to 50, one per line, each followed by one sentence about the number.";
export const ABORT_POST_PROMPT = "What is 2 + 3? Reply with just the number, nothing else.";
export const ABORT_POST_EXPECTED = "5";
/** Task book 7.4: abort must settle within 60 seconds. */
export const ABORT_SETTLE_BUDGET_MS = 60_000;

export const RESUME_PROMPT_A =
  "Please remember this passphrase for later: TREEAI-RESUME-9c4e. Reply with just ACK.";
export const RESUME_PROMPT_B =
  "What passphrase did I ask you to remember earlier in this session? Reply with just the passphrase.";
export const RESUME_EXPECTED = "TREEAI-RESUME-9c4e";

/**
 * Tree/navigation architecture probe (owner closure follow-up 2026-09-20;
 * separate from the five unified scenarios). Three model turns: a memorable
 * passphrase, an unrelated second turn (the branch to abandon), then after
 * navigateTree() back to turn 1 a recall prompt that only succeeds if the
 * post-navigation context follows the target branch.
 */
export const TREE_NAV_PROMPT_A =
  "Please remember this passphrase for later: TREEAI-TREENAV-b7f2. Reply with just ACK.";
export const TREE_NAV_PROMPT_B = "What is 6 + 7? Reply with just the number, nothing else.";
export const TREE_NAV_PROMPT_C =
  "What passphrase did I ask you to remember earlier in this session? Reply with just the passphrase.";
export const TREE_NAV_EXPECTED = "TREEAI-TREENAV-b7f2";

/** Thinking level used by every scenario (recorded in environment.json). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ProbeThinkingLevel = (typeof THINKING_LEVELS)[number];

export function parseThinkingLevel(value: string | undefined): ProbeThinkingLevel {
  const v = (value ?? "off") as ProbeThinkingLevel;
  if (!THINKING_LEVELS.includes(v)) {
    throw new Error(`Invalid thinking level ${String(value)}; expected one of ${THINKING_LEVELS.join("|")}`);
  }
  return v;
}

export const PROBE_THINKING_LEVEL: ProbeThinkingLevel = parseThinkingLevel(process.env.PI_PROBE_THINKING);

/** Default total timeout per scenario unless overridden. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.PI_PROBE_TIMEOUT_MS ?? 180_000);

export function scenarioCommand(scenario: ProbeScenarioName | "all"): string {
  return `npm run --prefix d1-spikes/sdk-node probe:${scenario === "all" ? "all" : scenario}`;
}
