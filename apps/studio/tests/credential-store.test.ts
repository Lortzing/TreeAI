import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  createCredentialStore,
  resolveCredentialEnvironment,
  type CredentialStoreCommand,
  type CredentialStoreCommandResult,
} from "../src/credential-store.ts";

const result = (exitCode: number | null, stdout = "", stderr = ""): CredentialStoreCommandResult => ({ exitCode, stdout, stderr });
const serviceFor = (dataDir: string) => `com.treeai.credential-store.${createHash("sha256").update(resolve(dataDir)).digest("hex")}`;

function mockStore(results: CredentialStoreCommandResult[], dataDir = "/tmp/treeai-credential-test") {
  const commands: CredentialStoreCommand[] = [];
  const store = createCredentialStore(dataDir, {
    platform: "darwin",
    run: async (command) => {
      commands.push(command);
      return results.shift() ?? result(0);
    },
  });
  return { store, commands };
}

test("macOS store namespaces records by resolved data directory and uses fixed security commands", async () => {
  const { store, commands } = mockStore([result(0, "  secret  \n"), result(0)]);
  assert.equal(await store.get("API_KEY"), "  secret  ");
  await store.remove("API_KEY");
  assert.equal(commands[0]!.executable, "/usr/bin/security");
  assert.deepEqual(commands[0]!.args, ["find-generic-password", "-s", serviceFor("/tmp/treeai-credential-test"), "-a", "API_KEY", "-w"]);
  assert.deepEqual(commands[1]!.args, ["delete-generic-password", "-s", serviceFor("/tmp/treeai-credential-test"), "-a", "API_KEY"]);
  assert.equal(commands[0]!.timeoutMs, 10_000);
  assert.ok(commands[0]!.maxOutputBytes <= 16_384);
  assert.notEqual(serviceFor("/tmp/treeai-credential-test"), serviceFor("/tmp/another-tree"));
});

test("set passes safely escaped credentials only through bounded stdin", async () => {
  const value = '  token "quoted" \\ trail  ';
  const { store, commands } = mockStore([result(0), result(0, value + '\n')]);
  await store.set("API_KEY", value);
  const command = commands[0]!;
  assert.equal(command.executable, "/usr/bin/security");
  assert.deepEqual(command.args, ["-i"]);
  assert.equal(command.timeoutMs, 10_000);
  assert.ok(command.maxOutputBytes <= 16_384);
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  assert.equal(command.input, `add-generic-password -U -s "${serviceFor("/tmp/treeai-credential-test")}" -a "API_KEY" -w "${escaped}"\n`);
  assert.ok(!JSON.stringify(command.args).includes(value));
});

test("names and secret values are validated before invoking the runner", async () => {
  const { store, commands } = mockStore([]);
  for (const name of ["", "1API", "API-KEY", "API\nKEY"]) {
    await assert.rejects(store.get(name), { message: "Invalid credential name" });
  }
  for (const value of ["", "   ", "bad\nvalue", "bad\rvalue", "bad\0value", "x".repeat(16_385)]) {
    await assert.rejects(store.set("API_KEY", value), { message: "Invalid credential value" });
  }
  await assert.rejects(store.remove("API-KEY"), { message: "Invalid credential name" });
  assert.deepEqual(commands, []);
});

test("missing records return null while failures are generic and sanitized", async () => {
  const sensitiveOutput = "credential-canary-must-not-escape";
  const { store } = mockStore([
    result(44, "", sensitiveOutput),
    result(1, sensitiveOutput, sensitiveOutput),
  ]);
  assert.equal(await store.get("API_KEY"), null);
  await assert.rejects(store.get("API_KEY"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Credential store operation failed");
    assert.ok(!error.message.includes(sensitiveOutput));
    return true;
  });
});

test("runner exceptions are sanitized", async () => {
  const store = createCredentialStore("/tmp/treeai-credential-test", {
    platform: "darwin",
    run: async () => { throw new Error("secret-canary"); },
  });
  await assert.rejects(store.get("API_KEY"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Credential store operation failed");
    assert.ok(!error.message.includes("secret-canary"));
    return true;
  });
});

test("unsupported platforms fail honestly and resolver does not query the store", async () => {
  let calls = 0;
  const store = createCredentialStore("/tmp/treeai-credential-test", {
    platform: "win32",
    run: async () => { calls += 1; return result(0); },
  });
  assert.equal(store.supported, false);
  assert.equal(store.backend, "unsupported");
  await assert.rejects(store.get("API_KEY"), /unsupported/);
  await assert.rejects(store.set("API_KEY", "secret"), /unsupported/);
  await assert.rejects(store.remove("API_KEY"), /unsupported/);
  const baseEnv = { API_KEY: "from-env", KEEP: "unchanged" };
  const resolved = await resolveCredentialEnvironment({ providers: { one: { apiKeyEnv: "API_KEY" } } }, baseEnv, store);
  assert.deepEqual(resolved, baseEnv);
  assert.deepEqual(baseEnv, { API_KEY: "from-env", KEEP: "unchanged" });
  assert.equal(calls, 0);
});

test("environment values win, only declared names are queried, and input is unchanged", async () => {
  const queried: string[] = [];
  const store = createCredentialStore("/tmp/treeai-credential-test", {
    platform: "darwin",
    run: async () => result(0),
  });
  const resolvingStore = {
    ...store,
    get: async (name: string) => {
      queried.push(name);
      return `stored-${name}`;
    },
  };
  const config = {
    providers: {
      first: { apiKeyEnv: "API_KEY", headerEnv: { Authorization: "AUTH_TOKEN", "X-Client": "CLIENT_ID" } },
      second: { apiKeyEnv: "SECOND_KEY", headerEnv: { "X-Other": "AUTH_TOKEN" } },
    },
  };
  const baseEnv = { API_KEY: "process-value", KEEP: "unchanged", AUTH_TOKEN: undefined };
  const resolved = await resolveCredentialEnvironment(config, baseEnv, resolvingStore);
  assert.deepEqual(resolved, {
    API_KEY: "process-value",
    KEEP: "unchanged",
    AUTH_TOKEN: "stored-AUTH_TOKEN",
    CLIENT_ID: "stored-CLIENT_ID",
    SECOND_KEY: "stored-SECOND_KEY",
  });
  assert.deepEqual(queried.sort(), ["AUTH_TOKEN", "CLIENT_ID", "SECOND_KEY"]);
  assert.deepEqual(baseEnv, { API_KEY: "process-value", KEEP: "unchanged", AUTH_TOKEN: undefined });
});


test("interactive success is verified and a silently rejected write cannot be reported as saved", async () => {
  const { store } = mockStore([result(0), result(44)]);
  await assert.rejects(store.set("API_KEY", "synthetic-value"), /Credential store operation failed/);
});
test("empty environment values fall back to the store without mutating the environment", async () => {
  const { store } = mockStore([result(0, "stored-value\n")]);
  const env = { API_KEY: "" };
  const resolved = await resolveCredentialEnvironment({ providers: { test: { apiKeyEnv: "API_KEY" } } }, env, store);
  assert.equal(resolved.API_KEY, "stored-value"); assert.equal(env.API_KEY, "");
});


test("credential presence checks use metadata without retrieving the password", async () => {
  const {store,commands}=mockStore([result(0),result(44)]);
  assert.equal(await store.has!("API_KEY"),true); assert.equal(await store.has!("API_KEY"),false);
  assert.ok(commands.every(command=>!command.args.includes("-w")));
});
