# evidence/d3/ — D3 证据区（追加式）

- 区域维护：Integrator 起草目录与规则；`real-pi/` 与 `trials/` 的记录由
  负责人（或其授权操作者）写入；`offline/` 由自动化验证产出。
- 依据：GitHub issue #2《D3 验收：Gate 2 No Go 与修订方案》（2026-09-29）
  的 Go 条件：另提交 `evidence/d3/` 下的**真实 Pi Studio 操作证据、
  故障/幂等测试、设计对照与 3–5 人试用记录**；只有 Gate 0–2 和 A1–A7
  **同 SHA** 全部满足、负责人签署后，才改为 D3 Go。

## 目录

| 子目录 | 内容 | 写入者 |
| --- | --- | --- |
| `offline/` | 自动化离线证据（Studio 测试 / verify 运行产物、环境、绑定 SHA） | 验证脚本 |
| `real-pi/` | 真实 Pi Studio 操作记录（环境、脱敏 ID、操作录屏占位、故障注入与幂等序列） | 负责人 / 授权操作者 |
| `trials/` | 3–5 人独立试用记录（同一任务脚本、卡点、耗时、修复、复测） | 负责人组织记录 |
| `templates/` | 记录模板（`run-record.md`） | Integrator |

## 规则

1. **只追加，不覆盖**：禁止删除或改写任何历史记录；失败与 BLOCKED 的
   记录同样保留（沿用 `evidence/d2/` 的纪律）。
2. **绑定 commit SHA**：每条记录必须写明其运行时工作区的 commit SHA；
   Go 条件要求全部证据同 SHA。
3. **秘密纪律（先扫描后入库）**：任何内容写盘前与写盘后均须 secret scan
   （沿用 `evidence/d2/` 与 Agent F 的扫描规则）；不得出现 API key、token、
   cookie、session 文件路径、主机用户名 / 绝对路径。发现泄露按验收器规则
   隔离处理并追加说明，历史记录不改写。
4. **脱敏 ID**：Tree / Branch / Run / Return / Turn 标识以**可区分的脱敏
   形式**记录（足以对照即可，如前 8 位）；不记录任何可反推真实环境的
   路径、用户名、主机名；录屏等二进制不入仓，记录内只留归档链接占位。
5. **Echo 不得替代真实证据**：离线 Echo / D2-live 结果**永远不能**替代
   真实 Pi Studio 证据（issue #2 明确）。`offline/` 的记录只证明自动化
   回归，不进入真实 Pi 验收口径，也不得写入 `real-pi/` 冒充。
6. **不声明门禁结论**：本区只记录事实——状态词 PASS / FAIL / BLOCKED /
   NOT_RUN、退出码 0/1/2/3 沿用 D2 约定（`coordination/d2/README.md`）；
   Gate 0–2 与 A1–A7 的结论由负责人签署，状态记录见
   `docs/d3/D3-status.md`。
