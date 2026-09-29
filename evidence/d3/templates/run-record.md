# 真实操作记录模板（run record）

> 复制本模板到 `evidence/d3/real-pi/<UTC-run-id>.md` 或
> `evidence/d3/trials/<trial-id>/person-<n>.md` 后填写。所有字段必填；
> 无法提供的字段写明原因，不得留空、不得伪装。区域规则见
> `evidence/d3/README.md`（追加式、绑定 SHA、脱敏、secret scan、不声明
> 门禁结论）。

## 基本信息

- 记录 ID：`d3-<类别>-<UTC 时间戳>`
- 日期（本地时区）：
- 操作人（编号 / 角色，不留姓名）：
- commit SHA（运行时工作区 HEAD）：
- 记录类别：☐ 真实 Pi 操作　☐ 故障注入　☐ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：
- npm：
- Pi（`@earendil-works/pi-coding-agent`）：
- OS / 目标机器（目标 Mac 说明；不含用户名 / 序列号）：
- Studio 启动参数（driver / provider / model）：
- 凭据说明（只写"已通过 `TREEAI_STUDIO_API_KEY` 注入"之类，**绝不写值**）：

## 操作步骤（逐条）

1. …（做了什么、在哪个屏幕、预期是什么；试用记录另注明任务脚本版本）

## 脱敏 ID 清单

- Tree：`tree:________…`
- Branch：`branch:________…`
- Run：`run:________…`
- Return：`return:________…`

（可区分即可，如前 8 位；不记录 session 文件路径、绝对路径、用户名。）

## 注入的故障（如无写"无"）

- 故障类别（响应丢失 / 双击 / 并发 / 缺失 session / 重启收敛 / 中止 / 模型错误）：
- 注入方式（不涉及任何凭据）：
- 观察到的行为（含 HTTP 状态码 / 错误码 / UI 呈现，如实）：

## 结果

- 结论：PASS / FAIL / BLOCKED / NOT_RUN（沿用 D2 状态词；FAIL 附阻断点）
- 与预期的偏差（如实，含 UI 层现象）：

## 证据附件

- 录屏 / 截图归档位置（链接占位，不入仓）：`<链接或归档路径>`
- 相关自动化日志（如有）：`evidence/d3/offline/<run-id>`

## 复测（仅阻断问题修复后追加；不改写上方原始记录）

- 对应修复 commit SHA：
- 复测日期 / 操作人：
- 复测结论（PASS / FAIL / BLOCKED / NOT_RUN）与残余问题：
