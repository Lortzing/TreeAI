import {
  existsSync,
} from "node:fs";
import {
  findStoredModelOnBranch,
} from "./session-inspection.ts";
import type {
  PiRuntimeEventKind,
  PiSessionInit,
  PiSessionSnapshot,
  PiNavigateTreeTarget,
  SessionReference,
  TreeAIError,
} from "@treeai/contracts";
import type {
  JsonRecord,
} from "@treeai/contracts";
import {
  classifyPiFailure,
  modelUnavailableError,
  sessionCorruptError,
} from "./errors.ts";

import {
  redactText,
} from "./redact.ts";
import type {
  PiPortModelHandle,
  PiPortSession,
  PiPortSessionManager,
  PiSdkPort,
  PiThinkingLevel,
} from "./pi-sdk-port.ts";


import type {
  ActiveSession,
  InFlightRun,
} from "./runtime-state.ts";
import {
  PINNED_PI_VERSION,
  PINNED_PI_VERSION_BRANDED,
} from "./version.ts";
interface SessionContext {
 readonly port: PiSdkPort;
 readonly agentDir: string | undefined;
 readonly defaultCwd: string;
 readonly thinkingLevel: PiThinkingLevel;
 readonly tools: readonly string[];
 readonly inFlight: InFlightRun | null;
 assertNotDisposed(): void;
 requireActiveSession(method: string): ActiveSession;
 swapActiveSession(session: PiPortSession, manager: PiPortSessionManager, lifecycleKind: "session.created" | "session.restored"): Promise<void>;
 installToolGate(session: PiPortSession): void;
 toReportedError(err: unknown, context: string): TreeAIError;
 reportRuntimeError(error: TreeAIError): void;
 emitEvent(kind: PiRuntimeEventKind, payload: JsonRecord): void;
}

/** Session construction, restoration and same-session navigation. Active run/session state stays in the runtime owner. */
export class RuntimeSessionCoordinator {
 readonly context: SessionContext;
 constructor(context: SessionContext) { this.context = context; }


  /* ---------------------------------------------------------------- */
  /* 会话创建 / 恢复                                                    */
  /* ---------------------------------------------------------------- */

  async createSession(init: PiSessionInit): Promise<PiSessionSnapshot> {
    this.context.assertNotDisposed();
    if (init === null || typeof init !== "object") {
      throw new TypeError("createSession requires a PiSessionInit object");
    }
    if (
      init.model === null ||
      typeof init.model !== "object" ||
      typeof init.model.providerId !== "string" ||
      typeof init.model.modelId !== "string" ||
      init.model.providerId === "" ||
      init.model.modelId === ""
    ) {
      throw new TypeError("createSession requires init.model with non-empty providerId and modelId strings");
    }
    if (init.cwd !== undefined && typeof init.cwd !== "string") {
      throw new TypeError("createSession: init.cwd must be a string when provided");
    }
    if (init.sessionDir !== undefined && typeof init.sessionDir !== "string") {
      throw new TypeError("createSession: init.sessionDir must be a string when provided");
    }

    const cwd = init.cwd ?? this.context.defaultCwd;
    try {
      const services = await this.context.port.createServices(cwd, this.context.agentDir);
      const model = services.getModel(init.model.providerId, init.model.modelId);
      if (model === undefined) {
        throw modelUnavailableError(
          `model not found in the loaded Pi provider registry: ${init.model.providerId}/${init.model.modelId}`,
          {
            details: { providerId: init.model.providerId, modelId: init.model.modelId },
          },
        );
      }
      const manager =
        init.sessionDir === undefined
          ? this.context.port.createInMemorySessionManager(cwd)
          : this.context.port.createSessionManager(cwd, init.sessionDir);
      const created = await this.context.port.createSession({
        services,
        sessionManager: manager,
        model,
        thinkingLevel: this.context.thinkingLevel,
        tools: this.context.tools,
      });
      if (created.session.model === undefined) {
        throw modelUnavailableError(
          "Pi created the session without a usable model",
          { details: { providerId: init.model.providerId, modelId: init.model.modelId } },
        );
      }
      await this.context.swapActiveSession(created.session, manager, "session.created");
      this.context.installToolGate(created.session);
      return { reference: this.referenceFromActive() };
    } catch (err) {
      throw this.context.toReportedError(err, "createSession");
    }
  }


  async restoreSession(reference: SessionReference): Promise<PiSessionSnapshot> {
    this.context.assertNotDisposed();
    if (
      reference === null ||
      typeof reference !== "object" ||
      typeof reference.sessionId !== "string" ||
      typeof reference.sessionFile !== "string" ||
      typeof reference.entryId !== "string" ||
      typeof reference.piVersion !== "string" ||
      reference.sessionId === "" ||
      reference.piVersion === ""
    ) {
      throw new TypeError(
        "restoreSession requires a SessionReference with non-empty sessionId/piVersion and string sessionFile/entryId",
      );
    }

    // 版本兼容：契约要求版本不一致以 session-corrupt 拒绝（version-mismatch）。
    if (reference.piVersion !== PINNED_PI_VERSION) {
      throw sessionCorruptError(
        `session reference was produced by Pi ${reference.piVersion}, this runtime pins ${PINNED_PI_VERSION}`,
        {
          details: {
            reason: "version-mismatch",
            referenceVersion: reference.piVersion,
            runtimeVersion: PINNED_PI_VERSION,
          },
        },
      );
    }
    // 内存会话引用不可恢复（无文件）；空 sessionFile 视为缺失。
    if (reference.sessionFile === "") {
      throw sessionCorruptError(
        "session reference has no session file (in-memory sessions cannot be restored)",
        { details: { reason: "missing-file" } },
      );
    }
    // Pi 的 SessionManager.open 对缺失文件不抛错（会隐式新建并写文件），
    // 因此必须先自行校验存在性，避免在用户文件系统留下垃圾文件。
    if (!existsSync(reference.sessionFile)) {
      throw sessionCorruptError("session file does not exist", {
        details: { reason: "missing-file", sessionFile: redactText(reference.sessionFile) },
      });
    }

    let manager: PiPortSessionManager;
    try {
      manager = this.context.port.openSessionManager(reference.sessionFile);
    } catch (err) {
      throw sessionCorruptError("session file could not be opened or parsed", {
        details: { reason: "corrupt", sessionFile: redactText(reference.sessionFile) },
        cause: err,
      });
    }
    if (manager.getSessionId() !== reference.sessionId) {
      throw sessionCorruptError("session file does not contain the referenced session id", {
        details: { reason: "corrupt", kind: "session-id-mismatch" },
      });
    }

    const leafId = manager.getLeafId();
    if (reference.entryId === "") {
      if (leafId !== null) {
        throw sessionCorruptError(
          "reference points at the session root, but the session file has entries (stale reference)",
          { details: { reason: "corrupt", kind: "stale-root-reference" } },
        );
      }
    } else {
      if (manager.getEntry(reference.entryId) === undefined) {
        throw sessionCorruptError("referenced entry does not exist in the session file", {
          details: { reason: "corrupt", kind: "entry-not-found" },
        });
      }
      if (leafId !== reference.entryId) {
        // 叶指针对齐到引用位置（Pi 公开 branch()，不写文件）。
        manager.branch(reference.entryId);
      }
    }

    // 恢复使用 session 存储的 cwd（Pi header），保证工具执行工作区一致。
    const sessionCwd = this.resolveManagerCwd(manager);
    // 记录恢复前叶位置：Pi 对「无消息条目」的会话走新会话路径并追加
    // 条目（公开 API 无抑制选项）；恢复后把叶指针移回，保证返回引用
    // 与输入引用的 entryId 一致（已知限制，见 README）。
    const leafBeforeCreate = manager.getLeafId();
    try {
      const services = await this.context.port.createServices(sessionCwd, this.context.agentDir);

      // 模型固定：从当前分支上最近的 model_change 恢复存储模型并显式传入。
      // 不依赖 Pi 的隐式恢复（其对无消息条目的会话会改用 findInitialModel，
      // 可能静默替换模型，破坏可复现性）。
      const storedModel = findStoredModelOnBranch(manager);
      let model: PiPortModelHandle | undefined;
      if (storedModel !== undefined) {
        model = services.getModel(storedModel.provider, storedModel.modelId);
        if (model === undefined) {
          throw modelUnavailableError(
            `restored session's stored model is not resolvable in the loaded Pi provider registry: ${storedModel.provider}/${storedModel.modelId}`,
            {
              details: {
                providerId: storedModel.provider,
                modelId: storedModel.modelId,
              },
            },
          );
        }
      }

      const restored = await this.context.port.createSession({
        services,
        sessionManager: manager,
        model,
      });
      if (
        restored.session.model === undefined ||
        restored.modelFallbackMessage !== undefined
      ) {
        throw modelUnavailableError(
          "restored session could not use its stored model (missing, unloaded provider, or fallback)",
          {
            details: {
              ...(restored.modelFallbackMessage === undefined
                ? {}
                : { fallbackMessage: redactText(restored.modelFallbackMessage) }),
            },
          },
        );
      }
      // 叶指针回位（仅当 Pi 在恢复中追加了条目时发生移动）。
      const leafAfterCreate = manager.getLeafId();
      if (leafAfterCreate !== leafBeforeCreate) {
        if (leafBeforeCreate === null) {
          manager.resetLeaf();
        } else {
          manager.branch(leafBeforeCreate);
        }
      }
      await this.context.swapActiveSession(restored.session, manager, "session.restored");
      this.context.installToolGate(restored.session);
      return { reference: this.referenceFromActive() };
    } catch (err) {
      throw this.context.toReportedError(err, "restoreSession");
    }
  }


  async navigateTree(target: PiNavigateTreeTarget): Promise<SessionReference> {
    this.context.assertNotDisposed();
    if (
      target === null ||
      typeof target !== "object" ||
      typeof target.entryId !== "string" ||
      target.entryId === ""
    ) {
      throw new TypeError("navigateTree requires a target with a non-empty entryId string");
    }
    const active = this.context.requireActiveSession("navigateTree");
    if (this.context.inFlight !== null) {
      throw new TypeError("navigateTree requires no in-flight prompt (wait for it to settle or abort first)");
    }

    const manager = active.manager;
    const entry = manager.getEntry(target.entryId);
    if (entry === undefined) {
      throw sessionCorruptError("navigateTree target entry does not exist in the session", {
        details: { reason: "corrupt", kind: "entry-not-found" },
      });
    }

    const beforeId = active.session.sessionId;
    const beforeFile = active.session.sessionFile;
    const beforeEntryCount = manager.getEntries().length;

    let result;
    try {
      result = await active.session.navigateTree(target.entryId);
    } catch (err) {
      throw this.context.toReportedError(err, "navigateTree");
    }
    if (result.cancelled) {
      // 仅扩展 cancel 钩子可触发；导航没有发生，如实失败。
      throw classifyPiFailure(
        new Error("tree navigation was cancelled before it took effect"),
        "navigateTree cancelled",
      );
    }

    // D2 回归不变量：同 session / 同文件 / 追加式树。
    if (
      active.session.sessionId !== beforeId ||
      active.session.sessionFile !== beforeFile ||
      manager.getEntries().length !== beforeEntryCount
    ) {
      const error = classifyPiFailure(
        new Error("navigateTree violated the same-session invariant (session id/file or entry count changed)"),
        "navigateTree invariant",
      );
      this.context.reportRuntimeError(error);
      throw error;
    }

    const newLeaf = manager.getLeafId() ?? "";
    this.context.emitEvent("tree.navigated", {
      targetEntryId: target.entryId,
      leafEntryId: newLeaf,
      sessionId: active.session.sessionId,
    });
    return this.referenceFromActive();
  }


  /** 从活跃会话生成引用三元组（+版本/可用性）。 */
  referenceFromActive(): SessionReference {
    const active = this.context.requireActiveSession("referenceFromActive");
    return {
      sessionId: active.session.sessionId as SessionReference["sessionId"],
      sessionFile:
        active.manager.getSessionFile() ?? active.session.sessionFile ?? "",
      entryId: (active.manager.getLeafId() ?? "") as SessionReference["entryId"],
      piVersion: PINNED_PI_VERSION_BRANDED,
      availability: { status: "available" },
    };
  }


  private resolveManagerCwd(manager: PiPortSessionManager): string {
    const cwd = manager.getCwd();
    return typeof cwd === "string" && cwd.length > 0 ? cwd : this.context.defaultCwd;
  }
}
