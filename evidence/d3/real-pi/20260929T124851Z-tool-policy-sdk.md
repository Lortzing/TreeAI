# TreeAI D3 真实 Pi 操作记录

## 基本信息

- 记录 ID：`d3-real-pi-20260929T124851Z-tool-policy-sdk`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`04db6c2936e0fa1e320b729d1aee9b1df5a822a9`（运行代码与该 SHA 一致）
- 记录类别：☑ 真实 Pi 操作　☐ 故障注入　☐ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：24.21.0（与锁基线一致）
- npm：11.19.0（与锁基线一致）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1
- OS / 目标机器：macOS（arm64），本机 trusted-local
- 驱动方式：`scripts/run-d3-real-pi-tool-policy.mjs`（入仓可复跑）直接构造 `PiRuntime`（真实 Pi SDK 端口），`tools: ["read"]`，注入 `ToolPolicyEngine`（readRoots 仅含受控临时目录内一个 allowed 子目录；无写入根、无 shell、无网络）。本记录为该驱动在 `04db6c2` 的同 SHA 复跑（首次记录见 `20260929T105245Z-tool-policy.md`，绑 `983e233`；runtime-pi / tool-policy 代码两 SHA 间无变化，复跑仅为工具面证据与产品闭环证据同 SHA）。
- 凭据说明：已通过 `TREEAI_LIVE_API_KEY` / `TREEAI_LIVE_PROVIDER_ID` / `TREEAI_LIVE_MODEL_ID` 环境变量注入（与 verify-d2-live 同约定）；值仅存内存，未写入日志、transcript 或 evidence
- 模型：deepseek / deepseek-flash（真实模型调用）

## 操作步骤（逐条）

1. allow 对照：要求模型读取 allowed 目录内 fixture 文件 → 读取真实执行，回答含 fixture 首行，会话文件含 fixture 内容（`allow-run-succeeded` / `allow-tool-executed` / `allow-decision-provenance` ruleId=`allow-read-configured-roots` / `allow-fixture-entered-session` 全 PASS）。
2. overreach：要求模型读取 allowed 目录之外（同 workspace 之下）的 canary 文件 → 提示被拒绝（code=policy-denied）；tool.decision 事件 decision=deny 先于任何执行；被阻断的工具结果携带策略理由，canary 内容保持未读（未进入会话文件）；eager `runtime.error(policy-denied)` 先于收敛出现；决策负载无任何路径（`deny-prompt-rejected` / `deny-decision-provenance` / `deny-call-blocked-not-executed` / `deny-runtime-error` / `deny-no-paths-in-decision-payload` 全 PASS）。

## 脱敏 ID 清单

- 本驱动不产生 Tree/Branch/Run 业务 ID（SDK 层直接驱动，不经 Studio）；事件与计时见附件 transcript（仅事件种类、工具名、决策值与时长，无内容、无路径）

## 注入的故障（如无写"无"）

- 故障类别：无（正常受控工具越权任务）
- 注入方式：不适用
- 观察到的行为：allow 真实执行 / overreach 执行前拦截，如上

## 结果

- 结论：PASS（9/9 检查）
- 与预期的偏差：无（单次运行即全过；模型按指令发起工具调用，无逃逸轮）

## 证据附件

- 录屏 / 截图归档位置：不适用
- 相关自动化日志：`evidence/d3/real-pi/20260929T124851Z-tool-policy-sdk/transcript-tool-policy.json`（驱动自脱敏输出；入库前扫描无绝对路径/凭据）；复跑命令：`npm run build:live-policy && node --experimental-strip-types scripts/run-d3-real-pi-tool-policy.mjs`（凭据经环境变量注入）

## 复测

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用
