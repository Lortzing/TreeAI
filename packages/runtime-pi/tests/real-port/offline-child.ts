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
 * 损坏文件拒绝、abort/dispose、ToolPolicy 请求时工具执行门
 * （真实 agent loop + 真实内建 read/write 工具 + 真实 ToolPolicyEngine；
 * 模型经公开可变 Agent.streamFunction 换成脚本化离线流）。
 * 输出协议：每行 `##TREEAI <json>`（{check, ok, detail}）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Pi from "@earendil-works/pi-coding-agent";
import type { PiRuntimeEvent, TreeAIError } from "@treeai/contracts";
import { ToolPolicyEngine } from "#tool-policy";
import { createPiRuntime, createPiRuntimeFromConfig } from "../../src/index.ts";
import { adaptSession, createRealPiSdkPort, REAL_PI_VERSION } from "../../src/pi-real-port.ts";
import type { PiPortCreateSessionInput, PiSdkPort } from "../../src/pi-sdk-port.ts";

function report(check: string, ok: boolean, detail?: string): void {
  console.log(`##TREEAI ${JSON.stringify({ check, ok, detail })}`);
}

/* ------------------------------------------------------------------ */
/* 离线脚本化模型驱动（公开可变 Agent.streamFunction 的替换）             */
/* ------------------------------------------------------------------ */

/** 结构完整的 AssistantMessage（公开 Message 类型形状；脚本化内容）。 */
interface ScriptedMessage {
  readonly role: "assistant";
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Record<string, unknown>;
  readonly stopReason: string;
  readonly timestamp: number;
}

function textMessage(text: string): ScriptedMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "treeai-offline",
    model: "treeai-offline-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolCallMessage(toolName: string, args: Record<string, unknown>): ScriptedMessage {
  return {
    ...textMessage(""),
    content: [{ type: "toolCall", id: `scripted-call-${toolName}`, name: toolName, arguments: args }],
    stopReason: "toolUse",
  };
}

/**
 * 逐次取用的脚本化响应队列：每次 LLM 调用消费一条；耗尽后回退到固定
 * 收尾文本（StreamFn 契约：不得 throw）。
 */
function makeScriptedStreamFn() {
  const queue: ScriptedMessage[] = [];
  const streamFn = (): unknown => {
    const message = queue.shift() ?? textMessage("scripted stream exhausted");
    const events = [
      { type: "start", partial: message },
      { type: "done", reason: message.stopReason, message },
    ];
    let index = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return index < events.length
              ? { value: events[index++]!, done: false }
              : { value: undefined, done: true };
          },
        };
      },
      result: () => Promise.resolve(message),
    };
  };
  return { queue, streamFn };
}

/** 真实端口 + 脚本化模型驱动的混合端口（其余成员全部委托真实端口）。 */
function makeScriptedModelPort(script: ReturnType<typeof makeScriptedStreamFn>): PiSdkPort {
  // credentials 与既有电池同一受控方式：仅内存 setRuntimeApiKey（不写
  // auth.json）；AgentSession.prompt 的发送前校验需要它，实际流已被替换，
  // 全程零网络。
  const real = createRealPiSdkPort({
    credentials: { providerId: "treeai-offline", apiKey: "offline-policy-key" },
  });
  type CreateOptions = Parameters<typeof Pi.createAgentSessionFromServices>[0];
  return {
    version: real.version,
    createServices: (cwd, agentDir) => real.createServices(cwd, agentDir),
    createSessionManager: (cwd, sessionDir) => real.createSessionManager(cwd, sessionDir),
    createInMemorySessionManager: (cwd) => real.createInMemorySessionManager(cwd),
    openSessionManager: (sessionFile) => real.openSessionManager(sessionFile),
    async createSession(input: PiPortCreateSessionInput) {
      if (input.services.raw === undefined || input.services.raw === null) {
        throw new Error("scripted model port requires raw services from the real port");
      }
      const options: CreateOptions = {
        services: input.services.raw as CreateOptions["services"],
        sessionManager: input.sessionManager as unknown as CreateOptions["sessionManager"],
        ...(input.model === undefined
          ? {}
          : { model: (input.model.raw ?? input.model) as CreateOptions["model"] }),
        ...(input.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: input.thinkingLevel as CreateOptions["thinkingLevel"] }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      };
      const result = await Pi.createAgentSessionFromServices(options);
      // 离线模型驱动：替换公开可变 streamFunction（与门安装互不影响——
      // 门在 Agent.beforeToolCall，模型在 Agent.streamFunction）。
      result.session.agent.streamFunction = script.streamFn as typeof result.session.agent.streamFunction;
      return {
        session: adaptSession(result.session),
        modelFallbackMessage: result.modelFallbackMessage,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 主电池                                                               */
/* ------------------------------------------------------------------ */

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

  const credential = "offline-test-key";
  const runtime = createPiRuntime({
    agentDir,
    defaultCwd: workdir,
    thinkingLevel: "off",
    tools: ["read"],
    credentials: { providerId: "treeai-offline", apiKey: credential },
  });
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
  const authContents = existsSync(join(agentDir, "auth.json"))
    ? readFileSync(join(agentDir, "auth.json"), "utf8")
    : "";
  report("credential-bridge-in-memory", !authContents.includes(credential));
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

  // ToolPolicy 请求时工具执行门（真实 agent loop + 真实内建工具 +
  // 真实 ToolPolicyEngine；模型为脚本化离线流，零网络）。
  const readRoot = join(root, "policy-read-root");
  const policyWorkspace = join(root, "policy-workspace");
  const policyElsewhere = join(root, "policy-elsewhere");
  const policySessions = join(root, "policy-sessions");
  mkdirSync(readRoot);
  mkdirSync(policyWorkspace);
  mkdirSync(policyElsewhere);
  mkdirSync(policySessions);
  const fixtureName = "fixture.txt";
  const fixtureContent = "treeai-offline-fixture-content";
  writeFileSync(join(readRoot, fixtureName), fixtureContent, "utf8");
  const secretName = "secret-outside-roots.txt";
  const secretContent = "treeai-never-to-be-read-secret";
  writeFileSync(join(policyElsewhere, secretName), secretContent, "utf8");

  const engine = new ToolPolicyEngine({
    cwd: policyWorkspace,
    readRoots: [readRoot],
    workspaceRoots: [policyWorkspace],
  });
  engine.authorizations.issue({
    category: "write",
    targetPath: join(policyWorkspace, "granted.txt"),
    expiresInMs: 60_000,
  });

  const script = makeScriptedStreamFn();
  const policyRuntime = createPiRuntimeFromConfig({
    port: makeScriptedModelPort(script),
    agentDir,
    defaultCwd: policyWorkspace,
    tools: ["read", "write"],
    toolPolicy: engine,
  });
  const policyEvents: PiRuntimeEvent[] = [];
  policyRuntime.subscribe((event) => policyEvents.push(event));
  const policySnapshot = await policyRuntime.createSession({
    model: { providerId: "treeai-offline", modelId: "treeai-offline-model" },
    sessionDir: policySessions,
  });
  const policySessionFile = policySnapshot.reference.sessionFile;

  const decisionEvents = () =>
    policyEvents.filter((event) => event.kind === "tool.decision");
  const sessionFileText = (): string =>
    existsSync(policySessionFile) ? readFileSync(policySessionFile, "utf8") : "";
  /** 每个场景重置脚本队列（被拒 run 不会消费后续排队消息，避免串场）。 */
  const setScenario = (...messages: ScriptedMessage[]): void => {
    script.queue.splice(0);
    script.queue.push(...messages);
  };
  const promptError = async (text: string): Promise<TreeAIError> => {
    try {
      await policyRuntime.prompt({ text });
      return { code: "unknown", message: "prompt unexpectedly succeeded" };
    } catch (err) {
      return err as TreeAIError;
    }
  };

  // (a) allow：readRoot 内的 read 执行（会话文件含 fixture 正文），
  //     run 成功、最终文本可达，decision(allow) 携带规则 provenance。
  setScenario(
    toolCallMessage("read", { path: join(readRoot, fixtureName) }),
    textMessage("allow-path-final-answer"),
  );
  const allowResult = await policyRuntime.prompt({ text: "read the fixture" });
  const allowDecisions = decisionEvents().map(
    (event) => (event.payload as { decision?: string }).decision,
  );
  report(
    "policy-allow-executes",
    allowResult.message === "allow-path-final-answer" &&
      sessionFileText().includes(fixtureContent) &&
      allowDecisions.includes("allow"),
    `message=${allowResult.message} decisions=${JSON.stringify(allowDecisions)}`,
  );
  const allowPayload = decisionEvents()[0]?.payload as Record<string, unknown> | undefined;
  report(
    "policy-allow-provenance",
    allowPayload !== undefined &&
      allowPayload["toolName"] === "read" &&
      allowPayload["decision"] === "allow" &&
      allowPayload["ruleId"] === "allow-read-configured-roots" &&
      typeof allowPayload["reason"] === "string" &&
      !JSON.stringify(allowPayload).includes(fixtureName),
    `ruleId=${String(allowPayload?.["ruleId"])}`,
  );
  report(
    "policy-allow-execution-events",
    policyEvents.some((event) => event.kind === "tool.execution.started") &&
      policyEvents.some((event) => event.kind === "tool.execution.finished"),
  );

  // (b) deny（read 越权）：readRoot 之外的目标被拒——工具未执行
  //     （secret 正文绝不进入会话文件；toolResult 是策略 reason），
  //     run 以 policy-denied 拒绝，decision(deny) ruleId=null。
  const denyReadReason =
    "read target resolves outside every configured read root; no rule allows it";
  setScenario(
    toolCallMessage("read", { path: join(policyElsewhere, secretName) }),
    textMessage("should-not-be-reached"),
  );
  const denyReadError = await promptError("read outside the roots");
  const denyReadDecision = decisionEvents().at(-1)?.payload as Record<string, unknown> | undefined;
  report(
    "policy-deny-read-rejected",
    denyReadError.code === "policy-denied" && denyReadError.message.includes("tool policy"),
    `code=${denyReadError.code}`,
  );
  report(
    "policy-deny-read-never-executed",
    !sessionFileText().includes(secretContent) && sessionFileText().includes(denyReadReason),
    "secret content must stay unread; the blocked tool result carries the policy reason",
  );
  report(
    "policy-deny-read-decision",
    denyReadDecision !== undefined &&
      denyReadDecision["decision"] === "deny" &&
      denyReadDecision["ruleId"] === null &&
      denyReadDecision["reason"] === denyReadReason,
    `decision=${String(denyReadDecision?.["decision"])} ruleId=${String(denyReadDecision?.["ruleId"])}`,
  );
  report(
    "policy-deny-runtime-error",
    policyEvents.some(
      (event) =>
        event.kind === "runtime.error" &&
        (event.payload as { code?: string }).code === "policy-denied",
    ),
  );

  // (c) 授权流（write + grant）：允许执行，文件真实落盘且内容一致，
  //     decision(allow) 的 ruleId 是 authorization-grant:<id>。
  const grantedPath = join(policyWorkspace, "granted.txt");
  setScenario(
    toolCallMessage("write", { path: grantedPath, content: "granted-write-content" }),
    textMessage("grant-path-final-answer"),
  );
  const grantResult = await policyRuntime.prompt({ text: "write the granted file" });
  const grantDecision = decisionEvents().at(-1)?.payload as Record<string, unknown> | undefined;
  report(
    "policy-grant-write-executes",
    grantResult.message === "grant-path-final-answer" &&
      existsSync(grantedPath) &&
      readFileSync(grantedPath, "utf8") === "granted-write-content",
    `exists=${String(existsSync(grantedPath))}`,
  );
  report(
    "policy-grant-provenance",
    grantDecision !== undefined &&
      grantDecision["decision"] === "allow" &&
      typeof grantDecision["ruleId"] === "string" &&
      (grantDecision["ruleId"] as string).startsWith("authorization-grant:"),
    `ruleId=${String(grantDecision?.["ruleId"])}`,
  );

  // (d) require-approval（fail closed）：workspace 内无授权的 write 不执行
  //     （文件不落盘），run 以 policy-denied 拒绝。
  const ungrantedPath = join(policyWorkspace, "needs-approval.txt");
  setScenario(
    toolCallMessage("write", { path: ungrantedPath, content: "never-written" }),
    textMessage("should-not-be-reached"),
  );
  const approvalError = await promptError("write without a grant");
  report(
    "policy-require-approval-fail-closed",
    approvalError.code === "policy-denied" && !existsSync(ungrantedPath),
    `code=${approvalError.code} exists=${String(existsSync(ungrantedPath))}`,
  );

  // (e) 真实引擎确实在请求路径上被咨询：审计环形日志记录了全部决策。
  const auditDecisions = engine.audit.records.filter((record) => record.kind === "decision");
  report(
    "policy-engine-audited",
    auditDecisions.length === 4 &&
      auditDecisions.some((record) => record.outcome === "allow" && record.ruleId === "allow-read-configured-roots") &&
      auditDecisions.some((record) => record.outcome === "deny" && record.ruleId === null) &&
      auditDecisions.some((record) => record.outcome === "allow" && record.ruleId !== null && record.ruleId.startsWith("authorization-grant:")) &&
      auditDecisions.some((record) => record.outcome === "require-approval"),
    `records=${String(auditDecisions.length)}`,
  );
  await policyRuntime.dispose();

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
