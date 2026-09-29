# TreeAI D3 真实 Pi SDK 级工具策略记录【维护波合并验证（SDK 面 · 包源导入首跑）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）SDK 级工具策略驱动** ——
> 与 `20260929T230709Z-tool-policy-sdk.md`（`ae5912b`）同一驱动与断言面的
> 复跑，绑定维护波合并终点 SHA `1380a39`
> （`1380a3967f7630763a2caf9f2f2ac935a83e08f4`）。本跑是驱动
> `ToolPolicyEngine` 导入改指 `packages/tool-policy/src/index.ts`（`1380a39`
> 重接线——D2 限制 #7 关闭后根 `build:live-policy` 与
> `apps/runtime-smoke/dist/tool-policy` 编译副本均已移除）后的**首次实
> 录**：全程零构建前置直接以 `--agent-dir` 旗标指向主检出受控 agent 目
> 录运行。同波浏览器面（合并验证 echo 三连跑）见
> `../browser/20260929T231541Z-echo-product-loop.md`。

## 基本信息

- 记录 ID：`d3-realpi-20260929T231642Z-tool-policy-sdk`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:16:42Z 附近，全程
  1837ms）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定）：`1380a3967f76`（运行于该 SHA 的隔离 detached
  worktree；该 worktree 内**无** `.pi-d2-live`、亦无任何 tool-policy 编译
  产物——agent 目录经旗标指向主检出受控目录，ToolPolicyEngine 经包源
  直接导入，全程无符号链接植入/移除、无构建步骤；SDK 驱动不打印 git
  读数，SHA 以运行时工作区 HEAD 为准）
- 记录类别：☑ SDK 级真实 Pi 操作　☑ 权限拒绝路径
- 驱动方式：`TREEAI_LIVE_PROVIDER_ID=deepseek TREEAI_LIVE_MODEL_ID=deepseek-flash
  TREEAI_LIVE_API_KEY=<env> node --experimental-strip-types
  scripts/run-d3-real-pi-tool-policy.mjs --agent-dir <主检出受控 agent 目录>
  <out.json>`（自 `1380a39` 起无 `npm run build:live-policy` 前置——该脚本
  已随包入口关闭移除；用法文本同步更新）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry，
  与 D2 live 校验器同一受控目录，不入仓）
- 凭据说明：API key 仅经 `TREEAI_LIVE_API_KEY` 环境注入（本机
  `.env.d2-live.local` 同名定义）；值只在内存，未入任何记录/日志/evidence
  （记录中仅出现变量名）
- 脱敏 transcript 附件：同记录 ID sidecar 目录 `transcript.json`
  （布尔/事件白名单/时长，无文件内容、无绝对路径、无凭据——入库前经
  仓内 secret scanner 扫描通过）
- OS / 目标机器：macOS（arm64），本机 trusted-local

## 结果

- **9 / 9 PASS**（REAL-PI TOOL POLICY: PASS，退出码 0；全程 1837ms——
  受控 marker/canary 直答的既知量级，与 `230709Z` 记录的 2274ms 同级）
- 覆盖：allow 控制读执行 + 证据；越权读（roots 外 canary）**执行前拒绝**；
  deny `tool.decision` 决策来源（决策载荷不含路径/参数）；blocked 结果携带
  策略原因；eager `runtime.error(policy-denied)`；canary 内容全程未被读入
  session 文件
- 事件窗口如实：deny 轮 `tool.execution.started(read)` →
  `tool.decision(deny)` → eager `runtime.error(policy-denied)` → 收敛
  （与既往记录同形状）

## 本波发现

无（断言面与 `ae5912b` 基线逐项一致）。运行纪律注记：本跑为包源直接导入
的首个真实模型实录——`1380a39` 重接线后 SDK 面录制不再需要
`build:live-policy` 编译前置，与 `--agent-dir` 旗标（`230709Z` 首验）叠加
后，worktree 内 SDK 面录制的前置仅剩 `npm ci`。
