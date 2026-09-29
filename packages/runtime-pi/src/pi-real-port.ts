/**
 * 真实 Pi SDK 端口适配器。
 *
 * 本文件是整个 runtime-pi 中**唯一** import `@earendil-works/pi-coding-agent`
 * 的源码文件。只使用包根公开导出（不做子路径/私有 import）：
 *
 * - `Pi.VERSION`
 * - `Pi.createAgentSessionServices({cwd, agentDir?})`
 * - `Pi.createAgentSessionFromServices({services, sessionManager, model?, ...})`
 * - `Pi.SessionManager.create(cwd, sessionDir?)` / `.open(path)` / `.inMemory(cwd?)`
 *   及其实例方法（getEntries/getEntry/getLeafId/getSessionId/getSessionFile/
 *   branch/resetLeaf）
 * - `AgentSession` 实例成员：prompt/steer/abort/dispose/subscribe/
 *   navigateTree/getLastAssistantText/state/messages/model/sessionManager
 * - `AgentSession.agent.beforeToolCall`（pi-agent-core `Agent` 的公开可变
 *   实例字段；请求时工具执行门的安装点——先于每次实际工具执行被 agent
 *   loop 调用，返回 {block:true} 即不执行）
 *
 * 类型一律从根导出值推导（Parameters/ReturnType/Awaited/InstanceType），
 * 避免依赖 Pi 内部模块路径。适配器把 Pi 具体类型收在本文件内，
 * 对外只暴露 pi-sdk-port.ts 的结构类型。
 */

import * as Pi from "@earendil-works/pi-coding-agent";
import type {
  PiEventLike,
  PiPortCreateSessionInput,
  PiPortCreateSessionResult,
  PiPortMessageLike,
  PiPortModelHandle,
  PiPortNavigateResult,
  PiPortServices,
  PiPortSession,
  PiPortSessionManager,
  PiPortToolExecutionGate,
  PiSdkPort,
  PiThinkingLevel,
} from "./pi-sdk-port.ts";

/** 从根导出值推导的 Pi 公开类型（不 import 内部模块）。 */
type PiServices = Awaited<ReturnType<typeof Pi.createAgentSessionServices>>;
type PiCreateAgentSessionServicesOptions = Parameters<typeof Pi.createAgentSessionServices>[0];
type PiResourceLoaderOptions = NonNullable<PiCreateAgentSessionServicesOptions["resourceLoaderOptions"]>;
type PiCreateSessionOptions = Parameters<typeof Pi.createAgentSessionFromServices>[0];
type PiCreateSessionResult = Awaited<ReturnType<typeof Pi.createAgentSessionFromServices>>;
type PiSession = PiCreateSessionResult["session"];
/** pi-agent-core Agent（经公开成员 session.agent 推导，不 import 内部模块）。 */
type PiAgent = PiSession["agent"];
type PiAgentBeforeToolCall = NonNullable<PiAgent["beforeToolCall"]>;
type PiBeforeToolCallContext = Parameters<PiAgentBeforeToolCall>[0];
type PiBeforeToolCallResult = Awaited<ReturnType<PiAgentBeforeToolCall>>;
/** SessionManager 的构造函数是 private，从公开静态工厂推导实例类型。 */
type PiManager = ReturnType<typeof Pi.SessionManager.create>;

function assertRawServices(services: PiPortServices): PiServices {
  if (services.raw === undefined || services.raw === null) {
    throw new Error("real Pi port received services without a raw SDK handle (fake services leaked into the real port?)");
  }
  return services.raw as PiServices;
}

/**
 * 把 AgentSession 适配为端口会话（getter 保持活引用，不冻结快照）。
 * 导出供真实端口离线电池使用：测试以自定义端口包装真实端口并替换
 * `Agent.streamFunction`（离线脚本化模型驱动），随后用本适配器把自建的
 * 真实会话接回 PiSdkPort 缝——门安装/事件/收敛走与生产完全相同的路径。
 */
export function adaptSession(session: PiSession): PiPortSession {
  // AgentSession 构造期在公开可变的 Agent.beforeToolCall 上安装了扩展
  // 拦截钩子（_installAgentToolHooks）；捕获为 base，保证门安装后扩展的
  // tool_call 拦截继续工作（门先评估：策略拒绝时扩展钩子不再被调用）。
  const baseBeforeToolCall = session.agent.beforeToolCall?.bind(session.agent);
  let gate: PiPortToolExecutionGate | null = null;
  return {
    get sessionId(): string {
      return session.sessionId;
    },
    get sessionFile(): string | undefined {
      return session.sessionManager.getSessionFile();
    },
    get isStreaming(): boolean {
      return session.isStreaming;
    },
    get state(): { readonly errorMessage?: string } {
      return session.state as unknown as { readonly errorMessage?: string };
    },
    get messages(): readonly PiPortMessageLike[] {
      return session.messages as unknown as readonly PiPortMessageLike[];
    },
    get model(): PiPortModelHandle | undefined {
      const model = session.model;
      return model === undefined || model === null
        ? undefined
        : { provider: model.provider, id: model.id };
    },
    get sessionManager(): PiPortSessionManager {
      return session.sessionManager as unknown as PiPortSessionManager;
    },
    prompt: (text: string) => session.prompt(text),
    steer: (text: string) => session.steer(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener: (event: PiEventLike) => void) =>
      session.subscribe((event) => {
        listener(event as unknown as PiEventLike);
      }),
    navigateTree: (targetId: string) =>
      session.navigateTree(targetId) as unknown as Promise<PiPortNavigateResult>,
    getLastAssistantText: () => session.getLastAssistantText(),
    installToolExecutionGate: (nextGate: PiPortToolExecutionGate) => {
      gate = nextGate;
      // agent loop 在参数校验后、执行前调用该字段；{block:true} 即不执行
      // （loop 以 error tool result 收敛，模型可见 reason）。
      session.agent.beforeToolCall = async (
        context: PiBeforeToolCallContext,
        signal?: AbortSignal,
      ): Promise<PiBeforeToolCallResult | undefined> => {
        const currentGate = gate;
        if (currentGate !== null) {
          const verdict = await currentGate({
            toolName: context.toolCall.name,
            args: context.args,
          });
          if (verdict !== undefined && verdict.block) {
            return {
              block: true,
              ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
              ...(verdict.terminate === true ? { terminate: true } : {}),
            };
          }
        }
        return baseBeforeToolCall === undefined ? undefined : baseBeforeToolCall(context, signal);
      };
    },
  };
}

export interface PiRuntimeCredentials {
  readonly providerId: string;
  readonly apiKey: string;
}

export interface PiRealSdkPortOptions {
  readonly credentials?: PiRuntimeCredentials;
  readonly extensionFactories?: readonly unknown[];
}

export function createRealPiSdkPort(options: PiRealSdkPortOptions = {}): PiSdkPort {
  const credentials = options.credentials;
  const extensionFactories = options.extensionFactories;
  return {
    version: Pi.VERSION,

    async createServices(cwd: string, agentDir: string | undefined): Promise<PiPortServices> {
      const services = await Pi.createAgentSessionServices({
        cwd,
        agentDir: agentDir === undefined ? undefined : agentDir,
        ...(extensionFactories === undefined
          ? {}
          : {
              resourceLoaderOptions: {
                extensionFactories:
                  extensionFactories as PiResourceLoaderOptions["extensionFactories"],
              },
            }),
      });
      if (credentials !== undefined) {
        await services.modelRuntime.setRuntimeApiKey(credentials.providerId, credentials.apiKey);
      }
      return {
        getModel: (providerId: string, modelId: string): PiPortModelHandle | undefined => {
          const model = services.modelRuntime.getModel(providerId, modelId);
          return model === undefined
            ? undefined
            : { provider: model.provider, id: model.id, raw: model };
        },
        raw: services,
      };
    },

    createSessionManager(cwd: string, sessionDir: string): PiPortSessionManager {
      const manager = Pi.SessionManager.create(cwd, sessionDir);
      return manager as unknown as PiPortSessionManager;
    },

    createInMemorySessionManager(cwd: string): PiPortSessionManager {
      const manager = Pi.SessionManager.inMemory(cwd);
      return manager as unknown as PiPortSessionManager;
    },

    openSessionManager(sessionFile: string): PiPortSessionManager {
      const manager = Pi.SessionManager.open(sessionFile);
      return manager as unknown as PiPortSessionManager;
    },

    async createSession(input: PiPortCreateSessionInput): Promise<PiPortCreateSessionResult> {
      const options = {
        services: assertRawServices(input.services),
        sessionManager: input.sessionManager as unknown as PiManager,
        model:
          input.model === undefined
            ? undefined
            : ((input.model.raw ?? input.model) as unknown as PiCreateSessionOptions["model"]),
        thinkingLevel:
          input.thinkingLevel === undefined
            ? undefined
            : (input.thinkingLevel as unknown as PiCreateSessionOptions["thinkingLevel"]),
        tools: input.tools === undefined ? undefined : [...input.tools],
      } satisfies PiCreateSessionOptions;
      const result = await Pi.createAgentSessionFromServices(options);
      return {
        session: adaptSession(result.session),
        modelFallbackMessage: result.modelFallbackMessage,
      };
    },
  };
}

/** 实际加载的 Pi 包版本（Pi.VERSION 的便捷导出，测试与诊断用）。 */
export const REAL_PI_VERSION: string = Pi.VERSION;
