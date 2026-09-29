# TreeAI D3 真实 Pi SDK 级工具策略记录【维护波重绑（SDK 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）SDK 级工具策略驱动** ——
> 与 `20260929T231642Z-tool-policy-sdk.md`（`1380a39`）同一驱动与断言面的
> 复跑，绑定维护波终点 SHA `a88ace5`
> （`a88ace54c8e5a0895a78a755d16ce3563cd1516f`；相对 `1380a39` 为纯
> evidence 文档提交，产品/驱动代码零变化）。本轮目的是把真实模型
> 证据面（SDK / API / 浏览器）全部重绑到同一 SHA——与同波 API 面
> （`20260929T234859Z-product-loop-tools.md`）与浏览器面
> （`../browser/20260929T235116Z-realpi-product-loop-tools.md`）汇合。

## 基本信息

- 记录 ID：`d3-realpi-20260929T234756Z-tool-policy-sdk`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:47:53–23:47:56Z 附近，
  全程 2548ms）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定）：`a88ace54c8e5`（运行于该 SHA 的隔离 worktree
  分支 `rec-realpi-a88ace5`；`git status --porcelain` 干净；该 worktree 内**无**
  `.pi-d2-live`、亦无任何 tool-policy 编译产物——agent 目录经旗标指向主检出
  受控目录，ToolPolicyEngine 经 `packages/tool-policy/src` 包源直接导入，
  全程无符号链接植入/移除、无构建步骤；SDK 驱动不打印 git 读数，SHA 以
  运行时工作区 HEAD 为准）
- 记录类别：☑ SDK 级真实 Pi 操作　☑ 权限拒绝路径
- 驱动方式：`TREEAI_LIVE_PROVIDER_ID=deepseek TREEAI_LIVE_MODEL_ID=deepseek-flash
  TREEAI_LIVE_API_KEY=<env> node --experimental-strip-types
  scripts/run-d3-real-pi-tool-policy.mjs --agent-dir <主检出受控 agent 目录>
  <out.json>`（自 `1380a39` 起无 `npm run build:live-policy` 前置——包源
  直接导入，本跑如实零构建前置通过，无 module-not-found）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry，
  与 D2 live 校验器同一受控目录，不入仓）
- 凭据说明：API key 仅经 `TREEAI_LIVE_API_KEY` 环境注入（本机
  `.env.d2-live.local` 同名定义）；值只在内存，未入任何记录/日志/evidence
  （记录中仅出现变量名）
- 脱敏 transcript 附件：同记录 ID sidecar 目录 `transcript.json`
  （布尔/事件白名单/时长，无文件内容、无绝对路径、无凭据——入库前经
  secret scan 扫描通过）
- OS / 目标机器：macOS（arm64），本机 trusted-local

## 结果

- **9 / 9 PASS**（REAL-PI TOOL POLICY: PASS，退出码 0；全程 2548ms——
  受控 marker/canary 直答的既知量级，与 `231642Z` 记录的 1837ms 同级
  正常方差）
- 覆盖：allow 控制读执行 + 证据（`ruleId=allow-read-configured-roots`，
  1 次执行开始、终答落地、fixture 进入 session）；越权读（roots 外
  canary）**执行前拒绝**（`code=policy-denied`）；deny `tool.decision`
  决策来源（决策载荷不含路径/参数）；blocked 结果携带策略原因；eager
  `runtime.error(policy-denied)`；canary 内容全程未被读入 session 文件
- 事件窗口如实：deny 轮 `tool.execution.started(read)` →
  `tool.decision(deny)` → eager `runtime.error(policy-denied)` → 收敛
  （与既往记录同形状）

## 本波发现

无（断言面与 `1380a39` 基线逐项一致）。重绑注记：`a88ace5` 相对
`1380a39` 为纯 evidence 文档提交，SDK 面驱动路径与断言面零变化；本跑
完成后三面真实模型证据全部绑定 `a88ace5`（worktree 内 SDK 面录制前置
仍仅 `npm ci`）。
