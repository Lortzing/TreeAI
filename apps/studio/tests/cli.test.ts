/**
 * CLI 解析与真实 Pi 驱动边界校验测试（非秘密面）。
 *
 * 覆盖 audit 修复的受控缝：
 *  - echo 默认行为完全不变（离线、无 agent 目录）；
 *  - --agent-dir 仅对 --driver pi 有效，默认数据目录本地受控目录；
 *  - --driver pi 缺 --provider/--model 时清晰边界失败；
 *  - API key 只从注入的假 env 读取（绝不用 process.env），缺失/空白时
 *    错误只含环境变量名；装配对象只携带 runtime 工厂消费的字段。
 *
 * 工具缝（issue #6 P0-3，默认关闭）：
 *  - --pi-tools / --policy-read-roots 的解析（合法组合 + 全部边界错误：
 *    echo 拒绝、空列表、缺 --pi-tools、相对根、不存在的根）；
 *  - 读取根缺省（数据目录 workspace/）与显式给出的区分（横幅据此标注）；
 *  - 装配方（buildPiToolPolicy + 真实 #tool-policy 引擎）的直接调用：
 *    root 内 read 放行、root 外 read / 写入 / shell 拒绝——证明装配
 *    真实生效（服务级 SSE/journal/diagnostics 行为由 events.test.ts
 *    覆盖，此处不重复）。
 *
 * 测试里的 key 是显式哨兵夹具，不是任何真实凭据。解析面用例保持零
 * 文件系统、零网络、零真实依赖（src/cli.ts 模块级零运行时依赖）；
 * 引擎装配用例是本文件唯一触真实文件系统的用例（mkdtemp 真实目录，
 * 无网络、无 Pi SDK——与 events.test.ts 的引擎注入同一形态）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_PI_AGENT_DIR_NAME,
  PI_API_KEY_ENV,
  buildPiToolPolicy,
  parseArgs,
  readPiApiKey,
  resolvePiDriverWiring,
  resolvePiToolWiring,
} from "../src/cli.ts";

/** 显式哨兵（非真实凭据）：只用于验证注入值原样直达装配。 */
const SENTINEL_KEY = "studio-cli-test-key-not-a-real-secret";

/** --driver pi 的最小合法 argv 前缀（provider/model 满足边界）。 */
const PI_ARGS = ["--driver", "pi", "--provider", "p", "--model", "m"] as const;

/** 恒真的存在性探针（缺省根校验用；不存在根的失败路径单独注入 fake）。 */
const ALWAYS_DIRECTORY = (_dir: string): boolean => true;

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

/* ------------------------------------------------------------------ */
/* 工具缝（issue #6 P0-3）：--pi-tools / --policy-read-roots             */
/* ------------------------------------------------------------------ */

test("no tool flags keeps the defaults at zero tools and no policy roots (echo and pi alike)", () => {
  const echo = parseArgs([]);
  assert.equal(echo.piTools, null);
  assert.equal(echo.policyReadRoots, null);
  const pi = parseArgs([...PI_ARGS]);
  assert.equal(pi.piTools, null);
  assert.equal(pi.policyReadRoots, null);
});

test("--pi-tools is rejected for the echo driver", () => {
  assert.throws(
    () => parseArgs(["--driver", "echo", "--pi-tools", "read"]),
    /--pi-tools applies only to --driver pi/,
  );
});

test("--pi-tools must list at least one tool (empty or whitespace-only lists are usage errors)", () => {
  assert.throws(
    () => parseArgs([...PI_ARGS, "--pi-tools", ""]),
    /--pi-tools must list at least one Pi tool name/,
  );
  assert.throws(
    () => parseArgs([...PI_ARGS, "--pi-tools", " , "]),
    /--pi-tools must list at least one Pi tool name/,
  );
});

test("--pi-tools parses a trimmed comma-separated allowlist (order preserved)", () => {
  const options = parseArgs([...PI_ARGS, "--pi-tools", "read, ls ,grep"]);
  assert.deepEqual(options.piTools, ["read", "ls", "grep"]);
  assert.equal(options.policyReadRoots, null);
});

test("--policy-read-roots without --pi-tools is a usage error (echo and pi alike)", () => {
  assert.throws(
    () => parseArgs(["--policy-read-roots", "/abs"]),
    /--policy-read-roots requires --pi-tools/,
  );
  assert.throws(
    () => parseArgs([...PI_ARGS, "--policy-read-roots", "/abs"]),
    /--policy-read-roots requires --pi-tools/,
  );
});

test("--policy-read-roots must list at least one directory when given", () => {
  assert.throws(
    () => parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", ""]),
    /--policy-read-roots must list at least one absolute directory/,
  );
});

test("--policy-read-roots entries must be absolute (relative entries are boundary errors)", () => {
  assert.throws(
    () => parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", "./rel"]),
    /--policy-read-roots entries must be absolute directory paths \(got '\.\/rel'\)/,
  );
  assert.throws(
    () => parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", "/abs,rel2"]),
    /--policy-read-roots entries must be absolute directory paths \(got 'rel2'\)/,
  );
});

test("--pi-tools with explicit absolute read roots parses the trimmed list", () => {
  const options = parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", "/a/b, /c/d"]);
  assert.deepEqual(options.piTools, ["read"]);
  assert.deepEqual(options.policyReadRoots, ["/a/b", "/c/d"]);
});

test("resolvePiToolWiring is null without --pi-tools (echo and pi alike)", () => {
  assert.equal(resolvePiToolWiring(parseArgs([]), "/data/ws", ALWAYS_DIRECTORY), null);
  assert.equal(resolvePiToolWiring(parseArgs([...PI_ARGS]), "/data/ws", ALWAYS_DIRECTORY), null);
});

test("resolvePiToolWiring defaults the read roots to the workspace and marks the default", () => {
  const wiring = resolvePiToolWiring(parseArgs([...PI_ARGS, "--pi-tools", "read"]), "/data/ws", ALWAYS_DIRECTORY);
  assert.ok(wiring !== null);
  assert.deepEqual(wiring.tools, ["read"]);
  assert.deepEqual(wiring.readRoots, ["/data/ws"]);
  assert.equal(wiring.readRootsDefaulted, true);
  // 装配只携带 runtime 工厂与横幅消费的字段——没有会漏进日志的多余面。
  assert.deepEqual(Object.keys(wiring).sort(), ["readRoots", "readRootsDefaulted", "tools"]);
});

test("resolvePiToolWiring keeps explicit read roots and does not mark them defaulted", () => {
  const wiring = resolvePiToolWiring(
    parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", "/r1,/r2"]),
    "/data/ws",
    ALWAYS_DIRECTORY,
  );
  assert.ok(wiring !== null);
  assert.deepEqual(wiring.readRoots, ["/r1", "/r2"]);
  assert.equal(wiring.readRootsDefaulted, false);
});

test("resolvePiToolWiring probes every effective root and fails closed on a missing directory", () => {
  const probed: string[] = [];
  assert.throws(
    () =>
      resolvePiToolWiring(
        parseArgs([...PI_ARGS, "--pi-tools", "read", "--policy-read-roots", "/exists,/missing"]),
        "/data/ws",
        (dir) => {
          probed.push(dir);
          return dir === "/exists";
        },
      ),
    /--policy-read-roots entries must be existing directories \(got '\/missing'\)/,
  );
  assert.deepEqual(probed, ["/exists", "/missing"]);
});

test("the wired policy engine allows in-root reads and denies out-of-root reads, writes, and shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-studio-cli-"));
  try {
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    /* 与 index.ts 同一装配方（缺省读取根 = workspace）+ 同一真实引擎工厂
       （#tool-policy 编译产物）——直接调用评估面，证明装配真实生效。 */
    const wiring = resolvePiToolWiring(parseArgs([...PI_ARGS, "--pi-tools", "read"]), workspace, ALWAYS_DIRECTORY);
    assert.ok(wiring !== null);
    assert.equal(wiring.readRootsDefaulted, true);
    const { createToolPolicy } = await import("#tool-policy");
    const engine = buildPiToolPolicy(wiring, workspace, createToolPolicy);

    const inRoot = engine.evaluate({ category: "read", targetPath: join(workspace, "notes.txt") });
    assert.equal(inRoot.outcome, "allow");
    assert.equal(inRoot.ruleId, "allow-read-configured-roots");

    const outside = engine.evaluate({ category: "read", targetPath: join(dir, "secret-outside.txt") });
    assert.equal(outside.outcome, "deny");
    assert.match(outside.reason, /outside every configured read root/);

    /* 写入根恒空 → workspace 内的写入也拒绝（默认无逐次授权）。 */
    const write = engine.evaluate({ category: "write", targetPath: join(workspace, "out.txt") });
    assert.equal(write.outcome, "deny");
    assert.match(write.reason, /outside every approved workspace root/);

    /* shell / network 默认拒绝（CLI 不提供放开开关）。 */
    assert.equal(engine.evaluate({ category: "shell", command: "echo hi" }).outcome, "deny");
    assert.equal(engine.evaluate({ category: "network", host: "example.invalid" }).outcome, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
