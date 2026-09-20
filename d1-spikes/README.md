# TreeAI D1 Pi 接入验证包

## 当前状态

D1 技术验证已完成实验性收口，尚未完成负责人签字：

- 五个统一场景（basic/tool/steer/abort/resume）：SDK 与 RPC 双侧均 `PASS`
- tree-navigation 补充探针：两侧均完成真实证据；RPC 不提供 SDK `navigateTree` 等价命令
- clean-room reproduction：SDK 与 RPC 均通过
- 最新统一验收：以 `d1-spikes/scripts/verify-d1` 的最新 JSON 结果为准
- ADR-001：`Proposed`，未批准
- 最终路线、权限策略和 Go/Conditional Go/No-Go：`PENDING_OWNER`

本目录是可删除的 D1 spike，不是正式产品代码。D1 不创建 TreeAI 领域数据库、Web UI 或通用 RuntimeAdapter。

## 固定实验基线

| 项目 | 值 |
|---|---|
| Pi coding agent | `@earendil-works/pi-coding-agent@0.85.1` |
| Node.js | `v24.21.0` |
| SDK/RPC provider | `tal-token-plan-06c64a09` |
| SDK/RPC model | `deepseek-v4.1-flash` |
| thinking | `off` |
| SDK 包管理器 | npm 11.19.0 + `sdk-node/package-lock.json` |
| RPC 运行时依赖 | Python 标准库；`rpc-python/requirements.txt` 为空依赖锁定 |

凭据只从 Pi 已配置的认证来源或现有环境变量读取。不得把 API Key 写入仓库、证据、命令记录或归档包。

## 目录索引

- `research/`：能力清单、SDK/RPC 对照矩阵、ADR-001 草案
- `sdk-node/`：Node.js/TypeScript + Pi SDK 探针
- `rpc-python/`：Python + Pi RPC 子进程探针
- `fixtures/`：确定性输入和只读 fixture
- `schemas/`：事件与场景结果 JSON Schema
- `scripts/`：验收、秘密扫描、schema 校验和临时运行目录工具
- `evidence/sdk/`：SDK 五场景和 tree-navigation 原始证据
- `evidence/rpc/`：RPC 五场景、tree-navigation 和崩溃清理证据
- `evidence/verification/`：验收、复现、秘密扫描和失败路径证据
- `reports/`：最终验收报告与负责人待决事项

## 可复现命令

在仓库根目录执行：

```bash
d1-spikes/scripts/verify-d1
```

执行 clean-room reproduction：

```bash
d1-spikes/scripts/verify-d1 --repro
```

执行失败路径和安全自测：

```bash
d1-spikes/scripts/selftest-infra
d1-spikes/scripts/check-secrets d1-spikes
d1-spikes/scripts/schema-check --selftest
```

单独运行 SDK 五场景：

```bash
PI_PROBE_MODEL=tal-token-plan-06c64a09/deepseek-v4.1-flash \
PI_PROBE_THINKING=off \
npm --prefix d1-spikes/sdk-node run probe:all
```

单独运行 RPC 五场景：

```bash
python3 d1-spikes/rpc-python/probe.py run \
  --provider tal-token-plan-06c64a09 \
  --model deepseek-v4.1-flash \
  --thinking off
```

树导航补充探针：

```bash
npm --prefix d1-spikes/sdk-node run probe:tree-nav
python3 d1-spikes/rpc-python/probe.py tree-nav
```

## 证据规则

每次真实运行创建新的证据路径，不覆盖历史失败记录。事件 JSONL 必须逐行可解析、`seq` 严格递增、payload 脱敏；场景结果必须能追溯到事件文件和可信退出码。tree-navigation 是收口补充探针，不属于任务书定义的五个统一场景；其 scenario 枚举是否纳入共享 Schema 仍由负责人决定。

完整事实、推断、限制和待决事项见：

- `reports/d1-verification.md`
- `reports/blockers.md`
- `research/sdk-vs-rpc-matrix.md`
- `research/adr-001-draft.md`

## 负责人待决事项

- SDK 直嵌还是 RPC 子进程
- 正式宿主语言与版本基线
- 是否接受 SDK 同进程权限风险
- 产品工具和目录权限
- 是否批准 ADR-001
- D1 Go/Conditional Go/No-Go
- 是否正式确认当前 provider/model/thinking 基线
- 是否将 tree-navigation 纳入共享场景契约

实验结果已准备好供负责人复现和审阅；本 README 不替负责人做架构批准或最终签字。
