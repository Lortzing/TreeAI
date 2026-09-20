/**
 * Scenario: tree-nav (owner closure follow-up, 2026-09-20; NOT one of the
 * five unified D1 scenarios and never part of probe:all).
 *
 * Verifies, in the IDLE state, in-place session-tree navigation through the
 * SDK's AgentSession.navigateTree(): switch from the current leaf (end of
 * turn 2) to an existing earlier entry (the assistant message of turn 1),
 * then continue prompting on the new branch.
 *
 * Recorded facts:
 * - sessionId preserved (same session; navigateTree stays in the same file,
 *   unlike fork());
 * - leaf/entryId changed to the target (pointer move, no new session);
 * - history preserved: the session tree is append-only - the abandoned
 *   turn-2 branch stays in memory AND in the persisted session file;
 * - the LLM context is rebuilt from the target branch (4 -> 2 messages) and
 *   a post-navigation prompt succeeds on the new branch;
 * - Pi 0.85.1 semantics for user-message targets: the leaf moves to the
 *   message's parent and the message text is returned as editorText.
 *
 * Honesty rules: if navigateTree is unavailable or behaves differently, the
 * scenario FAILs with structured evidence - it never fabricates a PASS.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runner.js";
import type { ScenarioDeps } from "./basic.js";
import type { ProbeTreeState } from "../types.js";
import { prepareFixtureCwd } from "../fixture.js";
import {
  TREE_NAV_EXPECTED,
  TREE_NAV_PROMPT_A,
  TREE_NAV_PROMPT_B,
  TREE_NAV_PROMPT_C,
} from "../prompts.js";

export async function runTreeNavScenario(ctx: ScenarioContext, deps: ScenarioDeps): Promise<void> {
  const fixture = prepareFixtureCwd("treeai-d1-tree-nav-");
  ctx.onCleanup(fixture.cleanup);
  if (fixture.source === "local-fallback") {
    ctx.limit("Fixture source is the local fallback (Agent D's shared fixtures/ not present yet).");
  }

  // Persisted session (like resume) so the append-only tree can also be
  // verified on disk. The store lives inside this scenario's evidence dir
  // and only ever contains the probe's own prompts/answers.
  const sessionDir = join(ctx.scenarioDir, "session-store");
  mkdirSync(sessionDir, { recursive: true });

  const session = await deps.createSession.create({
    cwd: fixture.cwd,
    persist: true,
    sessionDir,
    tools: "none",
  });
  const sessionIdBefore = session.sessionId;
  const sessionFileBefore = session.sessionFile;
  ctx.recorder.setSessionId(sessionIdBefore);

  // Evidence bridge: every raw Pi event -> events.jsonl (same as the five
  // scenarios). A second listener counts what navigateTree() itself emits.
  let navigationWindowOpen = false;
  const eventsDuringNavigation: string[] = [];
  let postNavStarted = false;
  let postNavAnswer = "";
  const unsub = session.subscribe((event) => {
    const type = event.type as string;
    ctx.recorder.record(type, event);
    if (navigationWindowOpen) eventsDuringNavigation.push(type);
    if (postNavStarted && type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      postNavAnswer = (msg?.content ?? [])
        .map((p) => (p.type === "text" ? p.text ?? "" : ""))
        .join("");
    }
  });
  ctx.onCleanup(unsub);
  ctx.onCleanup(() => session.dispose());

  ctx.recorder.recordMarker("scenario_layout", {
    sessionId: sessionIdBefore,
    sessionFile: sessionFileBefore ?? null,
    tools: "none",
    probe: "tree-nav (separate from the five unified scenarios)",
  });

  // --- Two completed turns: the branch that will be abandoned. ---
  const t0 = Date.now();
  await session.prompt(TREE_NAV_PROMPT_A);
  const turn1Ms = Date.now() - t0;
  ctx.recorder.recordMarker("turn1_done", { durationMs: turn1Ms });

  const t1 = Date.now();
  await session.prompt(TREE_NAV_PROMPT_B);
  const turn2Ms = Date.now() - t1;
  ctx.recorder.recordMarker("turn2_done", { durationMs: turn2Ms });

  ctx.check(sessionFileBefore !== undefined, "session is persisted (sessionFile defined)");
  const stateBefore = session.getTreeState();
  ctx.recorder.recordMarker("tree_state_before_navigation", slimTreeState(stateBefore));
  const usersBefore = messageEntriesOf(stateBefore, "user");
  const assistantsBefore = messageEntriesOf(stateBefore, "assistant");
  ctx.check(
    usersBefore.length === 2 && assistantsBefore.length === 2,
    `two completed turns produced exactly two user and two assistant message entries (u=${usersBefore.length}, a=${assistantsBefore.length})`,
  );
  ctx.check(
    session.isStreaming === false,
    "session is idle before navigateTree (isStreaming=false)",
  );
  ctx.check(stateBefore.contextMessageCount === 4, `LLM context before navigation holds all four turn messages (got ${stateBefore.contextMessageCount})`);

  if (usersBefore.length < 2 || assistantsBefore.length < 1) {
    // Structural precondition missing: fail loudly instead of navigating blind.
    throw new Error(
      `unexpected session structure after two turns: users=${usersBefore.length}, assistants=${assistantsBefore.length}`,
    );
  }

  // --- Navigation target: the assistant message entry of turn 1 (an
  // existing entry, non-user so the leaf lands exactly on it). ---
  const targetId = assistantsBefore[0]!.id;
  const user2Id = usersBefore[1]!.id;
  const leafBefore = stateBefore.leafId;
  const entriesBeforeIds = new Set(stateBefore.entries.map((e) => e.id));

  // --- Navigate #1: idle-state in-place tree navigation. ---
  eventsDuringNavigation.length = 0;
  navigationWindowOpen = true;
  let nav1: { cancelled: boolean; editorText?: string };
  try {
    nav1 = await session.navigateTree(targetId);
  } finally {
    navigationWindowOpen = false;
  }
  const stateAfterNav = session.getTreeState();
  ctx.recorder.recordMarker("navigate_tree_called", {
    targetId,
    targetKind: "assistant message entry of turn 1",
    result: nav1,
    agentEventsDuringNavigation: [...eventsDuringNavigation],
    stateAfter: slimTreeState(stateAfterNav),
  });

  ctx.check(nav1.cancelled === false, "navigateTree(targetId) resolved with cancelled=false");
  ctx.check(
    stateAfterNav.leafId === targetId && leafBefore !== targetId,
    `leaf pointer moved to the target entry (entryId changed: ${String(leafBefore)} -> ${String(stateAfterNav.leafId)})`,
  );
  ctx.check(
    session.sessionId === sessionIdBefore,
    "sessionId preserved across navigateTree (no new session)",
  );
  ctx.check(
    sessionFileBefore !== undefined &&
      session.sessionFile !== undefined &&
      session.sessionFile === sessionFileBefore,
    "navigation stayed in the same session file (no new file, unlike fork)",
  );
  ctx.check(
    stateAfterNav.entries.length === stateBefore.entries.length &&
      stateAfterNav.entries.every((e) => entriesBeforeIds.has(e.id)),
    `navigation appended and removed nothing: same ${stateAfterNav.entries.length} entries (append-only tree, pointer move only)`,
  );
  ctx.check(
    stateAfterNav.contextMessageCount === 2,
    `LLM context rebuilt from the target branch (4 -> ${stateAfterNav.contextMessageCount} messages; turn-2 branch no longer in context)`,
  );

  // --- Navigate #2: user-message target semantics (re-edit form). ---
  const nav2 = await session.navigateTree(user2Id);
  const stateAfterNav2 = session.getTreeState();
  ctx.recorder.recordMarker("navigate_tree_user_target", {
    targetId: user2Id,
    targetKind: "user message entry of turn 2",
    result: nav2,
    stateAfter: slimTreeState(stateAfterNav2),
  });
  ctx.check(nav2.cancelled === false, "navigateTree(userMessageEntry) resolved with cancelled=false");
  ctx.check(
    nav2.editorText === TREE_NAV_PROMPT_B,
    `user-message target returns the message text as editorText (re-edit semantics; got: ${String(nav2.editorText).slice(0, 80)})`,
  );
  ctx.check(
    stateAfterNav2.leafId === targetId,
    `user-message target moves the leaf to the message's parent, not the message itself (leaf=${stateAfterNav2.leafId})`,
  );

  // --- Post-navigation prompt on the new branch. ---
  postNavStarted = true;
  const t2 = Date.now();
  await session.prompt(TREE_NAV_PROMPT_C);
  const turn3Ms = Date.now() - t2;
  ctx.recorder.recordMarker("post_navigation_prompt_done", {
    durationMs: turn3Ms,
    answer: postNavAnswer,
  });

  const stateFinal = session.getTreeState();
  ctx.recorder.recordMarker("tree_state_final", slimTreeState(stateFinal));

  ctx.check(
    postNavAnswer.includes(TREE_NAV_EXPECTED),
    `post-navigation prompt succeeded on the new branch; answer recalls the turn-1 passphrase (got: ${postNavAnswer.slice(0, 200)})`,
  );
  ctx.check(
    session.sessionId === sessionIdBefore,
    "sessionId still preserved after the post-navigation prompt",
  );
  ctx.check(
    session.sessionFile !== undefined && session.sessionFile === sessionFileBefore,
    "session file still the same after the post-navigation prompt",
  );

  const finalIds = new Set(stateFinal.entries.map((e) => e.id));
  const abandonedStillPresent =
    entriesBeforeIds.size > 0 && [...entriesBeforeIds].every((id) => finalIds.has(id));
  ctx.check(
    abandonedStillPresent,
    "history preserved: every pre-navigation entry (including the abandoned turn-2 branch) is still present after the new prompt (append-only)",
  );
  const newEntries = stateFinal.entries.filter((e) => !entriesBeforeIds.has(e.id));
  ctx.check(
    newEntries.length === 2,
    `the post-navigation prompt appended exactly two entries on the new branch (got ${newEntries.length})`,
  );
  const childrenOfTarget = stateFinal.entries.filter((e) => e.parentId === targetId).map((e) => e.id);
  const newUserEntry = newEntries.find((e) => e.role === "user");
  ctx.check(
    newUserEntry !== undefined &&
      childrenOfTarget.includes(user2Id) &&
      childrenOfTarget.includes(newUserEntry.id),
    "tree fork visible: the turn-2 user entry and the new post-navigation user entry are siblings under the navigation target",
  );
  ctx.check(
    stateFinal.contextMessageCount === 4,
    `final LLM context follows the new branch (u1,a1,u3,a3 = 4 messages; got ${stateFinal.contextMessageCount})`,
  );

  // --- On-disk history preservation (persisted session file). ---
  if (sessionFileBefore === undefined || !existsSync(sessionFileBefore)) {
    ctx.check(false, `persisted session file exists for the on-disk history check (${String(sessionFileBefore)})`);
  } else {
    const fileIds = new Set<string>();
    let fileLines = 0;
    for (const line of readFileSync(sessionFileBefore, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      fileLines += 1;
      try {
        const parsed = JSON.parse(line) as { id?: string };
        if (typeof parsed.id === "string") fileIds.add(parsed.id);
      } catch {
        // header or non-JSON line; counted, not fatal
      }
    }
    const trackedIds = [...entriesBeforeIds, ...newEntries.map((e) => e.id)];
    const missingOnDisk = trackedIds.filter((id) => !fileIds.has(id));
    ctx.check(
      missingOnDisk.length === 0,
      `persisted session file retains all ${trackedIds.length} tracked entry ids on disk (missing: ${missingOnDisk.join(",") || "none"}; ${fileLines} lines)`,
    );
  }

  // --- Observations (architecture facts, no pass/fail preference). ---
  ctx.observe(
    eventsDuringNavigation.length === 0
      ? "navigateTree emitted no AgentSessionEvent on the subscribe() stream (Pi 0.85.1 emits session_tree only to extensions); hosts must read tree state from the return value or SessionManager after navigating"
      : `navigateTree emitted ${eventsDuringNavigation.length} event(s) on the subscribe() stream: ${eventsDuringNavigation.join(", ")}`,
  );
  ctx.observe(
    `leaf transition: ${String(leafBefore)} -> ${targetId} (assistant message of turn 1); context 4 -> 2 -> 4 messages after the post-navigation prompt`,
  );
  ctx.observe(
    `turn durations: turn1=${turn1Ms}ms, turn2=${turn2Ms}ms, post-navigation=${turn3Ms}ms; sessionId=${sessionIdBefore} throughout`,
  );
  ctx.observe(
    "navigateTree options (summarize/label) were not exercised: they trigger an extra summarizer model call and are outside this minimal probe (PENDING_OWNER scope)",
  );
  ctx.limit(
    "tree-nav is an architecture probe separate from the five unified D1 scenarios: its evidence lives under evidence/sdk/tree-nav/ and is not mixed into the five-scenario results; the shared schemas' scenario enum does not cover it (PENDING_OWNER whether to extend the shared contract).",
  );
  ctx.limit(
    "Only idle-state navigation was verified; navigateTree's documented mid-stream rejection and branch summarization were not exercised (see research/pi-capability-inventory.md section 6.6).",
  );
}

function slimTreeState(state: ProbeTreeState): {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  messageEntries: Array<{ id: string; parentId: string | null; role: string }>;
  contextMessageCount: number;
} {
  return {
    sessionId: state.sessionId,
    leafId: state.leafId,
    entryCount: state.entries.length,
    messageEntries: state.entries
      .filter((e) => e.type === "message" && typeof e.role === "string")
      .map((e) => ({ id: e.id, parentId: e.parentId, role: e.role! })),
    contextMessageCount: state.contextMessageCount,
  };
}

function messageEntriesOf(
  state: ProbeTreeState,
  role: "user" | "assistant",
): Array<{ id: string; parentId: string | null; role: string }> {
  return state.entries
    .filter((e) => e.type === "message" && e.role === role)
    .map((e) => ({ id: e.id, parentId: e.parentId, role: e.role! }));
}
