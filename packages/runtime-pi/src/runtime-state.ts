

import type {
  PiPromptResult,
  TreeAIError,
} from "@treeai/contracts";

import type {
  PiPortSession,
  PiPortSessionManager,
} from "./pi-sdk-port.ts";


export interface ActiveSession {
  readonly session: PiPortSession;
  readonly manager: PiPortSessionManager;
  readonly unsubscribe: () => void;
}

export interface InFlightRun {
  readonly session: PiPortSession;
  abortRequested: boolean;
  settled: boolean;
  /** 本次 run 期间的请求时策略拒绝（fail-closed 收敛依据；无则 null）。 */
  policyDenial: { readonly reason: string } | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  reject: (error: TreeAIError) => void;
  resolve: (result: PiPromptResult) => void;
}
