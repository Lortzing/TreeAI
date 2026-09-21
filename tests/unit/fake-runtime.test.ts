/**
 * Unit tests for FakePiRuntime — the offline test double for the frozen
 * PiRuntime contract. These tests document-and-enforce the exact semantics
 * the e2e and live-scenario suites rely on (and that the real runtime-pi
 * package must exhibit once Wave 1 delivers it).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakePiRuntime, TreeAIErrorShape, type FakeRuntimeOptions } from "../support/fake-pi-runtime.ts";
import { EventRecorder } from "../support/harness.ts";
import type { PiEntryId, PiSessionId, PiVersion } from "@treeai/contracts";

/** Brand helpers: the fake consumes real SessionReference shapes. */
function entryId(s: string): PiEntryId {
  return s as PiEntryId;
}
function sessionIdBrand(s: string): PiSessionId {
  return s as PiSessionId;
}
function versionBrand(s: string): PiVersion {
  return s as PiVersion;
}

const MODEL = { providerId: "fake-provider", modelId: "fake-model" };

function newSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-fake-rt."));
}

function makeRuntime(sessionDir: string, options: FakeRuntimeOptions = {}): FakePiRuntime {
  return new FakePiRuntime({ sessionDir, model: MODEL, turnDelayMs: 1, ...options });
}

async function withRuntime(
  fn: (rt: FakePiRuntime, rec: EventRecorder, dir: string) => Promise<void>,
  options: FakeRuntimeOptions = {},
): Promise<void> {
  const dir = newSessionDir();
  const rt = makeRuntime(dir, options);
  const rec = new EventRecorder(rt);
  try {
    await fn(rt, rec, dir);
  } finally {
    await rt.dispose();
    rec.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createSession: session.created, reference fields, pinned version", async () => {
  await withRuntime(async (rt, rec) => {
    const snap = await rt.createSession({ model: MODEL });
    assert.equal(snap.reference.sessionId, "fake-session-1");
    assert.equal(snap.reference.entryId, "e0");
    assert.equal(snap.reference.piVersion, "0.85.1");
    assert.equal(snap.reference.availability.status, "available");
    assert.ok(snap.reference.sessionFile.endsWith(".treeai-fake-session.jsonl"));
    assert.equal(rec.countOf("session.created"), 1);
    assert.equal(rec.countOf("session.replaced"), 0);
    assert.equal(rt.piVersion, "0.85.1");
  });
});

test("prompt: single agent run with agent.started once and agent.settled once; entries appended", async () => {
  await withRuntime(async (rt, rec) => {
    await rt.createSession({ model: MODEL });
    const result = await rt.prompt({ text: "hello" });
    assert.ok(result.message.length > 0);
    assert.notEqual(result.reference.entryId, "e0");
    assert.equal(rec.countOf("agent.started"), 1);
    assert.equal(rec.countOf("agent.settled"), 1);
    assert.ok(rec.countOf("turn.started") >= 1);
    assert.ok(rec.countOf("message.completed") >= 1);
    assert.equal(rt.entryCount, 2); // user + assistant
    assert.equal(rec.checkSeqDiscipline().length, 0);
  });
});

test("steer during streaming: enqueued event, NEW TURN in the SAME agent run", async () => {
  // turnDelayMs 40 keeps the run reliably in flight across the 3ms wait
  // (with the 1ms default the turn chain can settle first — flaky under load).
  await withRuntime(async (rt, rec) => {
    await rt.createSession({ model: MODEL });
    const pending = rt.prompt({ text: "first" });
    // Wait until streaming has started.
    await new Promise((r) => setTimeout(r, 3));
    assert.equal(rt.isStreaming, true);
    await rt.steer({ text: "go left instead" });
    assert.equal(rec.countOf("steer.enqueued"), 1);
    const result = await pending;
    // Exactly ONE agent.started for the whole run (Pi 0.85.1 semantics).
    assert.equal(rec.countOf("agent.started"), 1);
    assert.equal(rec.countOf("agent.settled"), 1);
    // user + assistant + steer(user) + assistant
    assert.equal(rt.entryCount, 4);
    assert.ok(result.message.length > 0);
  }, { turnDelayMs: 40 });
});

test("steer without an in-flight run is a caller contract violation (TypeError)", async () => {
  await withRuntime(async (rt) => {
    await rt.createSession({ model: MODEL });
    await assert.rejects(() => rt.steer({ text: "x" }), TypeError);
  });
});

test("prompt while streaming is a caller contract violation (TypeError)", async () => {
  await withRuntime(async (rt) => {
    await rt.createSession({ model: MODEL });
    const pending = rt.prompt({ text: "one" });
    await new Promise((r) => setTimeout(r, 3));
    await assert.rejects(() => rt.prompt({ text: "two" }), TypeError);
    await pending;
  }, { turnDelayMs: 40 });
});

test("abort: in-flight prompt rejects with user-abort; abort without run is silent no-op", async () => {
  await withRuntime(async (rt) => {
    await rt.createSession({ model: MODEL });
    // No in-flight run: silent, does not throw.
    await rt.abort();
    const pending = rt.prompt({ text: "slow" });
    await new Promise((r) => setTimeout(r, 3));
    await rt.abort();
    await assert.rejects(() => pending, (err: unknown) => {
      assert.ok(err instanceof TreeAIErrorShape);
      assert.equal((err as TreeAIErrorShape).code, "user-abort");
      return true;
    });
    assert.equal(rt.isStreaming, false);
    // Idempotent second abort after settle.
    await rt.abort();
    // New prompt after abort starts a fresh agent run.
    const r2 = await rt.prompt({ text: "again" });
    assert.ok(r2.message.length > 0);
  }, { turnDelayMs: 40 });
});

test("navigateTree: same session, same file, append-only entries, context rebuild", async () => {
  await withRuntime(async (rt, _rec, dir) => {
    const snap = await rt.createSession({ model: MODEL });
    const afterFirst = (await rt.prompt({ text: "branch A topic" })).reference;
    const branchPoint = afterFirst.entryId;
    // Second run creates a second assistant branch under the same leaf.
    const afterSecond = (await rt.prompt({ text: "branch B topic" })).reference;
    const sizeBefore = readFileSync(snap.reference.sessionFile, "utf8").split("\n").length;

    // Navigate back to the branch point.
    const ref = await rt.navigateTree({ entryId: branchPoint });
    assert.equal(ref.sessionId, snap.reference.sessionId);
    assert.equal(ref.sessionFile, snap.reference.sessionFile);
    assert.equal(ref.entryId, branchPoint);
    const sizeAfter = readFileSync(snap.reference.sessionFile, "utf8").split("\n").length;
    assert.equal(sizeBefore, sizeAfter, "navigateTree must not rewrite the session file (append-only)");

    // Context after navigating back contains only root-path entries.
    const ctx = rt.contextOf(branchPoint);
    assert.equal(ctx.length, 2); // user + assistant of run 1
    // And a new prompt from the branch point forks a new subtree.
    const forked = (await rt.prompt({ text: "re-branch from A" })).reference;
    assert.notEqual(forked.entryId, afterSecond.entryId);
    // All entries still present (append-only tree): 2 runs x 2 entries + 2 for the fork run.
    assert.equal(rt.snapshotEntries().length, 6);
    assert.ok(dir.length > 0);
  });
});

test("navigateTree while streaming is a caller contract violation", async () => {
  await withRuntime(async (rt) => {
    await rt.createSession({ model: MODEL });
    const pending = rt.prompt({ text: "x" });
    await new Promise((r) => setTimeout(r, 3));
    await assert.rejects(() => rt.navigateTree({ entryId: entryId("e1") }), TypeError);
    await pending;
  }, { turnDelayMs: 40 });
});

test("session replacement: createSession again emits session.replaced then session.created; seq continues", async () => {
  await withRuntime(async (rt, rec) => {
    await rt.createSession({ model: MODEL });
    await rt.prompt({ text: "one" });
    const seqBefore = rec.events[rec.events.length - 1]!.seq;
    await rt.createSession({ model: MODEL });
    const kinds = rec.kinds();
    const replacedIdx = kinds.lastIndexOf("session.replaced");
    const createdIdx = kinds.lastIndexOf("session.created");
    assert.ok(replacedIdx > 0, "session.replaced emitted");
    assert.ok(createdIdx === replacedIdx + 1, "session.created directly after session.replaced");
    const seqAfter = rec.events[rec.events.length - 1]!.seq;
    assert.ok(seqAfter > seqBefore, "event seq strictly increases across session replacement");
    assert.equal(rec.checkSeqDiscipline().length, 0);
    assert.equal(rt.activeSessionId, "fake-session-2");
    // Entries of the old session are not visible in the new one.
    assert.equal(rt.entryCount, 0);
  });
});

test("restoreSession: happy path restores entries, leaf and emits session.restored", async () => {
  const dir = newSessionDir();
  const rt1 = makeRuntime(dir);
  const rec1 = new EventRecorder(rt1);
  try {
    const snap = await rt1.createSession({ model: MODEL });
    const ref = (await rt1.prompt({ text: "hello" })).reference;
    await rt1.dispose();
    rec1.stop();

    const rt2 = makeRuntime(dir);
    const rec2 = new EventRecorder(rt2);
    try {
      const restored = await rt2.restoreSession(ref);
      assert.equal(restored.reference.sessionId, ref.sessionId);
      assert.equal(restored.reference.entryId, ref.entryId);
      assert.equal(rt2.entryCount, 2);
      assert.equal(rec2.countOf("session.restored"), 1);
      // Continue the restored session.
      const cont = await rt2.prompt({ text: "continue" });
      assert.ok(cont.message.length > 0);
      assert.equal(rt2.entryCount, 4);
    } finally {
      await rt2.dispose();
      rec2.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreSession: missing file -> session-corrupt (missing-file)", async () => {
  await withRuntime(async (rt, _rec, dir) => {
    await assert.rejects(
      () =>
        rt.restoreSession({
          sessionId: sessionIdBrand("gone"),
          // A path that does not exist — deliberately inside the wrapper's
          // (cleaned-up) dir: no extra temp dir is created and leaked.
          sessionFile: join(dir, "nope.treeai-fake-session.jsonl"),
          entryId: entryId("e0"),
          piVersion: versionBrand("0.85.1"),
          availability: { status: "available" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof TreeAIErrorShape);
        assert.equal((err as TreeAIErrorShape).code, "session-corrupt");
        assert.equal(
          ((err as TreeAIErrorShape).details as Record<string, unknown>)["reason"],
          "missing-file",
        );
        return true;
      },
    );
  });
});

test("restoreSession: version drift -> session-corrupt (version-mismatch)", async () => {
  const dir = newSessionDir();
  const rt = makeRuntime(dir);
  try {
    const snap = await rt.createSession({ model: MODEL });
    await assert.rejects(
      () =>
        rt.restoreSession({
          sessionId: snap.reference.sessionId,
          sessionFile: snap.reference.sessionFile,
          entryId: entryId("e0"),
          piVersion: versionBrand("0.99.0"),
          availability: { status: "available" },
        }),
      (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "session-corrupt");
        assert.equal(
          ((err as TreeAIErrorShape).details as Record<string, unknown>)["reason"],
          "version-mismatch",
        );
        return true;
      },
    );
  } finally {
    await rt.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreSession: corrupt file -> session-corrupt (corrupt)", async () => {
  const dir = newSessionDir();
  const rt = makeRuntime(dir);
  try {
    const badFile = join(dir, "bad.treeai-fake-session.jsonl");
    writeFileSync(badFile, "{not json at all\n", "utf8");
    await assert.rejects(
      () =>
        rt.restoreSession({
          sessionId: sessionIdBrand("bad"),
          sessionFile: badFile,
          entryId: entryId("e0"),
          piVersion: versionBrand("0.85.1"),
          availability: { status: "available" },
        }),
      (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "session-corrupt");
        return true;
      },
    );
  } finally {
    await rt.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose: idempotent; in-flight prompt settles user-abort; methods after dispose throw", async () => {
  await withRuntime(async (rt, rec) => {
    await rt.createSession({ model: MODEL });
    const pending = rt.prompt({ text: "never finishes" });
    await new Promise((r) => setTimeout(r, 3));
    await rt.dispose();
    await assert.rejects(() => pending, (err: unknown) => {
      assert.equal((err as TreeAIErrorShape).code, "user-abort");
      return true;
    });
    const eventCountAtDispose = rec.events.length;
    await rt.dispose(); // idempotent
    await assert.rejects(() => rt.prompt({ text: "x" }), TypeError);
    await assert.rejects(() => rt.steer({ text: "x" }), TypeError);
    await assert.rejects(() => rt.createSession({ model: MODEL }), TypeError);
    await assert.rejects(() => rt.navigateTree({ entryId: entryId("e0") }), TypeError);
    // abort stays a silent no-op even after dispose (idempotent contract).
    await rt.abort();
    // No events after dispose.
    assert.equal(rec.events.length, eventCountAtDispose);
  }, { turnDelayMs: 40 });
});

test("scripted failure: prompt rejects with the scripted TreeAIError code", async () => {
  await withRuntime(
    async (rt, rec) => {
      await rt.createSession({ model: MODEL });
      await assert.rejects(() => rt.prompt({ text: "fail please" }), (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "upstream");
        assert.ok((err as Error).message.includes("upstream"));
        return true;
      });
      assert.equal(rec.countOf("runtime.error"), 1);
      assert.equal(rt.isStreaming, false);
    },
    {
      script: [{ kind: "fail", code: "upstream", message: "simulated upstream model error" }],
    },
  );
});

test("tool policy integration: deny makes the prompt fail with policy-denied and emits tool events", async () => {
  await withRuntime(
    async (rt, rec) => {
      await rt.createSession({ model: MODEL });
      await assert.rejects(() => rt.prompt({ text: "write the file" }), (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "policy-denied");
        return true;
      });
      assert.equal(rec.countOf("tool.execution.started"), 1);
      assert.equal(rec.countOf("tool.execution.finished"), 1);
      const finished = rec.firstOf("tool.execution.finished")!;
      assert.equal((finished.payload as Record<string, unknown>)["isError"], true);
    },
    {
      script: [
        {
          kind: "ok",
          turns: ["I will write the file."],
          toolRequest: { tool: "write_file", path: "/workspace/out.txt", action: "write" },
        },
      ],
      decideTool: () => ({ outcome: "deny", reason: "write outside approved roots" }),
    },
  );
});

test("tool policy integration: allow proceeds and finishes clean", async () => {
  await withRuntime(
    async (rt, rec) => {
      await rt.createSession({ model: MODEL });
      const result = await rt.prompt({ text: "read the file" });
      assert.ok(result.message.length > 0);
      const finished = rec.firstOf("tool.execution.finished")!;
      assert.equal((finished.payload as Record<string, unknown>)["isError"], false);
    },
    {
      script: [
        {
          kind: "ok",
          turns: ["Reading the notes file now."],
          toolRequest: { tool: "read_file", path: "notes.txt", action: "read" },
        },
      ],
      decideTool: () => ({ outcome: "allow", reason: "read under configured root" }),
    },
  );
});

test("multi-turn script: several assistant turns in one run, single agent.started", async () => {
  await withRuntime(
    async (rt, rec) => {
      await rt.createSession({ model: MODEL });
      const r = await rt.prompt({ text: "deep task" });
      assert.equal(rec.countOf("agent.started"), 1);
      assert.equal(rec.countOf("message.completed"), 2);
      assert.equal(rt.entryCount, 3); // user + 2 assistants
      assert.ok(r.message.includes("final"));
    },
    { script: [{ kind: "ok", turns: ["first part", "final part"] }] },
  );
});
