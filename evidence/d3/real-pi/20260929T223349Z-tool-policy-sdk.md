# TreeAI D3 真实 Pi SDK 级工具策略记录【视觉重构波（SDK 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）SDK 级工具策略驱动** ——
> 与 `20260929T200022Z-tool-policy-sdk.md`（`0f9df98`）同一驱动与断言面的
> 复跑，绑定视觉重构波最终 SHA `361f528`。SDK 驱动不触 UI 静态文件，
> 行为逐字一致；同波 API / 浏览器 / 离线面记录见本目录与 `../browser/`。

## 基本信息

- 记录 ID：`d3-realpi-20260929T223349Z-tool-policy-sdk`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T22:33:47–22:33:49Z）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定）：`361f528fe675`（运行于该 SHA 的隔离 detached
  worktree；SDK 驱动的 agentDir 硬编码为仓库根 `.pi-d2-live`——worktree 内
  以符号链接指向真实受控目录后运行，运行前移除该链接以保持 studio 面跑批器
  的 porcelain 干净读数；机制与 `0f9df98` 波 `200022Z` 记录披露一致）
- 记录类别：☑ SDK 级真实 Pi 操作　☑ 权限拒绝路径
- 驱动方式：`npm run build:live-policy` 后
  `TREEAI_LIVE_PROVIDER_ID=deepseek TREEAI_LIVE_MODEL_ID=deepseek-flash
  TREEAI_LIVE_API_KEY=<env> node --experimental-strip-types
  scripts/run-d3-real-pi-tool-policy.mjs <out.json>`

## 结果

- **9 / 9 PASS**（REAL-PI TOOL POLICY: PASS，退出码 0；全程约 2 秒——
  受控 marker/canary 直答的既知量级）
- 覆盖：allow 控制读执行 + 证据；越权读（roots 外 canary）**执行前拒绝**；
  deny `tool.decision` 决策来源（决策载荷不含路径/参数）；blocked 结果携带
  策略原因；eager `runtime.error(policy-denied)`；canary 内容全程未被读入
  session 文件
- 脱敏 transcript 附件：同记录 ID sidecar 目录 `transcript.json`（已扫描，
  无凭据标记）

## 本波发现

无。与 `0f9df98` 基线逐项一致。
