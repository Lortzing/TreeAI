/**
 * scripts/d4/browser/b3-probes.mjs — D4-3 材料 Branch/Return 浏览器探针
 * （issue #8 charter §3.3/B3 的用户路径浏览器面）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程。两种模式共用同一探针代码路径：
 *   - --mode real-pi   首问/追问发给真实 Pi（charter B3 证据的浏览器面）；
 *   - --mode selftest  echo 驱动（确定性回声）——同一 UI 流程的机制性冒烟，
 *                      探针代码路径的可达性证明，**永远不是 B3 证据**
 *                      （detail/sidecar 如实标注）。
 *
 * 用户路径（charter B3）：
 *   武装材料选区（markdown 与 pdf 各一）→ 建枝 → 提交前材料范围声明可见
 *   → 首问（真实 Pi；双击不重复派发 / 响应丢失重试诚实）→ 每枝 ≥2 轮追问
 *   → 跨枝隔离（回答不串枝）→ 重启续走（SIGTERM + 新进程后历史可读、
 *   追问继续落地）→ 回原文（精确摘录 + 定位到块）→ Return 携材料来源卡
 *   落主线 → Return 卡的「View material source」跳转。
 *
 * 探针纪律（与 material-probes.mjs 同款）：
 *   - 页面内操作全部真实 DOM/输入事件（CDP Input 真实点击/键入；建枝入口
 *     与复制按钮同款 DOM click——CDP press/release 分段会与 0ms 解除路径
 *     竞态）；绝不在页面里 fetch-shim 应用自身行为；
 *   - 响应丢失注入：CDP Fetch 域在 **Response 阶段** 拦截 material-first-question
 *     并 failRequest——请求已到达服务端并完整落地（echo/真实 Pi 皆然），
 *     仅响应被丢弃；这是「服务端已成功、客户端未见」的真实传输层模拟，
 *     不是请求丢失；
 *   - 服务器事实经真实 API 读回对账（分支 turn 集、幂等重放、跨枝隔离）；
 *   - 截图/JSON sidecar 入 artifacts；凭据零接触；失败如实。
 */

/** Stable public native browser probe entrypoint. */
export {
  probeBranchFromMaterial,
} from "./b3/branch.mjs";
export {
  probeReturnFromMaterial,
} from "./b3/return.mjs";
