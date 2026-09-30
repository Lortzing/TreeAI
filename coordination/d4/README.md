# D4 协调区（D4-0 建立，2026-09-30）

按《D4 项目书 v1.1》（issue #8）§4：「新增依赖、迁移编号、公共契约由集成
负责人统一协调」。本目录是 D4 波次的协调登记处，由 D4 集成侧维护；各工作包
动下列资源前必须先在此登记领取。

## 当前波次（进行中，2026-09-30 深夜）

术语整改波（issue #7 增量验收 12:08Z 的必须修复项）+ D4-2 后端，三支并行，
均基于 main `57a8abb`：

- `wip/term-backend`（worktree term-backend）：术语后端 P0×3 + P1×2 ——
  缓存语境键、推广事务原子性（bindTerminologyPromotion 单事务/冲突零副作用）、
  首问 payload hash + 派发账本（迁移编号按下方更正记录：实际落 **0009**）、
  预算预留、取消记账。
- `wip/term-frontend`（worktree term-frontend）：app.js `turnOverlaysFor`
  来源/切片联合校验（P0）+ `refreshTerminology` 跨树竞态守卫（P1）。
- `wip/d4-2-backend`（worktree d4-2-backend）：D4-2 后端——材料读取 API、
  统一区间解析层、阅读位置持久化、verify:d4 b2-precise-anchors 真执行
  （75 有效 100% / 17 无效零误定位）。
- 注意：term-backend 与 d4-2-backend 都会改 `apps/studio/src/server.ts`
  （术语路由 vs 材料路由）——集成时由集成会话解决冲突。
- `wip/d4-4-search-core`（worktree d4-4-search-core，2026-09-30 20:58 追加，基于
  main `a6f411d`；登记会话：wave-1 的五个 agent 派发会话，agent 在飞）：
  D4-4 搜索引擎核心——纯模块（`apps/studio/src/search/`）+ 冻结 B4 集验证
  （55 正向 top-5 命中、12 无结果零命中）；**不碰** server.ts / 迁移 /
  package.json / app.js——迁移 0010（更正记录后归 D4-4）与 HTTP 接线留待
  集成，与上四支无文件冲突。
- `wip/d4-2-frontend`（worktree d4-2-frontend，2026-09-30 21:40 追加，基于
  main `f64969c`；登记会话：wave-1 派发会话 local_b0c1d2ca，agent 在飞）：
  D4-2 前端阅读器 **Markdown 增量**——材料列表面、分块懒加载阅读视图
  （保留 canonicalText 偏移映射）、选区捕获（grapheme-safe、块内可锚定
  纪律，D4-3 建枝前只如实呈现载荷）、阅读位置保存/恢复、版本可辨认
  （旧版本可读）、PDF 如实「下一增量」状态。文件面：public/{app.js,
  style.css,index.html} + tests/ui-material-reader.test.ts——**不碰**
  server.ts / materials / search / 迁移，与在飞各支无文件冲突。
- D4-2 前端阅读器不在本波（app.js 由 term-frontend 独占）。【已过时——
  term-frontend 已于 `c59c2a0` 合并，app.js 解除独占；Markdown 增量由上条
  `wip/d4-2-frontend` 认领，PDF 增量待后续波次】
- `wip/d4-7-installer`（worktree d4-7-installer，2026-09-30 21:20 追加，基于
  main `a6f411d`）：D4-7 安装程序/跨平台工程——打包本地服务＋系统浏览器
  方案、三平台安装产物与校验和、首次启动/诊断/升级/卸载脚本、三平台 CI
  构建；本机仅 macOS ARM64 可实测，Windows/Linux 干净安装按 B8 如实
  BLOCKED。文件面：scripts/ 打包与安装脚本、.github/workflows/、根
  package.json scripts、docs/d4/D4-status.md（D4-7 行）——不碰 app.js/
  server.ts/terminology/迁移，与上三支无文件冲突。
- `wip/term-eval`（worktree term-eval，2026-09-30 21:25 追加，基于 main
  `3fc9198`；登记会话：21:10 让位会话，agent 在飞）：术语冻结评测集
  （issue #7 §4 / v2 方案 P3）——`apps/studio/terminology/` 下新增
  eval-set-dev.json + eval-set-frozen.json（各 180 条，按 Tree/文档分组
  防泄漏、中文 ≥240、负例 ≥25%、六类覆盖）＋ 新评测 runner
  `scripts/run-terminology-eval.mjs`（dev 可调参 / 冻结一次性、分任务
  指标、空输出记录、echo 模式离线校验）＋ 零依赖 TF-IDF/TextRank 基线
  ＋ 完整性测试。**全部新文件**：不碰 run-terminology-trials.mjs、
  terminology.ts、app.js、server.ts、迁移、tests/fixtures/（避开
  MANIFEST 纪律）——与在飞各支无文件冲突。真实模型跑批与两人标注为
  owner/后续波次事项。
- `wip/d4-4-wiring`（worktree d4-4-wiring，2026-09-30 21:35 追加，基于
  main `f64969c`；登记会话：wave-2 集成会话，agent 在飞）：D4-4 集成
  接线——`apps/studio/src/search/search-service.ts` 文档装配（材料×版本
  含旧版本 + 批注/Return/Turn，同一装配路径供 HTTP 与 b4 检查共用）、
  server.ts 两个搜索端点、`tests/support/verifier/d4-b4-search.ts` +
  verify:d4 b4-cross-material-find 真执行（55/55 top-5 + 12/12 零命中）。
  迁移 0010 预计按引擎按请求确定性重建的设计**弃用**（无库内索引表），
  集成时在此记录。文件面：search/、server.ts（标记区段）、
  tests/、verify-d4.js、docs/d4/D4-contracts.md §3——与在飞各支无冲突。
- `wip/d4-3-backend`（worktree d4-3-backend，2026-09-30 22:05 追加，基于
  main `92c883f`；登记会话：21:10 让位会话，agent 在飞）：D4-3 原文探索
  闭环**后端**——复用建枝/Origin/Run/Return 底层的材料建枝服务
  （显式材料运行起点：选区+邻近段落+材料标题/版本+首问为真实输入，不造
  假历史回答；开工 ADR-004 说明 session 复用/独立决策并测试）、幂等首问
  （material_first_questions 表 + 0009 派发账本纪律）、同来源恢复已有探索
  /显式另开、Return 材料来源卡（主线锚点缺失按确认时间放置+原文跳转）、
  缺 session 显式新探索、确定性故障测试 + verify:d4 b3 离线部分。
  **文件面**：`apps/studio/src/materials/branching.ts`（新）+ service.ts
  接线、server.ts（材料建枝区段）、persistence 仓库函数（表已存在于 0008，
  无新迁移）、`tests/support/verifier/d4-b3-*.ts`、verify-d4.js（b3 接线，
  与 d4-4-wiring 的 b4 接线可能冲突，集成方解决）、docs/adr/ADR-004（新）。
  **不碰** app.js（d4-2-frontend 在飞）、search/（d4-4-wiring）、b9-nav。
  B3 的真实 Pi 浏览器证据属最终候选 SHA 回归，不在本支。

- `wip/d4-5-export`（worktree d4-5-export，2026-09-30 22:06 追加，基于 main
  `8d2e240`；登记会话：wave-2 集成会话，agent 在飞）：D4-5 数据可携带与可恢复
  ——CLI 导出/空目录恢复（charter §5 导出恢复 + contracts §5：版本化包
  manifest+blobs+facts、校验和、损坏拒绝/原子落位、缺 session 降级、
  Markdown 可读导出）+ B5 离线机械部分（导出→空目录恢复→完整性比对、
  损坏包拒绝且现有数据不变）接 verify:d4。**零迁移目标**：导出元信息从
  既有表+blobs 派生；若确需迁移必须先停下报告（0010 已备案归 D4-8，
  不可占用）。文件面：`scripts/d4/export/`、导出/恢复服务与测试、
  verify-d4.js（b5 接线，与 d4-3-backend 的 b3 接线可能冲突，集成方解决）
  ——不碰 app.js / search / materials 解析器 / 迁移。

若另一会话读到本节且上述分支仍未合并：**不要重复实现**，先检查
`.claude/worktrees/` 对应 worktree 的 git log/status 判断进度。

**接管记录（2026-09-30 21:10 本地 / treeai-loop 调度会话）**：登记该波的
会话已结束且三分支零提交零改动（波次实际未开工）；本会话确认无并行会话
在飞后**接管本波**，三分支已 ff 至 main `15c7a99` 后开工，验收口径不变。
另外：d4-1-pdf-parser worktree 里遗留的未提交 PDF 解析器加固（bfrange
数组形态、内联图跳过、字体惰性物化 + 测试）已按保全纪律提交至
`wip/d4-1-pdf-parser`（`dd29f96`），未合入本波，供后续 PDF 波评估。

**2026-09-30 21:25 更新（wave-2 集成会话）**：术语整改三支已全部合并 main
并推送（`c59c2a0`）——`wip/term-backend`（`d6005d0`，迁移 0009）、
`wip/term-frontend`（`1e86c84`）、`wip/d4-2-backend`（`b3854ab`）+
`dd29f96` PDF 加固。合并后 main：全量 566 pass / 0 fail、verify:d2 基线、
verify:d4 10 PASS / 0 FAIL / 7 NOT_RUN。仍在飞（各自登记方集成）：
`wip/d4-7-installer`（21:10 让位会话）、`wip/term-eval`（同上）、
`wip/d4-4-search-core`（按 21:15 让位记录由 wave-2 集成会话集成，agent 在飞）。

**接管更正 + 让位（2026-09-30 21:15 本地）**：上条「接管记录」基于过期
快照——波次登记会话（treeai-loop 11:39Z firing，`local_a3d676f3`）在本
会话检查后约 2 分钟恢复运行，其自身与 agent 一直在 term-backend /
term-frontend / d4-2-backend（并追加 d4-4-search-core）推进。本会话此前
向 term-backend / term-frontend 派出的两个 agent **全程零编辑零写入**
（检测到在飞写入者后转入监控，已停止），worktree 内容全部属于该会话的
操作，无混合污染。**让位决定**：term-backend / term-frontend / d4-2-backend
/ d4-4-search-core 四支以该会话为准；本会话仅保留 `wip/d4-7-installer`
（未受影响，agent 在飞）并在其完成后由本会话集成、过门禁、推送。各分支
的集成与推送以登记方为准，避免双会话重复集成。

**2026-09-30 21:45 更新（treeai-loop 13:33Z firing 集成会话）**：

- **D4-1 P1 已落 main**：issue #8 增量验收的解析取消树作用域缺口已修复
  （`2a2e373`：`cancelParseTask(treeId, taskId, materialId?)` 全链路校验 +
  wrong-tree/missing-tree HTTP 回归 + 多树链接服务回归；证据/状态
  `61cf401`，verify:d4 10 PASS / 0 FAIL / 7 NOT_RUN，studio 230/230，
  全仓 581/581，selftest 全注入检出，run:d4-browser selftest 真实
  Chrome 153 4 PASS / 0 FAIL / 6 NOT_RUN）。已推送 origin/main。
- **在飞观察（13:42Z 检查）**：`wip/d4-7-installer` 有 agent 活跃，已提交
  2 commits（`f5f5616` 安装核心、`27b77c5` 构建管线/CI/打包冒烟），但其
  基点是旧 main `a6f411d`（本会话对其 ff 被该 agent 的 reset 撤销）——
  **集成时需 rebase 到新 main 并解决 package.json/verify-d4.js 冲突**；
  `wip/d4-4-wiring` 有 agent 活跃（search-service.ts 在写）；`wip/term-eval`
  有 agent 活跃（eval-set-dev.json 在写）；`wip/d4-2-frontend` 按上节登记
  属 `local_b0c1d2ca`（检查时 worktree 干净，agent 可能在读代码阶段）。
  以上各支**本会话不重复实现、不触碰其 worktree**。
- **本会话认领（先推送为准）**：(1) 新增 `wip/d4-8-nav`（worktree
  `.claude/worktrees/d4-8-nav`，基于 main `61cf401`）：D4-8 大规模树导航
  **引擎增量**——b9-nav 冻结规格的确定性生成器（`tests/fixtures/d4/b9-nav/
  spec.json`）+ 结构真值 + 层级查询/路径/定位核心（persistence 查询 +
  纯服务层）；**不碰** server.ts / app.js / search/ / materials/（HTTP
  接线与前端树导航属后续波，避免与 d4-4-wiring/d4-2-frontend 冲突）。
  迁移编号：0008/0009 已用；0010 按上节 D4-4 登记弃用，**若 D4-8 需要迁移
  （展开/阅读状态持久化）使用 0010**，在此备案。(2) **本波集成职责**：
  各支完成后由本会话合并 main、过门禁、推送；其它会话避免重复集成，
  冲突以先推送的登记为准。

**2026-09-30 22:10 更新（wave-2 集成会话 / d4-4 登记方）**：`wip/d4-4-wiring`
（`ea2a91a`+`e2fa173`）已合并 main 并全量验证——search-service 装配（HTTP 与
b4 门禁同一路径）、两个搜索端点、**verify:d4 b4-cross-material-find 真执行：
55/55 正向前 5（最差名次 3）+ 12/12 无结果零命中**；合并后 main：studio
244/244、全仓 8 套件零失败、verify:d4 **11 PASS / 0 FAIL / 6 NOT_RUN**、
verify:d2 基线、双 selftest 绿。迁移 0010 弃用已记录（见迁移表）。D4-4 后端
面至此完整；前端搜索 UI/来源跳转归后续波。仍在飞：`wip/d4-2-frontend` /
`wip/d4-3-backend` / `wip/d4-8-nav` / `wip/term-eval`（各自登记方集成）。

**2026-09-30 21:55 更新（21:10 让位会话 / d4-7 登记方）**：`wip/d4-7-installer`
agent 已完成——tip `ceed7e3`（5 commits：安装核心 `f5f5616`、构建管线/CI/
打包冒烟 `27b77c5`、真实测试发现的修复 `fcb5fa3`、macOS ARM64 55/55 实测
证据 `5efe4f0`、状态绑定 `ceed7e3`；门禁：typecheck PASS、全量 570/570、
verify:d2 21/0/0/1、verify:d4 9/0/8 @其基点 a6f411d）。**本会话按 21:20
登记（`b99a3de`，先于 13:33Z 会话的集成认领推送）现在开始集成 d4-7**：
merge 进 main（保留证据 SHA，不 rebase）、解决 verify-d4.js/package.json/
D4-status 冲突、过全量门禁后推送。13:33Z 会话请勿重复集成 d4-7 与
term-eval（term-eval agent 仍在飞，完成后同样由本会话集成）。d1391fa 之上
各在飞支（d4-4-wiring / d4-2-frontend / d4-8-nav）不受影响，其登记方不变。

## 上一波（2026-09-30 晚，已完成）

D4-0/D4-1 首波已在 `wip/d4-wave2` 收口（代码/证据 `4ebead9`）：

- D4-0 落仓（`3201ad0`）：项目书镜像、契约、ADR-003、本协调区、verify:d4
  三入口、B1 PDF 侧冻结集；随后合并 D4-1 markdown 链（`084e55d`）。
- B1 markdown 侧 + 版本对 + B2 选区/无效集（`wip/d4-fixtures-md`，
  `a3740be`+`846e0fe`）、B4 冻结查询集（`wip/d4-fixtures-search`，`c3bcefd`）、
  PDF 文字层解析器 + import 接线 + verify:d4 b1 真执行（`wip/d4-1-pdf-parser`，
  `849b352`/`1e9e813`）三支并行合并。
- 双 MANIFEST 冻结（d4 子树 79 条 + tests/fixtures 根 113 条）；
  fixtures-integrity-d4 5/5；verify:d4 9 PASS/0 FAIL/8 NOT_RUN；
  verify:d2 基线不变（21/0/0/1）；两份 selftest 全绿（d4 selftest 的断言
  纪律本波修复：按子运行 result.json 断言，合成树补齐 selftest 脚本副本）。
- 术语③前端独立落 main（`87cbd2c`），不在 D4 分支内。
- 孤立草稿（上一会话 fixture agent 留在主工作区的未跟踪旧稿）已保存至
  `wip/orphan-md-fixture-draft`，仅供参考，不属于冻结集。

下一个工作包：D4-2（阅读与来源定位；依赖 D4-1 ✓ + 术语③区间层接口 ✓），
然后 D4-3 markdown 纵向闭环（D4-G1）。

## 迁移编号登记（packages/persistence/src/migrations/）

已交付：0001–0007（D2/D3，不可修改——见 `packages/persistence/README.md` 与
`coordination/d2/agent-c-handoff.md` 的冻结纪律）。

| 编号 | 名称 | 归属 | 状态 |
|---|---|---|---|
| 0008 | material-core（materials / material_blobs / material_versions / tree_material_links / material_branch_origins / tree_material_reading_state / material_first_questions / branches.origin_kind） | D4-1 | 已交付（`4ebead9`，随 D4-1 波合并） |
| 0009 | terminology-dispatch-ledger（issue #7 术语整改：首问 payload hash / 派发状态 / Run 引用等不可变账本，2026-09-30 验收 P0 要求） | 术语（issue #7，非 D4） | 已交付（`d6005d0`，wip/term-backend 术语整改波；表 terminology_promotion_dispatches，随 P0-3 整改落地） |
| 0010 | search-index（可重建索引表，实现由 D4-4 决定） | D4-4 | **已弃用（2026-09-30 22:10，D4-4 集成落地时）**：引擎按请求确定性内存重建（`search-service.ts`，零缓存，性能优化归 D4-6），索引天然可从产品数据重建、非事实源（charter §4 结构性满足）；引擎 `serialize()/restore()` 接缝保留备未来持久化。编号按 `assertContiguous` 交付顺序流转：下一个实际需要迁移的包取 **0010**（D4-8 已备案：展开/阅读状态持久化若需要迁移用 0010，见下方 13:33Z 会话备案） |
| 0011 | export-metadata（D4-5 导出包所需库内元信息） | D4-5 | 预留（原 0010，随术语账本前移）；同上 |

规则：并行波次添加迁移前先在此占号；编号必须连续递增；已交付迁移不可修改。

**编号更正（2026-09-30，术语整改波开工时）**：本表曾是「意图登记」而非交付
顺序——`assertContiguous` 机械强制下一个迁移文件必须是 **0009**（0011 登记
时 0009/0010 尚不存在）。实际交付顺序据此更正：**0009 =
terminology-dispatch-ledger（术语首问派发账本，issue #7 整改，本波交付）**；
0010 = search-index（D4-4 预留）；0011 = export-metadata（D4-5 预留）。若
术语整改最终不需迁移，在此记录弃用并保持连续。

## 波次占用（并行会话协调）

| 波次 | 状态 | 文件面 |
|---|---|---|
| issue #7 术语整改 + D4-2 后端 | **进行中——由「当前波次」一节登记的 worktree 分支拥有（`wip/term-backend` / `wip/term-frontend` / `wip/d4-2-backend`，基于 `57a8abb`/`5570208`）** | 见上文「当前波次」清单 |

**更正记录（2026-09-30 20:50）**：本会话曾在 `013c1eb` 以「波次占用」表认领
术语整改波——该认领基于过期信息（未读到 `5570208` 的在飞登记）而**作废**：
上述三个 worktree 分支的登记更早、仍在推进，术语整改与 D4-2 后端以它们为
准，其他会话（含本会话）不重复实现。本会话角色改为：main 增量验证与推送
兜底。`013c1eb` 中的迁移编号更正（术语账本实际落为 0009）仍然有效，供
term-backend 分支采纳。

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

**2026-09-30 22:35 更新（13:33Z 集成会话）**：issue #8 增量验收 14:17Z 的
**P2 建议已落地**——`tar` 解包恒带 `--no-same-owner`（rootless 容器
user-namespace root 下恢复归档 UID/GID 会在 nodejs.org 发行包上失败）：
新增 `scripts/d4/installer/core.ts::tarExtractArgs`（构建 packager 与
packaged-bundle 冒烟共用），`package-installer.mjs` 两处 tar 调用与
`smoke-bundle.mjs` 的 tar 兜底改走该助手；Windows System32 bsdtar zip 路径
同步带 flag。回归：`tests/unit/d4-7-installer.test.ts::tarExtractArgs`
（恒带 flag + 按后缀选 -xJf/-xzf/-xf）。win-x64 smoke zip 解包 CI 失败
（run 36727379546，GNU tar 不识别 zip）已由其它会话于 `9c421f2` 修复，
本条不重复。
