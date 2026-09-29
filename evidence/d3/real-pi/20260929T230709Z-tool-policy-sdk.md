# TreeAI D3 真实 Pi SDK 级工具策略记录【跑批器加固波（SDK 面 · --agent-dir 首跑）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）SDK 级工具策略驱动** ——
> 与 `20260929T223349Z-tool-policy-sdk.md`（`361f528`）同一驱动与断言面的
> 复跑，绑定跑批器加固波修复 SHA `ae5912b`。本跑是驱动新增
> `--agent-dir DIR` 旗标后的**首次实录**：worktree 内不再植入 `.pi-d2-live`
> 符号链接，直接以旗标指向主检出里的受控 agent 目录——该旗标即本波
> 对既往「符号链接」机制（`200022Z` / `223349Z` 等记录披露的临时手法）
> 的移除验证。同波浏览器面（summary off-by-one 修复 + echo 三连跑）见
> `../browser/20260929T230615Z-echo-product-loop.md`。

## 基本信息

- 记录 ID：`d3-realpi-20260929T230709Z-tool-policy-sdk`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:07:07–23:07:09Z，全程 2274ms）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定）：`ae5912b6ef07`（运行于该 SHA 的隔离 worktree；
  该 worktree 内**无** `.pi-d2-live`——agent 目录经新旗标指向主检出的
  受控目录，全程无符号链接植入/移除，porcelain 干净读数不再依赖链接处置；
  SDK 驱动不打印 git 读数，SHA 以运行时工作区 HEAD 为准）
- 记录类别：☑ SDK 级真实 Pi 操作　☑ 权限拒绝路径
- 驱动方式：`npm run build:live-policy` 后
  `TREEAI_LIVE_PROVIDER_ID=deepseek TREEAI_LIVE_MODEL_ID=deepseek-flash
  TREEAI_LIVE_API_KEY=<env> node --experimental-strip-types
  scripts/run-d3-real-pi-tool-policy.mjs --agent-dir <主检出受控 agent 目录>
  <out.json>`（旗标缺省仍为仓库根 `.pi-d2-live`；约定镜像
  `run-d3-real-pi.mjs` / `run-d3-browser.mjs` 的同名旗标——用法/帮助文本、
  `existsSync` 取值校验明确报错、缺省不变）

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

- **9 / 9 PASS**（REAL-PI TOOL POLICY: PASS，退出码 0；全程 2274ms——
  受控 marker/canary 直答的既知量级，与 `223349Z` 记录的约 2 秒同级）
- 覆盖：allow 控制读执行 + 证据；越权读（roots 外 canary）**执行前拒绝**；
  deny `tool.decision` 决策来源（决策载荷不含路径/参数）；blocked 结果携带
  策略原因；eager `runtime.error(policy-denied)`；canary 内容全程未被读入
  session 文件
- 事件窗口如实：deny 轮 `message.updated` 流式增量若干次后
  `tool.execution.started(read)` → `tool.decision(deny)` → eager
  `runtime.error(policy-denied)` → 收敛（与既往记录同形状）

## 本波发现

无（断言面与 `361f528` 基线逐项一致）。运行纪律注记：本跑全程未在
worktree 植入 `.pi-d2-live` 符号链接——`--agent-dir` 直指主检出受控目录
即跑通，这本身就是该旗标移除既往机制的验证；后续 worktree 内的 SDK 面
录制不再需要链接植入/移除步骤。
