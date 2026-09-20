# TreeAI D1 Pi 接入验证包

## 当前状态

D1 已由负责人批准为 **Go**，并授权进入 D2；这不是生产发布批准：

- 首版路线：TypeScript/Node.js + Pi SDK 进程内直嵌
- Pi：`0.85.1`
- 风险边界：仅受信任本地模式接受同进程风险；同进程不构成沙箱
- 权限边界：fixtures/负责人授权目录可读；shell、网络默认拒绝；高风险操作逐次授权
- 五个统一场景：SDK 与 RPC 双侧均 `PASS`
- tree-navigation：已加入共享 scenario 契约和统一验收；RPC 无 SDK `navigateTree` 等价命令
- clean-room reproduction：SDK 与 RPC 均通过
- ADR-001：`Accepted`（2026-09-20）
- D2：已授权；正式工程与生产发布仍需独立门槛

本目录是可删除的 D1 spike，不是正式产品代码。D1 证据通过不等于生产发布；D2 负责提炼已验证逻辑，生产发布还需要目标设备人工验收、权限审查和发布门禁。

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

每次真实运行创建新的证据路径，不覆盖历史失败记录。事件 JSONL 必须逐行可解析、`seq` 严格递增、payload 脱敏；场景结果必须能追溯到事件文件和可信退出码。tree-navigation 现为共享契约中的补充场景，规范名为 `tree-navigation`，历史 SDK `tree-nav` 为兼容别名；它独立于五个核心场景的 runs 完整性判断。

完整事实、推断、限制和待决事项见：

- `reports/d1-verification.md`
- `reports/blockers.md`
- `research/sdk-vs-rpc-matrix.md`
- `research/adr-001-draft.md`

## D2 与生产发布边界

D1 Go 只批准进入 D2 正式工程化，不等于生产发布批准。D2 按 ADR-001 的边界提炼 PiRuntime、TreeRepository、SessionReference、EventJournal 和 ToolPolicy；TreeAI 自有数据库仍是产品事实源。生产发布还必须满足目标设备人工验收、权限审查、异常状态清理和独立 CI/发布门禁。

## 已决定事项

D1 路线、宿主、Pi 版本、受信任本地同进程风险、最小权限、ADR-001、D1 Go、统一 provider/model 基线和 tree-navigation 契约均已由负责人记录关闭；完整历史和批准记录见 `reports/blockers.md`。GitHub D2 milestone/issue 因本机 `gh` CLI 未安装暂未创建，状态见同文件的 GitHub D2 跟踪段。
