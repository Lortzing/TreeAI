/* TreeAI Studio — implementation notes moved to docs/architecture/studio-ui-implementation-notes.md.
 * Keep behavior here; historical decisions and long explanatory notes belong in docs.
 */

"use strict";

import { createStudioApp } from "./core/create-studio-app.js";

// Browser bootstrap: use the same state factory as scripted-DOM tests.
const studioApp = createStudioApp({
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  crypto: globalThis.crypto,
});
studioApp.start();
