# D4 冻结验收集（tests/fixtures/d4）

这是《D4 项目书 v1.1》（issue #8）§6 要求的**固定 fixture/答案/查询集**，
按「优化前入仓」纪律随 D4-0 冻结。格式契约见
[docs/d4/D4-contracts.md §6](../../../docs/d4/D4-contracts.md)；机械校验由
`tests/support/verifier/d4-probes.ts`（`verifyD4FixturesIntegrity`）执行，
三个消费方共用同一校验逻辑：`tests/unit/d4-fixtures-integrity.test.ts`、
`scripts/verify-d4.js`（检查 `fixtures-integrity-d4`）、
`scripts/verify-d4-selftest.js`（注入缺陷并断言 FAIL）。

## 分册

| 目录 | 内容 | 验收行 |
|---|---|---|
| `b1-import/` | ≥12 Markdown + ≥12 文字层 PDF + ≥8 负例 + 版本对；每个 ready fixture 附 `*.expected.json` 真值（canonicalText + block map） | B1 |
| `b2-anchors/` | Markdown/PDF 各 ≥30 个有效选区 + ≥12 个无效/变更/不支持选区；选区经 locator 机械解析，不信任手写偏移 | B2 |
| `b4-search/` | ≥40 正向查询 + ≥10 无结果查询 + 种子产品事实（3 棵树） | B4 |
| `b6-scale/spec.json` | 规模数据集规格+种子（生成器随 D4-6 按本规格实现） | B6 |
| `b9-nav/spec.json` | 大规模树结构规格+种子（生成器随 D4-8 按本规格实现） | B9 |

## 冻结纪律

- 本树所有文件哈希钉在 `MANIFEST.sha256`；探针重算并比对，任何
  篡改/增删/改名都会 FAIL `fixtures-integrity-d4`。
- **有意变更** fixture 后，从本目录重生成清单并同提交：
  `find . -type f ! -name MANIFEST.sha256 | sort | shasum > MANIFEST.sha256`
- 注意根目录 `tests/fixtures/MANIFEST.sha256`（D2 门禁）覆盖整个
  `tests/fixtures/` 树——D4 变更后须按 `tests/README.md` 配方一并重生成
  根清单。
- **失败样例不得事后移出分母**（charter B2）；降低阈值=范围变更，须回
  负责人，不得改探针常量。
- `b1-import` 另有 3 个超限负例（>20MiB / >200 页 / >100 万 UTF-16 单元）
  不作为提交文件：体积/规模超出仓内合理体积，按 `manifest.json` 的
  `generatedOversize` 登记在验证时按规格确定性生成。
- 生成工具（非冻结数据本身）：`scripts/d4/gen-pdf-fixtures.mjs`（PDF 真值
  生成器）、`scripts/d4/reference-markdown-normalizer.mjs`（d4-md-v1 参考
  归一化器）。真值文件一经冻结以仓内哈希为准；重新运行生成器必须产出
  逐字节相同的输出（确定性），否则视为破坏冻结。
