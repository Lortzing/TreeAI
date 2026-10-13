/** executor ownership for import-service.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialParseContext,
  MaterialParseExecution,
  MaterialParseExecutor,
  MaterialParser,
  MaterialParserOutcome,
} from "./model.ts";
import {
  Worker,
} from "node:worker_threads";

export class InlineMaterialParseExecutor implements MaterialParseExecutor {
  start(parser: MaterialParser, bytes: Uint8Array, context: MaterialParseContext): MaterialParseExecution {
    return {
      promise: Promise.resolve().then(() => parser.parse(bytes, context)),
      cancel(): void {
        // Injected parsers are a test seam; task cancellation still protects the durable row.
      },
    };
  }
}

export class WorkerMaterialParseExecutor implements MaterialParseExecutor {
  start(parser: MaterialParser, bytes: Uint8Array, context: MaterialParseContext): MaterialParseExecution {
    const workerBytes = bytes.slice();
    const worker = new Worker(new URL("../parse-worker.ts", import.meta.url), {
      workerData: {
        parserKind: parser.kind,
        bytes: workerBytes,
        maxPages: context.maxPages,
      },
    });
    let settled = false;
    let terminationTimer: NodeJS.Timeout | null = null;
    let resolvePromise: (outcome: MaterialParserOutcome) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<MaterialParserOutcome>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (terminationTimer !== null) clearTimeout(terminationTimer);
      terminationTimer = null;
      callback();
    };
    worker.once("message", (message: unknown) => {
      if (
        message === null ||
        typeof message !== "object" ||
        (message as { type?: unknown }).type !== "result"
      ) {
        finish(() => rejectPromise(new Error("material parse worker returned an invalid message")));
        return;
      }
      const outcome = (message as { outcome?: unknown }).outcome;
      finish(() => resolvePromise(outcome as MaterialParserOutcome));
    });
    worker.once("error", (error: Error) => finish(() => rejectPromise(error)));
    worker.once("exit", (code: number) => {
      if (code !== 0) {
        finish(() => rejectPromise(new Error(`material parse worker exited with code ${String(code)}`)));
      }
    });
    return {
      promise,
      cancel(): void {
        if (settled) return;
        worker.postMessage({ type: "cancel" });
        terminationTimer = setTimeout(() => {
          void worker.terminate();
        }, 100);
      },
    };
  }
}
