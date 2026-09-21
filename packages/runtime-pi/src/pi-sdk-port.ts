/**
 * Pi SDK 端口：runtime-pi 对 Pi SDK 0.85.1 公开 API 的最小结构视图。
 *
 * 目的（任务书 §5 Wave 1 Agent B 第 3 项 + Pi 类型隔离红线）：
 * - `src/pi-real-port.ts` 是唯一 import `@earendil-works/pi-coding-agent`
 *   的文件；其余源码（含核心 pi-runtime.ts 与全部 fake 单测）只依赖
 *   本文件的结构类型，Pi 具体类型不流出本包。
 * - 单测注入 fake port 即可完整驱动核心逻辑，不触真实 SDK 的
 *   provider 发现路径（D1 已证明必须经 createAgentSessionServices 才能看
 *   到扩展注册的 provider，裸 ModelRuntime.create() 看不到）。
 *
 * 全部类型按 Pi 0.85.1 公开 .d.ts 的结构子集定义（只声明我们消费的字段）。
 */

/** Pi 会话事件（结构子集：type 判别 + 索引访问载荷）。 */
export interface PiEventLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 模型句柄（结构子集：Model 的 provider/id 两个稳定字段）。 */
export interface PiPortModelHandle {
  readonly provider: string;
  readonly id: string;
}

/** 会话消息（结构子集：stopReason/errorMessage 判别失败形态）。 */
export interface PiPortMessageLike {
  readonly role?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/** 会话树条目（结构子集：定位/父子/类型 + model_change 载荷字段）。 */
export interface PiPortEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly message?: { readonly role?: string };
  /** model_change 条目携带（restore 时用于固定存储模型）。 */
  readonly provider?: string;
  readonly modelId?: string;
}

/** navigateTree 返回（结构子集）。 */
export interface PiPortNavigateResult {
  readonly cancelled: boolean;
  readonly editorText?: string;
}

/** Pi 会话管理器（SessionManager 的消费子集，均为公开实例方法）。 */
export interface PiPortSessionManager {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntry(id: string): PiPortEntry | undefined;
  getEntries(): readonly PiPortEntry[];
  /** 将叶指针移动到既有条目（Pi branch()；公开方法）。 */
  branch(branchFromId: string): void;
  /** 将叶指针重置到根之前（公开方法）。 */
  resetLeaf(): void;
}

/** Pi agent 会话（AgentSession 的消费子集，均为公开实例成员）。 */
export interface PiPortSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly state: { readonly errorMessage?: string };
  readonly messages: readonly PiPortMessageLike[];
  readonly model: PiPortModelHandle | undefined;
  readonly sessionManager: PiPortSessionManager;

  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: PiEventLike) => void): () => void;
  navigateTree(targetId: string): Promise<PiPortNavigateResult>;
  getLastAssistantText(): string | undefined;
}

/**
 * 会话工厂输入。model 省略时 Pi 从 session 的存储条目恢复模型
 * （restore 路径）；提供时为创建/显式覆盖路径。
 */
export interface PiPortCreateSessionInput {
  readonly services: PiPortServices;
  readonly sessionManager: PiPortSessionManager;
  readonly model?: PiPortModelHandle;
  readonly thinkingLevel?: PiThinkingLevel;
  /** 工具 allowlist；空数组=零工具启用（最小权限默认）。 */
  readonly tools?: readonly string[];
}

/** 会话工厂结果。 */
export interface PiPortCreateSessionResult {
  readonly session: PiPortSession;
  /** Pi 在恢复路径无法还原存储模型而回退时的警告（restore 用于拒绝）。 */
  readonly modelFallbackMessage?: string;
}

/**
 * AgentSessionServices 的消费子集（由 createAgentSessionServices 创建）。
 * `raw` 携带真实 SDK 服务对象的透传句柄，仅真实端口自产自销；
 * fake port 不使用。
 */
export interface PiPortServices {
  getModel(providerId: string, modelId: string): PiPortModelHandle | undefined;
  readonly raw?: unknown;
}

/** Pi ThinkingLevel（pi-agent-core 公开类型，七档；此处结构重声明）。 */
export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Pi SDK 端口接口。真实实现见 pi-real-port.ts；测试 fake 见 tests/。
 */
export interface PiSdkPort {
  /** 实际加载的 Pi 精确版本（Pi.VERSION）。 */
  readonly version: string;

  /**
   * 创建 agent session 服务（公开 createAgentSessionServices）：
   * 内部完成扩展加载、settings、auth.json/models.json 的 provider 注册。
   * 这是唯一正确的 provider 发现入口（D1 已验证）。
   */
  createServices(cwd: string, agentDir: string | undefined): Promise<PiPortServices>;

  /** 新建持久化 session manager（公开 SessionManager.create）。 */
  createSessionManager(cwd: string, sessionDir: string): PiPortSessionManager;

  /** 新建内存 session manager（公开 SessionManager.inMemory）。 */
  createInMemorySessionManager(cwd: string): PiPortSessionManager;

  /**
   * 打开既有 session 文件（公开 SessionManager.open）。
   * 注意：Pi 对缺失文件不抛错（会隐式新建并写文件），调用方必须
   * 自行先校验文件存在性。
   */
  openSessionManager(sessionFile: string): PiPortSessionManager;

  /** 创建 AgentSession（公开 createAgentSessionFromServices）。 */
  createSession(input: PiPortCreateSessionInput): Promise<PiPortCreateSessionResult>;
}
