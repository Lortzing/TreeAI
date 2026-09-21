# PI-CHANGE-<序号>：<一句话标题>

> 使用方式：复制本模板为 `docs/proposals/PI-CHANGE-<序号>.md`（序号从 001 递增，不重用）。
> 触发条件（任务书 §4.2）：需要修改 Pi 源码 / import Pi 未公开内部路径 / monkey patch 或编辑
> `node_modules` / 直接写 Pi session JSONL / 改变 `navigateTree`、steer、abort 或 session 恢复
> 语义 / 提高 Pi 版本或使用未固定版本 / SDK 缺陷迫使 TreeAI 改变已批准的产品语义。
> 出现任一情况，相关 Agent 必须停止该功能实现，先提交本提案。
> **未获负责人批准前，只允许写提案和失败测试**（任务书 §4.2 末段）。
> 状态标记：`PROPOSED` → `ACCEPTED` / `REJECTED`（由负责人决定；Agent 不得代填）。

- 提出者：Agent <ID>
- 日期：YYYY-MM-DD
- 涉及层级（任务书 §4.1）：L3（上游 issue/PR）/ L4（临时补丁、vendor、受控 fork）
- 状态：PROPOSED

## 1. 最小复现

（可第三方重放的复现步骤/脚本/证据路径；引用 `evidence/d2/` 或可复现命令）

## 2. 用户影响

（不改：TreeAI 用户会遇到什么；改了：行为如何变化）

## 3. 公开 API 为何不足

（列出已核对的 Pi 0.85.1 公开 SDK/API surface 及其缺口；引用 `d1-spikes/research/pi-capability-inventory.md` 或新证据）

## 4. L0–L2 方案为何失败

（逐层说明：L0 公开 SDK、L1 extension/custom tool/事件钩子、L2 PiRuntime 内 shim/错误归一化/状态补偿——每层为何不能达成目标）

## 5. 拟修改位置

（Pi 上游仓库/文件/符号；或 fork/补丁的落点与固定 commit）

## 6. 测试方案

（新增回归测试；如何证明补丁存在与否分别导致通过/失败）

## 7. 升级/回滚成本

（Pi 版本升级时此改动的维护成本；回滚步骤）

## 8. 是否可上游贡献

（是/否；上游 issue/PR 链接或计划）

## 负责人决定记录

（由负责人填写；Agent 不得代填）

- 决定：ACCEPTED / REJECTED / 附条件
- 日期：YYYY-MM-DD
- 备注：
