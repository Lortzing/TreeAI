# D4 契约与迁移设计（D4-0 交付：DTO/API 与迁移设计）

版本：1.0（2026-09-30，随 D4-0 入仓）
上游：[D4 项目书 v1.1](./D4-project-v1.md)（issue #8 镜像）、[ADR-003](../adr/ADR-003-d4-material-sources-versions-run-origins.md)。
状态：**设计基线**。本文是 D4-1～D4-5 实施的契约起点；实现差异须回写本文并记录原因，不得静默偏离。本文不是「已完成」声明——全部 API/迁移在对应工作包落地前均为未实现。

## 1. 契约类型（packages/contracts/src/material.ts，纯类型增量）

按 ADR-003 §2/§3 的决策落地为类型。标识符沿用 branding 模式（`Brand<T, K>`）。

```ts
export type MaterialId = Brand<string, "MaterialId">;
export type MaterialVersionId = Brand<string, "MaterialVersionId">;

export type MaterialParseStatus =
  | "pending" | "parsing" | "ready"
  | "failed" | "canceled" | "unsupported" | "rejected";

export type MaterialParserKind = "markdown" | "pdf";

export interface MaterialBlock {
  readonly blockId: string;                    // "blk-N"（markdown）/ "page-N"（pdf）
  readonly kind: "markdown-block" | "pdf-page";
  readonly start: number;                      // canonicalText 内 UTF-16 半开区间
  readonly end: number;
  readonly page?: number;                      // pdf-page 专有，1-based
}

export interface Material {
  readonly id: MaterialId;
  readonly title: string;                      // 可编辑显示名；不是身份
  readonly createdAt: IsoTimestamp;
}

export interface MaterialVersion {
  readonly id: MaterialVersionId;
  readonly materialId: MaterialId;
  readonly contentHash: string;                // 原件字节 SHA-256
  readonly parserKind: MaterialParserKind;
  readonly parserVersion: string;              // "d4-md-v1" / "d4-pdf-v1"
  readonly importedAt: IsoTimestamp;
  readonly sizeBytes: number;
  readonly parseStatus: MaterialParseStatus;
  readonly parseError: string | null;          // failed/unsupported/rejected 的原因码+说明
  readonly textUnits: number;                  // canonicalText UTF-16 长度
  // canonicalText 与 blockMap 不在本接口：按块分页读取（见 API）
}

export interface MaterialSelection { /* ADR-003 §2 */ }
export interface MaterialBranchOrigin { /* ADR-003 §2 */ }

export interface MaterialReadingPosition {
  readonly treeId: TreeId; readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly blockId: string | null;             // 最后阅读块
  readonly focusStart: number | null;          // 可选：块内关注区间
  readonly updatedAt: IsoTimestamp;
}
```

搜索与导出的 DTO 见 §4/§5。**Turn 来源契约零改动**；材料来源经 `getBranchOrigin` 统一读取。

## 2. 存储 schema（迁移 0008–0010，编号登记于 coordination/d4/README.md）

迁移机制沿用 `packages/persistence/src/migrations/index.ts`（有序数组 + `assertContiguous`，已交付迁移不可变）。

**0008-material-core**：

```sql
CREATE TABLE materials (
  material_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE material_blobs (
  content_hash TEXT PRIMARY KEY,        -- 原件字节 SHA-256
  bytes BLOB NOT NULL
);
CREATE TABLE material_versions (
  version_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  content_hash TEXT NOT NULL REFERENCES material_blobs(content_hash),
  parser_kind TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  parse_status TEXT NOT NULL
    CHECK (parse_status IN ('pending','parsing','ready','failed','canceled','unsupported','rejected')),
  parse_error TEXT,
  text_units INTEGER NOT NULL,
  canonical_text TEXT NOT NULL,
  block_map_json TEXT NOT NULL,          -- MaterialBlock[] 的 JSON
  UNIQUE (material_id, content_hash)     -- 同材料同字节复用版本（ADR-003 §3）
);
CREATE INDEX idx_material_versions_material ON material_versions(material_id);
CREATE TABLE tree_material_links (
  tree_id TEXT NOT NULL REFERENCES trees(tree_id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, material_id)
);
CREATE TABLE material_branch_origins (
  branch_id TEXT PRIMARY KEY REFERENCES branches(branch_id),
  tree_id TEXT NOT NULL REFERENCES trees(tree_id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  version_id TEXT NOT NULL REFERENCES material_versions(version_id),
  block_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  source_hash TEXT NOT NULL,             -- 版本 canonicalText SHA-256
  created_at TEXT NOT NULL,
  CHECK (start >= 0 AND end > start)
);
CREATE TABLE tree_material_reading_state (
  tree_id TEXT NOT NULL REFERENCES trees(tree_id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  version_id TEXT NOT NULL,
  block_id TEXT,
  focus_start INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, material_id)
);
CREATE TABLE material_first_questions (   -- 首问幂等（ADR-003 §4）
  intent_key TEXT NOT NULL,
  tree_id TEXT NOT NULL REFERENCES trees(tree_id),
  branch_id TEXT NOT NULL REFERENCES branches(branch_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, intent_key)
);
ALTER TABLE branches ADD COLUMN origin_kind TEXT NOT NULL
  DEFAULT 'none' CHECK (origin_kind IN ('none','turn','material'));
UPDATE branches SET origin_kind = 'turn'
  WHERE id IN (SELECT branch_id FROM branch_origins);
```

**0009-search-index（D4-4 预留）**：可重建索引表（如 `search_index(doc_kind, tree_id, ref_id, …)`，实现由 D4-4 决定：中文子串/词语 + 英文词，确定性本地检索）。索引**不是事实源**，可从产品事实重建（charter §5）；B4 冻结查询集是唯一裁判。

**0010-export-metadata（D4-5 预留）**：导出包版本/清单所需的库内元信息（如 schema 版本标记、导出审计行）。若 D4-5 证明不需要库内表，则该号留空并记录原因——**不允许跳号**（`assertContiguous`）。

## 3. Studio HTTP API（零新增依赖；loopback 本地服务）

上传走**原始字节 body**（本地 loopback，避免 multipart 解析依赖）：文件名经 `x-treeai-filename` 头（UTF-8 百分号编码）传递。

| 方法与路径 | 语义 | 返回 |
|---|---|---|
| `POST /api/trees/:treeId/materials` | 导入：body=原件字节；头 `x-treeai-filename`、`content-type` | 201 `{material, version}`；同字节重导 200（复用）；超限 413 `material-too-large`；不支持 415 `material-unsupported` |
| `GET /api/trees/:treeId/materials` | 列表（含各版本与状态） | 200 |
| `GET /api/trees/:treeId/materials/:materialId` | 详情（版本链） | 200 |
| `POST /api/trees/:treeId/materials/:materialId/versions` | 新版本（同语义/同返回码） | 201/200/413/415 |
| `GET /api/trees/:treeId/materials/:materialId/versions/:versionId?afterBlock=&limit=` | canonicalText 分块读取（默认从头，limit 块） | 200 `{blocks:[{block, text}], nextAfterBlock, textUnits}` |
| `POST /api/trees/:treeId/materials/:materialId/parse-tasks/:taskId/cancel` | 取消解析（迟到结果不挂靠） | 200/409 |
| `PUT /api/trees/:treeId/materials/:materialId/reading-position` | 持久化阅读位置 | 204 |
| `GET /api/trees/:treeId/materials/:materialId/reading-position` | 读取持久化阅读位置（**D4-2 落地新增**：PUT 的读侧对应；阅读位置按 Tree×材料隔离，分支探索位置是分支自身产品事实，互不覆盖——charter §3.2） | 200 `{readingPosition: MaterialReadingPosition \| null}` |
| `POST /api/trees/:treeId/materials/:materialId/versions/:versionId/resolve-selection` | 统一区间/锚点解析（**D4-2 落地新增**：`{locator, excerpt?, blockId?, anchor?{versionId, sourceHash?}}` → 规范选区；零误定位，绝不以相似文字兜底。B2 冻结无效类别即拒绝原因码词汇表：invalid-locator/needle-not-found/out-of-bounds/reversed/zero-length/surrogate-split/combining-split/emoji-split/excerpt-mismatch/stale-version/cross-page/cross-block/block-mismatch；实现见 apps/studio/src/materials/range-resolver.ts） | 200 `{selection, block}`；区间纪律拒绝 400+原因码；非 ready 409 `material-not-ready` |
| `POST /api/trees/:treeId/branches/from-material` | 材料建枝+首问：`{selection, firstQuestion, intentKey, mode:"resume-or-create"\|"new"}` | 201 新建；200 幂等重放（同键同内容）；409 同键不同内容；非 ready 版本 409 `material-not-ready`；校验失败 400（含原因码） |
| `POST /api/trees/:treeId/search` | 当前树内搜索：`{text, kinds:["material"\|"annotation"\|"return"\|"turn"]}` | 200 `{hits:[SearchHit]}` |
| `POST /api/search` | 全部树搜索：`{text, kinds}` | 200 |

`SearchHit`：`{kind, treeId, treeTitle, materialId?, materialTitle?, versionId?, versionLabel?, oldVersion: boolean, blockId?, start?, end?, excerpt, title, createdAt}`。只索引已保存产品事实；未提交草稿、临时解释缓存、凭据不入索引（charter §5）。

**既有 API 零破坏**；材料分支的 `source` 揭示、`new-exploration`、`return` 复用现有端点，来源经统一 `getBranchOrigin` 判别类型。

## 4. 搜索设计边界（D4-4 实施细则另行落地）

- 首版本地确定性全文检索；明确支持**中文子串/词语**与**英文词**查询；具体索引实现（逐字 n-gram、词表混合等）由研发选择，以 `tests/fixtures/d4/b4-search/` 冻结集验证（charter §5）。
- 默认当前 Tree，用户可切全部 Tree；命中旧版本标注 `oldVersion`；无结果不编造匹配。
- 结果跳转后可继续原探索；session 不可用时显示显式新探索入口（复用 W1 §3.4）。
- 索引可从产品数据 `npm run` 命令重建；索引删除重建是 B5 故障注入项。

## 5. 导出/恢复设计边界（D4-5 实施细则另行落地）

- CLI 而非 HTTP：`treeai-studio export --out <dir>` 与 `--import-package <dir>`（恢复目标是**空数据目录**；不承诺合并两个已用库——charter §5）。
- 包结构：`manifest.json`（schemaVersion、条目清单+SHA-256、产品库 schema 版本）+ `blobs/`（材料原件）+ `facts/`（Tree/Branch/来源/Return/已保存批注与版本元信息的确定性序列化）。
- 默认**不含**凭据、临时缓存、原始运行日志；含 Pi session 的选项必须显式选择并标注敏感内容。
- 导入流程：临时区验证 schema、校验和、引用完整性与路径安全（拒绝路径穿越/超限包）→ 原子落位；失败不覆盖已有数据。
- 缺省恢复承诺：产品事实可读 + 可显式新探索；不承诺旧 Pi 上下文可续（W1 §3.4 语义）。
- `export --readable`：Markdown 可读导出（Tree 主线、Return、批注、材料摘录）。

## 6. 冻结验收集格式（tests/fixtures/d4/，随 D4-0 入仓）

固定 fixture、答案和查询集**在优化前入仓**（charter §6）。布局与格式（完整性探针按此机械校验）：

```
tests/fixtures/d4/
├── MANIFEST.sha256            # 本树全部文件哈希（不含自身）
├── manifest.json              # 冻结集总登记：version/frozenAt/purpose + 各分册指针
├── README.md
├── b1-import/
│   ├── markdown/md-01..12.md + *.expected.json   # d4-md-v1 真值
│   ├── pdf/pdf-01..12.pdf + *.expected.json      # d4-pdf-v1 真值
│   ├── negative/…             # 8 个已提交负例 + sidecar（另有 3 个超限负例仅登记、验证时生成）
│   ├── version-pairs/md-vpair-v1/v2.md + expected
│   └── md-registry.json / pdf-registry.json / negative-registry.json
├── b2-anchors/
│   ├── markdown-selections.json  # 30 项
│   ├── pdf-selections.json       # 30 项
│   └── invalid-selections.json   # 12 项（含机械可判定的无效性谓词）
├── b4-search/
│   ├── facts.json               # 种子产品事实（3 棵树）
│   └── queries.json             # ≥40 正向 + ≥10 无结果
├── b6-scale/spec.json           # 规模数据集规格+种子（生成器随 D4-6 按本规格实现）
└── b9-nav/spec.json             # 大规模树结构规格+种子（生成器随 D4-8 按本规格实现）
```

**真值规则**（`*.expected.json`）：`canonicalText === blocks.map(b=>b.text).join("")`；块连续覆盖（`blocks[i].end === blocks[i+1].start`、首 0、末=len）；markdown 每块（末块除外）以 `\n\n` 结尾，pdf 每页块（末页除外）以 `\n` 结尾；**无任何 Unicode 归一化**。

**选区规则**（`*-selections.json`）：`locator`（`text-occurrence`：needle+第几次出现；或 `utf16-range`）→ 探针重解析必须等于存储的 `start/end/excerpt/blockId`（构造性 100%，不信任手写偏移）。必覆盖类别：`repeat-word-2nd`、`cross-line`、`unicode`、`long-tail`（charter B2）。

**无效选区规则**：每项带 `category` + `expectReason`，探针按类别机械复核其确实无效（如 `surrogate-split` 的边界必须真的落在代理对中间；`stale-version` 的区间文本必须在 v2 中确实改变）。

**阈值**（探针断言，冻结）：B1 ≥12 md + ≥12 pdf + ≥8 负例；B2 ≥30+≥30 有效 + ≥12 无效；B4 ≥40 正向 + ≥10 无结果且全部机械复核通过。

**冻结纪律**：改动 fixture 必须重新生成 `MANIFEST.sha256` 并与变更同提交（沿用 `tests/fixtures` 的既有纪律）；失败样例不得事后移出分母（charter B2）。

## 7. 验收入口（本波次交付的骨架）

```bash
npm run verify:d4            # 离线 D4 门禁（fixtures 完整性 + 文档完整性 + 入口自检 + D4 单测）
npm run verify:d4:selftest   # 失败路径注入自测（缺证据/坏数据/失败不得被吞成绿色）
npm run run:d4-browser -- --mode selftest   # D4 浏览器路径（工作包落地前诚实 NOT_RUN）
npm run run:d4-browser -- --mode real-pi
```

退出码沿用 D2 冻结语义：0=所选检查全部通过，1=工具错误，2=失败，3=阻塞/未运行。离线绿 ≠ 最终门禁通过。D4 verifier 的检查按工作包标记 owner（`D4-0`…`D4-6`），实现落地前以 NOT_RUN + 原因呈现，不得静默省略。

## 8. 实施拆分衔接

| 工作包 | 从本设计拿什么 | 先决 |
|---|---|---|
| D4-1 | §1 类型、§2 迁移 0008、§6 B1 真值 | 本文档 |
| D4-2 | §3 分块读取 API、§6 B2 选区集、§3 D4-2 落地增量（GET reading-position + resolve-selection） | D4-1 |
| D4-3 | §3 from-material 端点、ADR-003 §4/§5 测试义务 | D4-0/2、术语②共享接口 |
| D4-4 | §4 边界、迁移 0009、B4 冻结集 | D4-1 |
| D4-5 | §5 边界、迁移 0010 | D4-1/3/4 |
| D4-6 | §6 b6 规格 + §7 入口扩充 | D4-1～5 |
| D4-8 | §6 b9 规格 | D4-0、既有 Branch/Origin |
