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
  PiSdkPort,
  PiThinkingLevel,
} from "./pi-sdk-port.ts";

/** 从根导出值推导的 Pi 公开类型（不 import 内部模块）。 */
type PiServices = Awaited<ReturnType<typeof Pi.createAgentSessionServices>>;
type PiCreateSessionOptions = Parameters<typeof Pi.createAgentSessionFromServices>[0];
type PiCreateSessionResult = Awaited<ReturnType<typeof Pi.createAgentSessionFromServices>>;
type PiSession = PiCreateSessionResult["session"];
/** SessionManager 的构造函数是 private，从公开静态工厂推导实例类型。 */
type PiManager = ReturnType<typeof Pi.SessionManager.create>;

function assertRawServices(services: PiPortServices): PiServices {
  if (services.raw === undefined || services.raw === null) {
    throw new Error("real Pi port received services without a raw SDK handle (fake services leaked into the real port?)");
  }
  return services.raw as PiServices;
}

/** 把 AgentSession 适配为端口会话（getter 保持活引用，不冻结快照）。 */
function adaptSession(session: PiSession): PiPortSession {
  return {
    get sessionId(): string {
      return session.sessionId;
    },
    get sessionFile(): string | undefined {
      return session.sessionFile;
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
  };
}

export function createRealPiSdkPort(): PiSdkPort {
  return {
    version: Pi.VERSION,

    async createServices(cwd: string, agentDir: string | undefined): Promise<PiPortServices> {
      const services = await Pi.createAgentSessionServices({
        cwd,
        agentDir: agentDir === undefined ? undefined : agentDir,
      });
      return {
        getModel: (providerId: string, modelId: string): PiPortModelHandle | undefined => {
          const model = services.modelRuntime.getModel(providerId, modelId);
          return model === undefined ? undefined : { provider: model.provider, id: model.id };
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
            : (input.model as unknown as PiCreateSessionOptions["model"]),
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
