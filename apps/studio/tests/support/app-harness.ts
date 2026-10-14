/**
 * The eight Studio scripted-DOM suites use one shared, instance-backed loader.
 * Importing the factory (rather than an inlined data: URL or reloading app.js)
 * isolates state per harness and preserves normal relative ESM resolution.
 * Test suites still provide their existing DOM, network and SSE stubs.
 */
export async function mountStudioApp(): Promise<{ start(): void; dispose(): void }> {
  const file = new URL("../../public/core/create-studio-app.js", import.meta.url);
  const factory = await import(file.href) as {
    createStudioApp(deps: Record<string, unknown>): { start(): void; dispose(): void };
  };
  const env = globalThis as unknown as Record<string, unknown>;
  const app = factory.createStudioApp({
    window: env["window"],
    document: env["document"],
    fetch: env["fetch"],
    EventSource: env["EventSource"],
    navigator: env["navigator"],
    localStorage: env["localStorage"],
    crypto: env["crypto"],
  });
  app.start();
  return app;
}
