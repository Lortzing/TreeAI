/**
 * 真实 Pi SDK 离线测试（父进程）。
 *
 * 真实 SDK 的加载路径（createAgentSessionServices）会读 agentDir 与
 * HOME 派生路径，为满足「不读取测试目录之外的用户数据」：
 * - 全部真实端口用例在子进程执行，env 仅含 {HOME: 沙箱, PATH, TMPDIR}，
 *   不继承任何 API key / 凭据 / 真实配置；
 * - agentDir 与 cwd 都指向测试临时目录；
 * - 断言沙箱 HOME 在运行后未被写入（.pi 未出现）。
 * 子进程电池见 offline-child.ts（输出 ##TREEAI <json> 行）。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const CHILD_PATH = fileURLToPath(new URL("./offline-child.ts", import.meta.url));

interface ChildCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail?: string;
}

test("real Pi SDK offline battery in a sandboxed child process", () => {
  const root = mkdtempSync(join(tmpdir(), "treeai-runtime-pi-real-"));
  const sandboxHome = join(root, "home");
  const agentDir = join(root, "agent");
  const workdir = join(root, "cwd");
  mkdirSync(sandboxHome);
  mkdirSync(agentDir);
  mkdirSync(workdir);
  mkdirSync(join(root, "sessions"));

  // 自定义 provider（D1 已验证的 models.json 格式）：baseUrl 指向
  // 不可路由端口，会话创建/恢复全程不发起网络请求。
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          "treeai-offline": {
            name: "TreeAI Offline Test Provider",
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            models: [{ id: "treeai-offline-model", name: "TreeAI Offline Model" }],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  // 最小 env：不继承任何 API key / 凭据；HOME 指向沙箱。
  const childEnv: NodeJS.ProcessEnv = {
    HOME: sandboxHome,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };

  const result = spawnSync(process.execPath, [CHILD_PATH, root], {
    env: childEnv,
    encoding: "utf8",
    timeout: 90_000,
  });

  const checks: ChildCheck[] = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("##TREEAI ")) {
      checks.push(JSON.parse(line.slice("##TREEAI ".length)) as ChildCheck);
    }
  }

  assert.equal(
    result.status,
    0,
    `child exited with ${String(result.status)}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  assert.ok(checks.length >= 19, `expected the full battery, got ${checks.length} checks`);
  for (const check of checks) {
    assert.ok(check.ok, `child check failed: ${check.check} (${check.detail ?? "no detail"})`);
  }

  // 电池完整性：关键检查都必须出现。
  const names = new Set(checks.map((check) => check.check));
  for (const required of [
    "sandbox-home-active",
    "real-version-pinned",
    "port-version-pinned",
    "runtime-pi-version",
    "bogus-model-rejected",
    "offline-provider-create",
    "lazy-file-before-assistant",
    "fresh-entry-nonempty",
    "file-flushed-after-assistant",
    "session-header-valid",
    "leaf-at-assistant",
    "reopen-session-id",
    "reopen-entries",
    "restore-roundtrip",
    "tree-navigate-offline",
    "tree-navigate-back",
    "corrupt-rejected",
    "abort-dispose-offline",
    "sandbox-home-untouched",
  ]) {
    assert.ok(names.has(required), `child battery missing check: ${required}`);
  }
});

test("unit test files never import the real Pi port (import graph isolation)", () => {
  // 结构性保证：unit 测试的 import 图完全不触真实 SDK（端口隔离设计）。
  const unitDir = fileURLToPath(new URL("../unit/", import.meta.url));
  const files = readdirSync(unitDir).filter((file) => file.endsWith(".test.ts"));
  assert.ok(files.length > 0, "unit test files exist");
  for (const file of files) {
    const content = readFileSync(join(unitDir, file), "utf8");
    assert.ok(
      !content.includes("pi-real-port") && !content.includes("pi-coding-agent"),
      `${file} must not import the real Pi SDK`,
    );
  }
});
