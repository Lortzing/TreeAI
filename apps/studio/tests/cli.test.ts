/**
 * CLI 解析与真实 Pi 驱动边界校验测试（非秘密面）。
 *
 * 覆盖 audit 修复的受控缝：
 *  - echo 默认行为完全不变（离线、无 agent 目录）；
 *  - --agent-dir 仅对 --driver pi 有效，默认数据目录本地受控目录；
 *  - --driver pi 缺 --provider/--model 时清晰边界失败；
 *  - API key 只从注入的假 env 读取（绝不用 process.env），缺失/空白时
 *    错误只含环境变量名；装配对象只携带 runtime 工厂消费的字段。
 * 测试里的 key 是显式哨兵夹具，不是任何真实凭据。零文件系统、零网络、
 * 零真实 Pi SDK import（src/cli.ts 无依赖）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  DEFAULT_PI_AGENT_DIR_NAME,
  PI_API_KEY_ENV,
  parseArgs,
  readPiApiKey,
  resolvePiDriverWiring,
} from "../src/cli.ts";

/** 显式哨兵（非真实凭据）：只用于验证注入值原样直达装配。 */
const SENTINEL_KEY = "studio-cli-test-key-not-a-real-secret";

test("echo defaults are unchanged (offline driver, no agent dir)", () => {
  const options = parseArgs([]);
  assert.equal(options.port, 8787);
  assert.equal(options.driver, "echo");
  assert.equal(options.providerId, "studio-provider");
  assert.equal(options.modelId, "studio-model");
  assert.equal(options.dataDir, resolve("./treeai-studio-data"));
  assert.equal(options.agentDir, null);
});

test("echo keeps explicit provider/model overrides and never gets an agent dir", () => {
  const options = parseArgs(["--driver", "echo", "--provider", "p", "--model", "m"]);
  assert.equal(options.providerId, "p");
  assert.equal(options.modelId, "m");
  assert.equal(options.agentDir, null);
});

test("--agent-dir is rejected for the echo driver", () => {
  assert.throws(
    () => parseArgs(["--driver", "echo", "--agent-dir", "/tmp/controlled"]),
    /--agent-dir applies only to --driver pi/,
  );
});

test("--driver pi fails clearly without provider/model (error names the env var too)", () => {
  assert.throws(
    () => parseArgs(["--driver", "pi"]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--driver pi requires --provider and --model"));
      assert.ok(err.message.includes(PI_API_KEY_ENV));
      return true;
    },
  );
});

test("empty --provider value still fails the pi boundary check", () => {
  assert.throws(
    () => parseArgs(["--driver", "pi", "--provider", "", "--model", "m"]),
    /--driver pi requires --provider and --model/,
  );
});

test("--driver pi defaults the agent dir to the data-dir-local controlled directory", () => {
  const options = parseArgs([
    "--driver", "pi", "--provider", "p", "--model", "m", "--data", "/tmp/studio-data",
  ]);
  assert.equal(options.agentDir, resolve(join("/tmp/studio-data", DEFAULT_PI_AGENT_DIR_NAME)));
});

test("--driver pi accepts an explicit absolute agent dir", () => {
  const options = parseArgs([
    "--driver", "pi", "--provider", "p", "--model", "m", "--agent-dir", "/tmp/controlled-pi",
  ]);
  assert.equal(options.agentDir, "/tmp/controlled-pi");
});

test("--driver pi resolves a relative agent dir against the process cwd", () => {
  const options = parseArgs([
    "--driver", "pi", "--provider", "p", "--model", "m", "--agent-dir", "./controlled-pi",
  ]);
  assert.equal(options.agentDir, resolve("./controlled-pi"));
});

test("--agent-dir before --driver pi in argv still parses (flag order independent)", () => {
  const options = parseArgs(["--agent-dir", "/tmp/controlled", "--driver", "pi", "--provider", "p", "--model", "m"]);
  assert.equal(options.agentDir, "/tmp/controlled");
});

test("empty or whitespace-only --agent-dir value is a usage error", () => {
  assert.throws(
    () => parseArgs(["--driver", "pi", "--provider", "p", "--model", "m", "--agent-dir", ""]),
    /--agent-dir must be a non-empty directory path/,
  );
  assert.throws(
    () => parseArgs(["--driver", "pi", "--provider", "p", "--model", "m", "--agent-dir", "   "]),
    /--agent-dir must be a non-empty directory path/,
  );
});

test("unknown flags and missing values keep failing with the usage error", () => {
  assert.throws(() => parseArgs(["--bogus", "x"]), /unknown flag: --bogus/);
  assert.throws(() => parseArgs(["--driver"]), /usage: node src\/index\.ts/);
  assert.throws(() => parseArgs(["--driver", "bogus"]), /--driver must be 'echo' or 'pi'/);
});

test("readPiApiKey fails with a boundary error naming only the env var when missing", () => {
  assert.throws(
    () => readPiApiKey({}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(PI_API_KEY_ENV));
      assert.ok(err.message.includes("--driver pi"));
      assert.ok(!err.message.includes(SENTINEL_KEY));
      return true;
    },
  );
});

test("readPiApiKey treats whitespace-only values as missing", () => {
  assert.throws(() => readPiApiKey({ [PI_API_KEY_ENV]: "   " }), new RegExp(PI_API_KEY_ENV));
});

test("readPiApiKey returns the trimmed injected env value (sentinel fixture)", () => {
  assert.equal(readPiApiKey({ [PI_API_KEY_ENV]: `  ${SENTINEL_KEY}  ` }), SENTINEL_KEY);
});

test("resolvePiDriverWiring hands the runtime factory exactly the controlled dir + in-memory credentials", () => {
  const options = parseArgs(["--driver", "pi", "--provider", "prov", "--model", "mdl"]);
  const wiring = resolvePiDriverWiring(options, { [PI_API_KEY_ENV]: SENTINEL_KEY });
  assert.equal(wiring.agentDir, options.agentDir);
  assert.deepEqual(wiring.credentials, { providerId: "prov", apiKey: SENTINEL_KEY });
  // 装配只携带 runtime 工厂消费的字段——没有会漏进日志/TreeAI DB 的多余面。
  assert.deepEqual(Object.keys(wiring).sort(), ["agentDir", "credentials"]);
  assert.deepEqual(Object.keys(wiring.credentials).sort(), ["apiKey", "providerId"]);
});

test("resolvePiDriverWiring fails for non-pi options", () => {
  const options = parseArgs([]);
  assert.throws(() => resolvePiDriverWiring(options, {}), /--driver pi/);
});
