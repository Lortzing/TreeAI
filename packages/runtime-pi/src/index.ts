/**
 * @treeai/runtime-pi —— contracts.PiRuntime 的实现包。
 *
 * 公开面：
 * - `createPiRuntime(options?)`：创建运行时；默认使用真实 Pi SDK 端口
 *   （`@earendil-works/pi-coding-agent@0.85.1` 包根公开导出，见
 *   pi-real-port.ts 的 API surface 清单）。Pi 版本不一致在构造期抛
 *   `PiVersionMismatchError`。
 * - `PiRuntimeConfig` / `createPiRuntimeFromConfig(config)`：显式端口注入
 *   入口（单测用 fake port，不触真实 SDK）。
 *
 * Pi 类型隔离：本包外只见 contracts 领域类型；Pi 具体类型被限制在
 * pi-real-port.ts（唯一 import Pi 的文件）。事件/错误的脱敏义务在本包
 * 内完成（redact.ts / events.ts）。
 */

export {
  PINNED_PI_VERSION,
  PiVersionMismatchError,
  createPiRuntimeFromConfig,
} from "./pi-runtime.ts";
export type { PiRuntimeConfig } from "./pi-runtime.ts";

export {
  POLICY_DENIED_MARKER,
  TreeAIRuntimeError,
  classifyPiFailure,
  isPolicyDenied,
  markAsPolicyDenied,
} from "./errors.ts";
export { redactText, redactJsonValue } from "./redact.ts";
export type { PiSdkPort } from "./pi-sdk-port.ts";

import type { PiRuntime } from "@treeai/contracts";
import { createRealPiSdkPort } from "./pi-real-port.ts";
import { createPiRuntimeFromConfig } from "./pi-runtime.ts";
import type { PiRuntimeConfig } from "./pi-runtime.ts";

/** createPiRuntime 的公开选项（port 省略时使用真实 Pi SDK 端口）。 */
export type PiRuntimeOptions = Omit<PiRuntimeConfig, "port"> & {
  /** Pi SDK 端口覆盖（测试注入 fake）。 */
  readonly port?: PiRuntimeConfig["port"];
};

/**
 * 创建 PiRuntime（冻结契约 packages/contracts 的实现）。
 *
 * 构造期校验实际加载的 Pi 版本等于 contracts.PinnedPiVersion（"0.85.1"），
 * 不一致抛 PiVersionMismatchError（明确失败，绝不带病运行）。
 */
export function createPiRuntime(options?: PiRuntimeOptions): PiRuntime {
  const { port, ...rest } = options ?? {};
  return createPiRuntimeFromConfig({
    ...rest,
    port: port ?? createRealPiSdkPort(),
  });
}
