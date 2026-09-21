/**
 * Pi 版本钉扎：fake port 单测。
 * 覆盖：版本不一致在工厂构造期明确失败（PiVersionMismatchError，
 * 携带 actual/expected）、piVersion getter、port 校验。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiRuntimeFromConfig, PiVersionMismatchError, PINNED_PI_VERSION } from "../../src/pi-runtime.ts";
import { makeFakePort } from "../helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-ver-"));
}

test("port reporting a different Pi version fails the constructor explicitly", () => {
  assert.throws(
    () => createPiRuntimeFromConfig({ port: makeFakePort({ version: "0.99.0" }), defaultCwd: tempDir() }),
    (err: unknown) => {
      assert.ok(err instanceof PiVersionMismatchError, "PiVersionMismatchError (not a generic Error)");
      assert.equal(err.actualVersion, "0.99.0");
      assert.equal(err.expectedVersion, PINNED_PI_VERSION);
      assert.ok(err.message.includes("0.99.0"), "message names the loaded version");
      assert.ok(err.message.includes(PINNED_PI_VERSION), "message names the pinned version");
      return true;
    },
  );

  // 同为 0.85.1 的补丁差异也拒绝（契约要求精确钉扎）。
  assert.throws(
    () => createPiRuntimeFromConfig({ port: makeFakePort({ version: "0.85.0" }), defaultCwd: tempDir() }),
    PiVersionMismatchError,
  );
});

test("matching version constructs and reports piVersion = pinned", async () => {
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: tempDir() });
  assert.equal(runtime.piVersion, PINNED_PI_VERSION);
  assert.equal(runtime.piVersion, "0.85.1");

  // 构造成功后正常可用，引用携带钉扎版本。
  const snapshot = await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  assert.equal(snapshot.reference.piVersion, PINNED_PI_VERSION);

  await runtime.dispose();
});

test("config without a real port object fails with TypeError", () => {
  assert.throws(
    () => createPiRuntimeFromConfig({ port: null as never, defaultCwd: tempDir() }),
    TypeError,
  );
  assert.throws(
    () => createPiRuntimeFromConfig({ port: "not a port" as never, defaultCwd: tempDir() }),
    TypeError,
  );
});
