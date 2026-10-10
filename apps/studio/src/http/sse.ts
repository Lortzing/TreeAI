/** Tree-scoped Studio SSE stream, snapshot-first, heartbeats and idempotent cleanup. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TreeId } from "@treeai/contracts";
import type { TreeDiagnostics, TreeStudioService } from "../service.ts";

const SSE_HEARTBEAT_MS = 15_000;

export function createSseStream(service: TreeStudioService, sseResponses: Set<ServerResponse>) {
  function startSseStream(req: IncomingMessage, res: ServerResponse, treeId: TreeId, snapshot: TreeDiagnostics): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const writeEvent = (name: string, data: unknown): void => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    writeEvent("snapshot", snapshot);
    const unsubscribe = service.subscribeStudioEvents((event) => {
      if (event.treeId !== treeId) return;
      writeEvent(event.type, event);
    });
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    sseResponses.add(res);
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      sseResponses.delete(res);
      res.end();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  return startSseStream;
}
