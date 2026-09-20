/**
 * TreeAI D1 spike - the Pi SDK adapter (the code under measurement).
 *
 * This is the ONLY module that talks to the real Pi SDK
 * (@earendil-works/pi-coding-agent). Everything it needs from Pi is listed
 * in PI_API_SURFACE (audited in README and scenario observations).
 *
 * It does NOT fork or modify Pi, and it does not define any TreeAI domain
 * model or RuntimeAdapter - it is probe glue, intended to be deleted.
 *
 * Credentials: the bridge never reads, prints, or stores API keys. Pi's
 * ModelRuntime resolves auth itself (runtime override > ~/.pi/agent/auth.json
 * > environment variables). If no authenticated model exists, the bridge
 * throws BlockedError("BLOCKED_CREDENTIALS").
 *
 * Model discovery: providers registered by pi packages/extensions (e.g. the
 * pi-ccs token-plan provider used for the 2026-09-20 baseline) are only
 * visible on a ModelRuntime after createAgentSessionServices() has loaded
 * ~/.pi/agent resources and flushed extension provider registrations into
 * the runtime. A bare ModelRuntime.create() cannot see them (this was the
 * root cause of the 2026-09-20 BLOCKED_MODEL run), so every model resolution
 * in this bridge goes through createAgentSessionServices().
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import * as Pi from "@earendil-works/pi-coding-agent";
import type {
  CreateProbeSessionOptions,
  ProbeSessionLike,
  ProbeSessionFactory,
  ProbeTreeEntryInfo,
  ProbeTreeState,
} from "./types.js";
import { BlockedError } from "./blocked.js";
import { PROBE_THINKING_LEVEL } from "./prompts.js";

/**
 * Structurally identical to pi-agent-core's ThinkingLevel ("off"|"minimal"|
 * "low"|"medium"|"high"|"xhigh"|"max"), which the main package does not
 * re-export; assignment to createAgentSessionFromServices' option is type-safe.
 */
const THINKING_LEVEL = PROBE_THINKING_LEVEL;

/** Every Pi SDK API this adapter touches (audit inventory). */
export const PI_API_SURFACE: Record<string, string[]> = {
  "Pi.createAgentSessionServices": [
    "services factory: options.cwd -> { modelRuntime, settingsManager, resourceLoader, diagnostics }; loads ~/.pi/agent extensions (settings packages) and flushes their provider registrations into the model runtime",
  ],
  "Pi.createAgentSessionFromServices": [
    "session factory: options { services, sessionManager, model, thinkingLevel, tools, noTools }",
  ],
  "Pi.SessionManager": ["inMemory(cwd)", "create(cwd, sessionDir)", "open(sessionFile)", "getEntries()", "getSessionFile()", "getSessionId()"],
  "Pi.ModelRuntime": ["getModel(providerId, modelId)", "getAvailable()"],
  "Pi.VERSION": ["package version constant"],
  "AgentSession.prompt": ["prompt(text, { streamingBehavior })"],
  "AgentSession.steer": ["steer(text)"],
  "AgentSession.followUp": ["followUp(text)"],
  "AgentSession.abort": ["abort()"],
  "AgentSession.dispose": ["dispose()"],
  "AgentSession.subscribe": ["subscribe(listener) -> unsubscribe"],
  "AgentSession state": ["sessionId", "sessionFile", "isStreaming", "messages", "model", "thinkingLevel", "state.errorMessage"],
  "AgentSession.navigateTree": [
    "in-place tree navigation within the same session file: navigateTree(targetId) -> { editorText?, cancelled }; idle-state only (rejects while streaming); user-message targets move the leaf to the entry's parent and return the message text as editorText; non-user targets move the leaf to the target itself (tree-nav scenario; options/summarize deliberately not used)",
  ],
  "SessionManager tree state": [
    "getLeafId() (leaf pointer before/after navigation)",
    "getEntries() id/parentId/type/message.role mapping (tree structure snapshot)",
  ],
};

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  thinkingLevel: string;
  source: "env-override" | "first-available";
}

export class RealProbeSession implements ProbeSessionLike {
  private unsubscribeFn: (() => void) | null = null;
  private readonly extraListeners: Array<(event: AgentSessionEvent) => void> = [];

  private constructor(
    private readonly session: AgentSession,
    private readonly sessionManager: Pi.SessionManager,
  ) {}

  static async create(opts: CreateProbeSessionOptions & { resolvedModel: ResolvedModel }): Promise<RealProbeSession> {
    // createAgentSessionServices() is the SDK's supported entry point for
    // CLI-equivalent model discovery: it loads ~/.pi/agent extensions
    // (settings `packages`, e.g. pi-ccs) and flushes their provider
    // registrations into the model runtime before we resolve the model. A
    // bare ModelRuntime.create() cannot see extension-registered providers.
    const services = await Pi.createAgentSessionServices({ cwd: opts.cwd });
    const model =
      opts.resolvedModel.source === "env-override"
        ? services.modelRuntime.getModel(opts.resolvedModel.providerId, opts.resolvedModel.modelId)
        : (await services.modelRuntime.getAvailable())[0];
    if (!model) {
      throw new BlockedError(
        "BLOCKED_MODEL",
        `Configured model ${opts.resolvedModel.providerId}/${opts.resolvedModel.modelId} could not be resolved`,
      );
    }
    const sessionManager = opts.openSessionFile
      ? Pi.SessionManager.open(opts.openSessionFile)
      : opts.persist
        ? Pi.SessionManager.create(opts.cwd, opts.sessionDir)
        : Pi.SessionManager.inMemory(opts.cwd);
    const { session } = await Pi.createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: PROBE_THINKING_LEVEL,
      tools: opts.tools === "read-only" ? ["read"] : undefined,
      noTools: opts.tools === "none" ? "all" : undefined,
    });
    return new RealProbeSession(session, sessionManager);
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  get errorMessage(): string | undefined {
    const state = (this.session as unknown as { state?: { errorMessage?: string } }).state;
    return state?.errorMessage;
  }

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    const wrapped = listener as (event: AgentSessionEvent) => void;
    this.extraListeners.push(wrapped);
    const unsub = this.session.subscribe(wrapped);
    return () => {
      const idx = this.extraListeners.indexOf(wrapped);
      if (idx >= 0) this.extraListeners.splice(idx, 1);
      unsub();
    };
  }

  /** Attach the evidence recorder listener. Called once per session. */
  attachRecorder(onEvent: (event: AgentSessionEvent) => void): void {
    if (this.unsubscribeFn) throw new Error("recorder already attached");
    this.unsubscribeFn = this.session.subscribe(onEvent);
  }

  async prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
    await this.session.prompt(text, opts);
    // Pi reports post-acceptance failures through the message stream, not
    // by rejecting prompt(). Surface the latest assistant error here.
    const err = this.errorMessage;
    if (err && !/aborted/i.test(err)) {
      classifyAndThrow(err);
    }
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }> {
    // Options are deliberately omitted: summarize/label would trigger an
    // extra summarizer model call and is outside this probe's scope. The
    // probe only navigates in the idle state (Pi rejects mid-stream).
    return this.session.navigateTree(targetId);
  }

  getTreeState(): ProbeTreeState {
    const entries: ProbeTreeEntryInfo[] = this.sessionManager.getEntries().map((raw) => {
      const e = raw as {
        id: string;
        parentId?: string | null;
        type: string;
        message?: { role?: string };
      };
      return {
        id: e.id,
        parentId: e.parentId ?? null,
        type: e.type,
        role: e.message?.role,
      };
    });
    return {
      sessionId: this.session.sessionId,
      leafId: this.sessionManager.getLeafId(),
      entries,
      // AgentSession.messages is the live LLM context; navigateTree()
      // rebuilds it from the new branch (agent.state.messages = context).
      contextMessageCount: this.session.messages.length,
    };
  }

  dispose(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = null;
    this.session.dispose();
  }

  getHistorySummary(): {
    entries: number;
    userMessages: number;
    assistantMessages: number;
    lastAssistantText: string | undefined;
  } {
    const messages = this.session.messages;
    let userMessages = 0;
    let assistantMessages = 0;
    let lastAssistantText: string | undefined;
    for (const m of messages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "assistant") {
        assistantMessages += 1;
        lastAssistantText = extractText(msg.content);
      }
    }
    return {
      entries: this.sessionManager.getEntries().length,
      userMessages,
      assistantMessages,
      lastAssistantText,
    };
  }
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part === null || typeof part !== "object") return "";
        const p = part as { type?: string; text?: string };
        return p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return undefined;
}

/** Classify a Pi/model error message into FAIL vs BLOCKED. */
export function classifyAndThrow(message: string): never {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("api key") ||
    lowered.includes("apikey") ||
    lowered.includes("unauthorized") ||
    lowered.includes("401") ||
    lowered.includes("403") ||
    lowered.includes("authentication") ||
    (lowered.includes("auth") && lowered.includes("missing"))
  ) {
    throw new BlockedError("BLOCKED_CREDENTIALS", message);
  }
  throw new Error(message);
}

/** Resolve which model the probe will use; BLOCKED_CREDENTIALS when none. */
export async function resolveProbeModel(): Promise<ResolvedModel> {
  const override = process.env.PI_PROBE_MODEL;
  const thinkingLevel = PROBE_THINKING_LEVEL;
  if (override) {
    const slash = override.indexOf("/");
    if (slash <= 0) {
      throw new Error(`PI_PROBE_MODEL must be "providerId/modelId", got: ${override}`);
    }
    return {
      providerId: override.slice(0, slash),
      modelId: override.slice(slash + 1),
      thinkingLevel,
      source: "env-override",
    };
  }
  // Same services path as RealProbeSession.create: extension-registered
  // providers (pi packages in ~/.pi/agent) must be visible for the
  // availability check too.
  const services = await Pi.createAgentSessionServices({ cwd: process.cwd() });
  const available = await services.modelRuntime.getAvailable();
  if (available.length === 0) {
    throw new BlockedError(
      "BLOCKED_CREDENTIALS",
      "No model with valid authentication: Pi auth.json has no stored credentials and no provider API key environment variables are set. Run `pi auth login` (or set a provider API key env var) and re-run the probe.",
    );
  }
  const first = available[0] as { provider: string; id: string };
  return { providerId: first.provider, modelId: first.id, thinkingLevel, source: "first-available" };
}

/** Real session factory wired into scenarios by src/run.ts. */
export function createRealSessionFactory(resolvedModel: ResolvedModel): ProbeSessionFactory {
  return {
    async create(options: CreateProbeSessionOptions): Promise<ProbeSessionLike> {
      return RealProbeSession.create({ ...options, resolvedModel });
    },
  };
}

export const PI_PACKAGE_VERSION: string = Pi.VERSION;
