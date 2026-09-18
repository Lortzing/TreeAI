/**
 * TreeAI D1 spike - scriptable fake Pi session (tests only).
 *
 * Emits Pi-shaped AgentSessionEvent objects so scenarios, recorder, and
 * runner logic can be exercised without network or credentials. NEVER used
 * by the real probe entry point (src/run.ts); fake results are never
 * written to the shared evidence directory.
 */

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateProbeSessionOptions,
  ProbeSessionLike,
  ProbeSessionFactory,
} from "./types.js";

/** One scripted turn: what the fake model does for the n-th user message. */
export interface FakeTurnScript {
  /** Final answer text; streamed as text_delta chunks. */
  answer: string;
  /** Split answer into this many deltas (default 5). */
  deltaCount?: number;
  /** Delay between deltas in ms (default 5; raise for steering tests). */
  interDeltaDelayMs?: number;
  /** Tool calls emitted before the final text answer. */
  toolCalls?: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    isError?: boolean;
  }>;
  /** If set, prompt() rejects with this error after the turn's events. */
  turnError?: Error;
  /** If true, the turn hangs mid-stream until abort() (timeout/abort tests). */
  hang?: boolean;
}

let nextSessionId = 1;

export class FakeProbeSession implements ProbeSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  private emitter = new EventEmitter();
  private disposed = false;
  private abortRequested = false;
  private abortWaiter: (() => void) | null = null;
  private streamingFlag = false;
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];
  private turnCounter = 0;
  private persistedHeader = false;
  readonly history: Array<{ role: "user" | "assistant"; text: string }> = [];
  public promptCalls: string[] = [];
  public steerCalls: string[] = [];
  public abortCount = 0;
  public disposeCount = 0;

  constructor(
    private readonly scripts: FakeTurnScript[],
    opts?: {
      persist?: boolean;
      sessionFile?: string;
      /** Seed history (resume fake: entries restored from a persisted file). */
      seedHistory?: Array<{ role: "user" | "assistant"; text: string }>;
      sessionId?: string;
    },
  ) {
    this.sessionId = opts?.sessionId ?? `fake-session-${nextSessionId++}`;
    this.sessionFile = opts?.persist ? opts.sessionFile : undefined;
    if (opts?.seedHistory) {
      this.history.push(...opts.seedHistory);
      this.turnCounter = opts.seedHistory.filter((h) => h.role === "user").length;
    }
  }

  get isStreaming(): boolean {
    return this.streamingFlag;
  }

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    if (this.disposed) throw new Error("subscribe after dispose");
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount("event");
  }

  private emit(event: Record<string, unknown>): void {
    this.emitter.emit("event", event);
  }

  async prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
    if (this.disposed) throw new Error("prompt after dispose");
    this.promptCalls.push(text);
    if (this.streamingFlag) {
      if (!opts?.streamingBehavior) {
        throw new Error("Prompt during streaming requires streamingBehavior (mirrors Pi SDK)");
      }
      if (opts.streamingBehavior === "steer") return this.steer(text);
      return this.followUp(text);
    }
    await this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    this.streamingFlag = true;
    this.history.push({ role: "user", text });
    this.persistEntry("user", text);
    this.turnCounter += 1;
    const script = this.scripts[this.turnCounter - 1] ?? { answer: "ok" };

    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });

    for (const tool of script.toolCalls ?? []) {
      const toolCallId = `tc-${this.turnCounter}-${Math.random().toString(36).slice(2, 8)}`;
      this.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: tool.toolName,
        args: tool.args,
      });
      this.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: tool.toolName,
        result: tool.result,
        isError: tool.isError ?? false,
      });
    }

    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    const deltas = splitIntoDeltas(script.answer, script.deltaCount ?? 5);
    const delay = script.interDeltaDelayMs ?? 5;
    let accumulated = "";
    for (const delta of deltas) {
      if (this.abortRequested) break;
      accumulated += delta;
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: { role: "assistant", content: [{ type: "text", text: accumulated }] },
        },
      });
      await sleep(delay);
    }

    if (script.hang && !this.abortRequested) {
      await new Promise<void>((resolve) => {
        this.abortWaiter = resolve;
      });
    }

    const finalText = this.abortRequested ? accumulated : script.answer;
    if (!this.abortRequested) {
      this.history.push({ role: "assistant", text: finalText });
      this.persistEntry("assistant", finalText);
    }
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        stopReason: this.abortRequested ? "aborted" : "stop",
      },
    });
    this.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        stopReason: this.abortRequested ? "aborted" : "stop",
      },
      toolResults: [],
    });
    // Mirrors Pi's contract: agent_end carries the new messages of the run
    // (user prompt + assistant answer).
    this.emit({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text }] },
        { role: "assistant", content: [{ type: "text", text: finalText }] },
      ],
      willRetry: false,
    });
    this.streamingFlag = false;
    this.emit({ type: "agent_settled" });

    if (script.turnError) {
      throw script.turnError;
    }

    // Drain queued messages as new turns (mirrors Pi queue delivery).
    while (this.steeringQueue.length > 0) {
      const queued = this.steeringQueue.shift()!;
      this.emit({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] });
      await this.runTurn(queued);
    }
    while (this.followUpQueue.length > 0) {
      const queued = this.followUpQueue.shift()!;
      this.emit({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] });
      await this.runTurn(queued);
    }
  }

  /**
   * Persist a JSONL "session file" for the resume fake runner. The first
   * line is a header carrying the session id, mirroring Pi's session files
   * (header + entries).
   */
  private persistEntry(role: string, text: string): void {
    if (this.sessionFile === undefined) return;
    if (!this.persistedHeader) {
      appendFileSync(this.sessionFile, JSON.stringify({ role: "session-header", sessionId: this.sessionId }) + "\n");
      this.persistedHeader = true;
    }
    appendFileSync(this.sessionFile, JSON.stringify({ role, text }) + "\n");
  }

  async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
    if (!this.streamingFlag && !this.disposed) {
      // Mirrors Pi: a steering message arriving after the current turn
      // ended is delivered as the next turn.
      await this.runTurn(text);
      return;
    }
    this.steeringQueue.push(text);
    this.emit({
      type: "queue_update",
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    });
  }

  async followUp(text: string): Promise<void> {
    this.followUpQueue.push(text);
    this.emit({
      type: "queue_update",
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    });
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.abortRequested = true;
    this.abortWaiter?.();
    this.abortWaiter = null;
    await sleep(2);
    this.streamingFlag = false;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.disposed = true;
    this.emitter.removeAllListeners();
  }

  getHistorySummary(): {
    entries: number;
    userMessages: number;
    assistantMessages: number;
    lastAssistantText: string | undefined;
  } {
    return {
      entries: this.history.length,
      userMessages: this.history.filter((h) => h.role === "user").length,
      assistantMessages: this.history.filter((h) => h.role === "assistant").length,
      lastAssistantText: this.history.filter((h) => h.role === "assistant").at(-1)?.text,
    };
  }
}

/** Read back a fake persisted session file (resume fake runner, phase B). */
export function readFakeSessionFile(
  path: string,
): Array<{ role: string; text?: string; sessionId?: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { role: string; text?: string; sessionId?: string });
}

function splitIntoDeltas(text: string, count: number): string[] {
  if (text.length === 0) return [];
  const size = Math.max(1, Math.ceil(text.length / count));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeSessionFactory(
  scripts: FakeTurnScript[],
  hooks?: { onSession?: (s: FakeProbeSession) => void },
): ProbeSessionFactory {
  return {
    async create(options: CreateProbeSessionOptions): Promise<ProbeSessionLike> {
      const session = new FakeProbeSession(scripts, {
        persist: options.persist,
        sessionFile:
          options.persist && options.sessionDir
            ? join(options.sessionDir, "fake-session.jsonl")
            : undefined,
      });
      hooks?.onSession?.(session);
      return session;
    },
  };
}

/**
 * Session factory that hands out a DIFFERENT script set per created
 * session (queue semantics: shift the front; reuse the last when the
 * queue is exhausted). Used where consecutive sessions must behave
 * differently (e.g. abort: hanging session, then healthy session).
 */
export function createFakeSessionFactoryQueue(
  perSessionScripts: FakeTurnScript[][],
  hooks?: { onSession?: (s: FakeProbeSession) => void },
): ProbeSessionFactory {
  const queue = [...perSessionScripts];
  return {
    async create(options: CreateProbeSessionOptions): Promise<ProbeSessionLike> {
      const scripts = queue.length > 1 ? queue.shift()! : queue[0]!;
      const session = new FakeProbeSession(scripts, {
        persist: options.persist,
        sessionFile:
          options.persist && options.sessionDir
            ? join(options.sessionDir, "fake-session.jsonl")
            : undefined,
      });
      hooks?.onSession?.(session);
      return session;
    },
  };
}
