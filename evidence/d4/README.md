# evidence/d4/ — D4 证据区（追加式）

- 区域维护：D4 波次集成侧（D4-0 建立，2026-09-30）。依据：《D4 项目书
  v1.1》（issue #8）§8「每轮交付到 `evidence/d4/`：完整运行 SHA、环境、
  命令、退出码、fixture hash、逐项结果、脱敏浏览器/模型证据、限制」。
- 范围与验收矩阵：`docs/d4/D4-project-v1.md`（项目书镜像）与
  `docs/d4/D4-status.md`（独立状态矩阵）。

## 目录

| 子目录 | 内容 | 写入者 |
| --- | --- | --- |
| `runs/` | `verify:d4`（离线门禁）自动产物：`d4-offline-<UTC>/`（environment.json / result.json / checks.json / events.jsonl / logs/） | 验证脚本（追加式，不覆盖） |
| `selftest/` | `verify:d4:selftest` 失败路径注入自测产物：`d4-selftest-<UTC>/child-runs/<scenario>/` | 自测脚本 |
| `browser/` | `run:d4-browser` 浏览器证据（骨架 boot 检查 / 后续 D4 用户路径录制；截图与 summary 脱敏） | 自动化 / 授权操作者 |

## 规则（沿用 evidence/d2、evidence/d3 纪律）

1. **只追加，不覆盖**：历史运行目录不改写；失败与 BLOCKED 记录同样保留。
   运行目录重名时验证器自动加 `-2` 后缀。
2. **绑定 commit SHA**：每条记录必须写明运行时工作区的完整 commit SHA；
   运行与证据提交 SHA 不同时，记录须列代码差异及适用边界（项目书 §8）。
3. **秘密纪律**：所有写入先脱敏（HOME → `~`）并经 secret scan；真实凭据
   只经 `TREEAI_STUDIO_API_KEY` 环境注入，不落命令、截图、证据或 Issue。
4. **诚实分级**：报告区分「本轮执行 / 仓库记录 / 代码推断 / 无法验证」；
   离线绿 ≠ 最终门禁；B3/B7/B8 的真实 Pi、浏览器与人工证据属
   `run:d4-browser --mode real-pi` 与 D4-G3 人工顺序，不以离线结果替代。
5. **fixture hash**：引用 `tests/fixtures/d4/` 冻结集的运行必须记录其
   `MANIFEST.sha256` 的 SHA-256（哈希的哈希），保证证据与冻结集绑定。
