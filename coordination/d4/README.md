# D4 协调区（D4-0 建立，2026-09-30）

按《D4 项目书 v1.1》（issue #8）§4：「新增依赖、迁移编号、公共契约由集成
负责人统一协调」。本目录是 D4 波次的协调登记处，由 D4 集成侧维护；各工作包
动下列资源前必须先在此登记领取。

## 迁移编号登记（packages/persistence/src/migrations/）

已交付：0001–0007（D2/D3，不可修改——见 `packages/persistence/README.md` 与
`coordination/d2/agent-c-handoff.md` 的冻结纪律）。

| 编号 | 名称 | 归属 | 状态 |
|---|---|---|---|
| 0008 | material-core（materials / material_blobs / material_versions / tree_material_links / material_branch_origins / tree_material_reading_state / material_first_questions / branches.origin_kind） | D4-1 | 已在设计（`docs/d4/D4-contracts.md` §2）中预留，未实现 |
| 0009 | search-index（可重建索引表，实现由 D4-4 决定） | D4-4 | 预留；若最终不需要库内索引表，须在此记录弃用原因并保持编号连续性约束（`assertContiguous`） |
| 0010 | export-metadata（D4-5 导出包所需库内元信息） | D4-5 | 预留；同上 |

规则：并行波次添加迁移前先在此占号；编号必须连续递增；已交付迁移不可修改。

## 公共契约登记（packages/contracts）

| 变更 | 性质 | 依据 |
|---|---|---|
| 新增 `src/material.ts`（MaterialId/MaterialVersionId/Material/…，纯类型） | 纯增量（non-breaking addition），按 `docs/d2/contracts-README.md` 记录即可 | ADR-003、`docs/d4/D4-contracts.md` §1 |
| `product.ts` 既有类型 | 不改动 | ADR-003 §6 |

## ADR

- ADR-003（D4 材料来源类型、不可变版本与运行起点）：`docs/adr/ADR-003-d4-material-sources-versions-run-origins.md`（Accepted 2026-09-30，来源 issue #8 D4-0 指定交付）。

## 验收入口与冻结集

- `npm run verify:d4` / `verify:d4:selftest` / `run:d4-browser`（§8 要求的新入口；D4-0 交付骨架）。
- 冻结验收集：`tests/fixtures/d4/`（B1/B2/B4 内容集 + B6/B9 规模规格；改动须重生成其 `MANIFEST.sha256` 并同提交，且失败样例不得移出分母）。
- 注意：`tests/fixtures/MANIFEST.sha256`（D2 门禁）覆盖整个 `tests/fixtures/` 树——D4 fixture 变更后须按 `tests/README.md` 的配方一并重生成根清单。

## 新增依赖

无（D4-0 零新增 npm 依赖；PDF fixture 生成器为 Node 内置模块实现）。
后续工作包如需新增依赖，先在此登记理由与替代方案评估，再动 package.json。
