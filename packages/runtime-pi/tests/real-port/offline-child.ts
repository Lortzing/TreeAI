/**
 * 真实 Pi SDK 离线电池：在沙箱子进程中执行（父测试 offline.test.ts 驱动）。
 *
 * 单独成文件（非 *.test.ts）：node --test 的 glob 不会直接执行它。
 * 由父进程以 {HOME: <sandbox>, PATH} 的最小 env 启动，保证：
 * - 不读取测试目录之外的用户数据（真实 HOME/凭据/API key 全部隔离）；
 * - 也不把任何东西写进真实 HOME。
 *
 * 覆盖（全部离线，零网络请求）：
 * 真实版本钉扎、经 createAgentSessionServices 的 provider 注册表
 * （自定义 models.json）、会话创建、Pi 懒 flush（首条 assistant 消息前
 * 不落盘）实证、真实 SessionManager 追加/重开往返、restoreSession
 * （含存储模型固定 + 中间叶重定位）、navigateTree 离线树操作、
 * 损坏文件拒绝、abort/dispose。
 * 输出协议：每行 `##TREEAI <json>`（{check, ok, detail}）。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "../../src/index.ts";
import { createRealPiSdkPort, REAL_PI_VERSION } from "../../src/pi-real-port.ts";

function report(check: string, ok: boolean, detail?: string): void {
  console.log(`##TREEAI ${JSON.stringify({ check, ok, detail })}`);
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined || !existsSync(root)) {
    report("child-args", false, "expected temp root as argv[2]");
    return;
  }
  const sandboxHome = join(root, "home");
  const agentDir = join(root, "agent");
  const workdir = join(root, "cwd");
  const sessionDir = join(root, "sessions");

  // 沙箱生效：os.homedir() 必须指向沙箱（env.HOME 由父进程设置）。
  report("sandbox-home-active", homedir() === sandboxHome, `homedir=${homedir()}`);
  const homeBefore = readdirSync(sandboxHome).sort().join(",");

  // 真实加载的 Pi 版本必须精确等于钉扎版本。
  report("real-version-pinned", REAL_PI_VERSION === "0.85.1", `version=${REAL_PI_VERSION}`);
  const port = createRealPiSdkPort();
  report("port-version-pinned", port.version === "0.85.1", `version=${port.version}`);

  const runtime = createPiRuntime({ agentDir, defaultCwd: workdir });
  report("runtime-pi-version", runtime.piVersion === "0.85.1");

  // provider 注册表来自沙箱 agentDir/models.json（createAgentSessionServices）。
  // 未知模型 → model-unavailable（证明注册表真实加载且离线可查询）。
  try {
    await runtime.createSession({
      model: { providerId: "treeai-offline", modelId: "no-such-model" },
      sessionDir,
    });
    report("bogus-model-rejected", false, "createSession unexpectedly succeeded");
  } catch (err) {
    const code = (err as { code?: string }).code;
    report("bogus-model-rejected", code === "model-unavailable", `code=${String(code)}`);
  }

  // 自定义 provider（baseUrl 指向不可路由端口，全程零网络）创建会话。
  const snapshot = await runtime.createSession({
    model: { providerId: "treeai-offline", modelId: "treeai-offline-model" },
    sessionDir,
  });
  const runtimeFile = snapshot.reference.sessionFile;
  report(
    "offline-provider-create",
    runtimeFile !== "" && runtimeFile.startsWith(sessionDir),
    `sessionFile=${runtimeFile}`,
  );
  // Pi 0.85.1 懒 flush：无 assistant 消息时创建期条目只驻内存，文件不落盘。
  report("lazy-file-before-assistant", !existsSync(runtimeFile));
  report("fresh-entry-nonempty", snapshot.reference.entryId.length > 0);

  // 真实 SessionManager 往返：直接建 manager、追加 user + assistant 消息
  // （assistant 触发落盘），再经 runtime.restoreSession 恢复。
  const manager = port.createSessionManager(workdir, sessionDir);
  const appender = manager as unknown as {
    appendModelChange(provider: string, modelId: string): string;
    appendMessage(message: unknown): string;
  };
  appender.appendModelChange("treeai-offline", "treeai-offline-model");
  const userEntryId = appender.appendMessage({
    role: "user",
    content: "offline user turn",
    timestamp: Date.now(),
  });
  // 结构完整的 AssistantMessage（公开 Message 类型；appendMessage 公开方法）。
  const assistantEntryId = appender.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "offline assistant turn" }],
    api: "openai-completions",
    provider: "treeai-offline",
    model: "treeai-offline-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();
  report("file-flushed-after-assistant", file !== undefined && existsSync(file), `file=${String(file)}`);
  if (file !== undefined) {
    const headerLine = readFileSync(file, "utf8").split("\n")[0] ?? "";
    const header = JSON.parse(headerLine) as { type?: string; id?: string };
    report(
      "session-header-valid",
      header.type === "session" && header.id === manager.getSessionId(),
      `type=${String(header.type)}`,
    );
  }
  report("leaf-at-assistant", manager.getLeafId() === assistantEntryId);

  // 真实 open() 往返：重开同一文件，sessionId 与条目一致。
  const reopened = port.openSessionManager(manager.getSessionFile() ?? "");
  report("reopen-session-id", reopened.getSessionId() === manager.getSessionId());
  report("reopen-entries", reopened.getEntries().length === manager.getEntries().length);

  // restoreSession：引用指向中间叶（user 条目，非当前叶）。
  const restored = await runtime.restoreSession({
    sessionId: manager.getSessionId() as typeof snapshot.reference.sessionId,
    sessionFile: (manager.getSessionFile() ?? "") as typeof snapshot.reference.sessionFile,
    entryId: userEntryId as typeof snapshot.reference.entryId,
    piVersion: snapshot.reference.piVersion,
    availability: snapshot.reference.availability,
  });
  report(
    "restore-roundtrip",
    restored.reference.sessionId === manager.getSessionId() &&
      restored.reference.entryId === userEntryId,
    `entryId=${restored.reference.entryId}`,
  );

  // 离线树导航：→ assistant（叶移到自身）→ user（叶移到父，Pi 语义）。
  const navToAssistant = await runtime.navigateTree({
    entryId: assistantEntryId as typeof snapshot.reference.entryId,
  });
  report(
    "tree-navigate-offline",
    navToAssistant.sessionId === manager.getSessionId() &&
      navToAssistant.entryId === assistantEntryId,
    `entryId=${navToAssistant.entryId}`,
  );
  const userParentId = manager.getEntry(userEntryId)?.parentId ?? "";
  const navBack = await runtime.navigateTree({ entryId: userEntryId as typeof navToAssistant.entryId });
  report(
    "tree-navigate-back",
    navBack.entryId === userParentId,
    `entryId=${navBack.entryId} expectedParent=${userParentId}`,
  );

  // 损坏文件 → session-corrupt（真实 open 抛错路径）。
  const corruptFile = join(root, "corrupt.jsonl");
  writeFileSync(corruptFile, "this is not json\n", "utf8");
  try {
    await runtime.restoreSession({
      ...restored.reference,
      sessionFile: corruptFile as typeof restored.reference.sessionFile,
    });
    report("corrupt-rejected", false, "restore unexpectedly succeeded");
  } catch (err) {
    const treeai = err as { code?: string; details?: { reason?: string } };
    report(
      "corrupt-rejected",
      treeai.code === "session-corrupt" && treeai.details?.reason === "corrupt",
      `code=${String(treeai.code)}`,
    );
  }

  // abort 无在途 run → no-op；dispose 幂等。
  await runtime.abort();
  await runtime.dispose();
  await runtime.dispose();
  report("abort-dispose-offline", true);

  // 沙箱 HOME 未被写入（.pi 未出现、目录内容不变）。
  const homeAfter = readdirSync(sandboxHome).sort().join(",");
  report(
    "sandbox-home-untouched",
    homeBefore === homeAfter && !existsSync(join(sandboxHome, ".pi")),
    homeAfter,
  );
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
