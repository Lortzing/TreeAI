/**
 * Tree-nav scenario tests (scripted fake sessions; no network, no
 * credentials). Covers: the full idle-state navigation flow -> PASS, honest
 * FAIL paths (navigateTree unavailable, wrong post-navigation answer), the
 * fake's navigateTree semantics mirroring Pi 0.85.1, evidence separation
 * from the five unified scenarios, and local validation of tree-nav
 * evidence. All writes go to temp dirs, never to d1-spikes/evidence/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "../src/runner.js";
import { runTreeNavScenario } from "../src/scenarios/tree-nav.js";
import {
  FakeProbeSession,
  createFakeSessionFactory,
  sleep,
  type FakeTurnScript,
} from "../src/fake-session.js";
import { validateEventFile } from "../src/validate.js";
import {
  PROBE_SCENARIO_NAMES,
  SCENARIOS,
  TREE_NAV_SCENARIO,
  type ProbeSessionLike,
  type ProbeSessionFactory,
} from "../src/types.js";
import { TREE_NAV_EXPECTED, TREE_NAV_PROMPT_A } from "../src/prompts.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-tree-nav-"));
}

/**
 * Explicit delegating wrapper (spread would lose prototype methods/getters):
 * keeps every ProbeSessionLike member on the fake, replacing navigateTree.
 */
function withNavigateTree(
  base: FakeProbeSession,
  fn: (targetId: string) => Promise<{ cancelled: boolean; editorText?: string }>,
): ProbeSessionLike {
  return {
    sessionId: base.sessionId,
    get sessionFile() {
      return base.sessionFile;
    },
    get isStreaming() {
      return base.isStreaming;
    },
    subscribe: (l) => base.subscribe(l),
    prompt: (t, o) => base.prompt(t, o),
    steer: (t) => base.steer(t),
    followUp: (t) => base.followUp(t),
    abort: () => base.abort(),
    dispose: () => base.dispose(),
    navigateTree: fn,
    getTreeState: () => base.getTreeState(),
    getHistorySummary: () => base.getHistorySummary(),
  };
}

const TREE_NAV_SCRIPTS: FakeTurnScript[] = [
  { answer: "ACK", deltaCount: 2 },
  { answer: "13", deltaCount: 2 },
  { answer: TREE_NAV_EXPECTED, deltaCount: 3 },
];

async function runFakeTreeNav(factory: ProbeSessionFactory) {
  const runDir = tmpRunDir();
  return runScenario({
    scenario: TREE_NAV_SCENARIO,
    command: "test",
    timeoutMs: 20_000,
    runDir,
    exec: async (ctx) => {
      await runTreeNavScenario(ctx, { createSession: factory });
    },
  });
}

test("tree-nav: idle navigation, context rebuild, post-nav prompt, history preserved -> PASS", async () => {
  const result = await runFakeTreeNav(createFakeSessionFactory(TREE_NAV_SCRIPTS));
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.equal(result.exitCode, 0);
  assert.ok(result.observations.some((o) => o.includes("leaf pointer moved to the target entry")));
  assert.ok(result.observations.some((o) => o.includes("sessionId preserved")));
  assert.ok(
    result.observations.some((o) =>
      o.includes("every pre-navigation entry") || o.includes("history preserved"),
    ),
    "history-preservation check visible in observations",
  );
});

test("tree-nav: evidence stays in its own tree-nav scenario dir and validates locally", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: TREE_NAV_SCENARIO,
    command: "test",
    timeoutMs: 20_000,
    runDir,
    exec: async (ctx) => {
      await runTreeNavScenario(ctx, { createSession: createFakeSessionFactory(TREE_NAV_SCRIPTS) });
    },
  });
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  // Scenario evidence lives under <runDir>/tree-nav/ (runner convention).
  const eventsPath = join(runDir, "tree-nav", "events.jsonl");
  assert.ok(existsSync(eventsPath));
  assert.ok(existsSync(join(runDir, "tree-nav", "result.json")));
  const v = validateEventFile(eventsPath);
  assert.equal(v.ok, true, v.errors.join("; "));
  const raw = readFileSync(eventsPath, "utf8");
  assert.ok(raw.includes('"scenario":"tree-nav"'));
  assert.ok(raw.includes("navigate_tree_called"), "navigation marker recorded");
  assert.ok(raw.includes(TREE_NAV_PROMPT_A.slice(0, 20)), "prompt text visible in events");
});

test("tree-nav: navigateTree unavailable -> honest FAIL with structured error, evidence kept", async () => {
  const factory: ProbeSessionFactory = {
    async create(options) {
      const base = (await createFakeSessionFactory(TREE_NAV_SCRIPTS).create(options)) as FakeProbeSession;
      return withNavigateTree(base, async () => {
        throw new Error("navigateTree is not a function (SDK API unavailable)");
      });
    },
  };
  const result = await runFakeTreeNav(factory);
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 1);
  assert.match(result.error?.message ?? "", /navigateTree is not a function/);
  assert.ok(result.evidenceFiles.length > 0, "FAIL still references evidence files");
});

test("tree-nav: post-navigation answer wrong -> FAIL on the recall check (no fake PASS)", async () => {
  const scripts: FakeTurnScript[] = [
    { answer: "ACK", deltaCount: 2 },
    { answer: "13", deltaCount: 2 },
    { answer: "I do not remember any passphrase.", deltaCount: 3 },
  ];
  const result = await runFakeTreeNav(createFakeSessionFactory(scripts));
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("recalls the turn-1 passphrase")));
});

test("tree-nav: editorText mismatch (user-message target semantics broken) -> FAIL", async () => {
  const factory: ProbeSessionFactory = {
    async create(options) {
      const base = (await createFakeSessionFactory(TREE_NAV_SCRIPTS).create(options)) as FakeProbeSession;
      const inner = base.navigateTree.bind(base);
      return withNavigateTree(base, async (targetId) => {
        const r = await inner(targetId);
        return { cancelled: r.cancelled, editorText: r.editorText !== undefined ? "wrong text" : undefined };
      });
    },
  };
  const result = await runFakeTreeNav(factory);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("editorText")));
});

test("fake navigateTree mirrors Pi semantics: leaf move, no-op, not found, streaming reject", async () => {
  const session = new FakeProbeSession([
    { answer: "one", deltaCount: 2 },
    { answer: "two", deltaCount: 2 },
  ]);
  await session.prompt("q1");
  await session.prompt("q2");

  const before = session.getTreeState();
  assert.equal(before.contextMessageCount, 4);
  const u1 = before.entries.filter((e) => e.role === "user")[0]!;
  const a1 = before.entries.filter((e) => e.role === "assistant")[0]!;
  const u2 = before.entries.filter((e) => e.role === "user")[1]!;

  // Non-user target: leaf lands exactly on the target.
  const nav1 = await session.navigateTree(a1.id);
  assert.equal(nav1.cancelled, false);
  assert.equal(nav1.editorText, undefined);
  assert.equal(session.getTreeState().leafId, a1.id);
  assert.equal(session.getTreeState().contextMessageCount, 2);

  // User-message target: leaf moves to the parent, text comes back.
  const nav2 = await session.navigateTree(u2.id);
  assert.equal(nav2.cancelled, false);
  assert.equal(nav2.editorText, "q2");
  assert.equal(session.getTreeState().leafId, a1.id);

  // No-op when already at the target.
  const nav3 = await session.navigateTree(a1.id);
  assert.deepEqual(nav3, { cancelled: false });
  assert.equal(session.getTreeState().leafId, a1.id);

  // Unknown entry id rejects.
  await assert.rejects(session.navigateTree("missing-entry"), /not found/);

  // Navigation while streaming rejects (idle-state only, Pi 0.85.1).
  // The fake sets streamingFlag synchronously before its first await, so a
  // short poll is enough (the scripted turn finishes in ~25ms).
  const p = session.prompt("long");
  p.catch(() => {});
  for (let i = 0; i < 50 && !session.isStreaming; i++) {
    await sleep(2);
  }
  assert.equal(session.isStreaming, true);
  await assert.rejects(
    session.navigateTree(u1.id),
    /Wait for the current response to finish before navigating/,
  );
  await session.abort();
  await p;
  session.dispose();
});

test("tree-nav stays separate from the five unified scenarios", () => {
  // The five unified scenarios never include tree-nav...
  assert.equal((SCENARIOS as readonly string[]).includes(TREE_NAV_SCENARIO), false);
  assert.deepEqual([...SCENARIOS], ["basic", "tool", "steer", "abort", "resume"]);
  // ...while the probe can still record it (local validation accepts it).
  assert.deepEqual([...PROBE_SCENARIO_NAMES], [
    "basic",
    "tool",
    "steer",
    "abort",
    "resume",
    "tree-nav",
  ]);
  // The tree-nav entry writes under evidence/sdk/tree-nav/, never runs/.
  const entry = readFileSync(join(import.meta.dirname, "..", "src", "tree-nav-run.ts"), "utf8");
  assert.ok(entry.includes('"tree-nav"'));
  assert.ok(entry.includes('join(evidenceDir, "tree-nav", "runs"'));
  // The five-scenario entry point does not mention tree-nav at all.
  const runTs = readFileSync(join(import.meta.dirname, "..", "src", "run.ts"), "utf8");
  assert.equal(runTs.includes("tree-nav"), false);
});
