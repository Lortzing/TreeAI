# D4 — 独立状态矩阵（D4-status）

维护纪律：本表只记录状态与证据，不冻结范围。范围来源是
[D4 项目书 v1.1（issue #8，2026-09-30）](./D4-project-v1.md)（仓内逐字镜像）。
每行必须含：任务ID、状态、实现代码、被测完整SHA、证据类型、结果、阻断/整改、
复验条件。**禁止仅写「功能已完成」。**

## 范围来源变更记录

- **2026-09-30**：issue #8 发布《D4 项目书 v1.0》，76 秒后修订为 **v1.1**
  （标题与正文同步修订）。v1.1 的关键修正：负责人明确确认 D3 v1「留到 D4」
  的**五个领域全部为必需范围**（PDF/Markdown 阅读、跨材料搜索、安装程序/
  跨平台、性能、大规模树导航）；v1.0 对安装/跨平台的排除是错误的；D4-7
  （安装与跨平台）与 D4-8（大规模树导航）由此成为独立工作包，验收新增
  B8/B9。**此前（本文件旧版）记录的「权威 D4 任务书未定位」阻断由此解除**——
  旧版判断在当时的证据下成立，现由 issue #8 v1.1 提供权威范围，无需继续
  等待一份旧 D4 文件。
- 本表按 v1.1 维护；v1.0 的历史判断保留在上文，不删除、不改写。

## D4 工作包矩阵

| 任务ID | 状态 | 实现代码 | 被测完整SHA | 证据类型 | 结果 | 阻断/整改 | 复验条件 |
|---|---|---|---|---|---|---|---|
| D4-0 契约与范围落仓 | **已交付**（2026-09-30 本波，`3201ad0` 落仓、`4ebead9` 绑定证据） | `docs/d4/D4-project-v1.md`（镜像）、`docs/d4/D4-contracts.md`、`docs/adr/ADR-003-*.md`、`coordination/d4/README.md`、`tests/fixtures/d4/**`、`scripts/verify-d4.js`、`scripts/verify-d4-selftest.js`、`scripts/run-d4-browser.mjs`、`scripts/d4/`（生成工具）、`tests/support/verifier/d4-probes.ts`、`tests/unit/d4-fixtures-integrity.test.ts` | `4ebead9`（证据目录 `evidence/d4/runs/d4-offline-20260930T123353276Z`、`evidence/d4/selftest/d4-selftest-20260930T123424523Z`） | verify:d4 离线运行 + selftest 注入 | scoped 全绿：fixtures-integrity-d4（79 文件；B1 12 md+12 pdf+8 负例+1 版本对；B2 75 有效/17 无效；B4 55 正向/12 无结果）、docs、entrypoints、typecheck、tests-typecheck、unit-tests-d4、exit-codes、evidence-hygiene；selftest 7/7（控制组 exit 0 + 6 项注入全部检出；本波修复其断言纪律后达成，过程记录在案） | 无 | 候选 SHA 按 §8 全量重跑 |
| D4-1 材料存储和导入 | **工程已交付**（markdown+pdf 导入闭环，离线机械证据）；B1 浏览器面待 D4-2 阅读器 | `packages/persistence/src/material-repository.ts`、迁移 `0008-material-core`、`packages/contracts/src/material.ts`、`apps/studio/src/materials/{markdown-parser,pdf-parser,import-service}.ts`、`apps/studio/src/server.ts` 材料 API、`tests/support/verifier/d4-b1-import.ts` | `4ebead9`（b1 执行记录：`evidence/d4/runs/d4-offline-20260930T123353276Z/logs/b1-import-versions.txt`） | verify:d4 `b1-import-versions` 真执行 + studio 178/178 + 全仓 508/508（unit 80、integration 8、live 3） | 24/24 ready fixtures 字节级回读一致（12 md + 12 pdf）；8/8 负例按冻结理由拒绝；同字节重导复用版本 24/24；版本对 v1→v2 链执行且旧版本可读；3/3 超限负例按 manifest 配方确定性生成并在解析/持久化前拒绝。PDF 解析器 corpus 外边界如实记录：xref/object stream、非 FlateDecode 滤镜、嵌入字体、Form XObject 内文本 unsupported（稳定拒绝理由，不伪装成功） | B1 证据列的「真实浏览器」部分依赖 D4-2 阅读器，属后续工作包，不计为本包阻断 | 候选 SHA 全量 verify:d4 + 真实浏览器（B1 证据列） |
| D4-2 阅读与来源定位 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-1 | B2 选区集起测；术语③区间层接口对齐 |
| D4-3 原文探索闭环 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-0/2、W1 整改、术语②接口 | ADR-003 §5 测试义务全部落地；B3 |
| D4-4 找回既有思考 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-1 | 迁移 0009；B4 冻结查询集 ≥95% 前 5 命中 |
| D4-5 数据可携带与可恢复 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-1/3/4 | B5 故障注入矩阵 |
| D4-6 性能与 Beta 收口 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-1～5、7、8 | B6 规模数据集（规格已冻结于 `tests/fixtures/d4/b6-scale/`）+ B7 |
| D4-7 安装程序与跨平台 | **工程已交付**（打包/启动器/CI/本机 macOS 实测；B8 验收待负责人目标机） | `scripts/d4/package-installer.mjs`、`scripts/d4/installer/{core,shims,launcher}.ts`、`scripts/d4/installer/{smoke-bundle,test-macos-local}.mjs`、`.github/workflows/d4-installer.yml`、`tests/unit/d4-7-installer.test.ts`、`scripts/verify-d4.js`（b8 行理由更新，计数不变） | `5efe4f0`（wip/d4-7-installer 分支 tip；本机实测运行 SHA `fcb5fa3`，其后仅测试驱动的证据写入顺序修正，产品代码零差异） | 本机 macOS 真实安装实测（`evidence/d4/d4-7/d47-macos-20260930T135108Z`：命令/退出码全量 + 浏览器 URL 记录器 + 密钥扫描 0 发现）+ CI 冒烟脚本本机预演（darwin-arm64 46/46）+ 全量门禁（typecheck / 全仓 570/570 / verify:d2 21-0-0-1 `d2-offline-20260930T135427723Z` / verify:d4 9-0-8 `d4-offline-20260930T135604292Z` / 双 selftest 绿） | 产物：每平台版本化 zip(win)/tar.gz + SHA256SUMS + VERSION.json（内置 Node 24.21.0 官方包 SHA256 核对；签名/公证如实记 absent）；用户流程本机全绿 55/55：中文+空格路径安装、首次运行（真实 open + 记录器双证 URL）、离线 API 闭环、停止/重启持久、端口冲突自动顺延（8788→8789）、doctor、模型配置错误可执行恢复、A→B 升级数据保留+旧版备份、损坏升级自动回滚、卸载默认保留数据/--delete-data 显式删除；真实平台数据目录运行前不存在/结束后复原 | **BLOCKED（B8 验收）**：① 负责人 Windows 11 x64 / Ubuntu 24.04 干净安装实测未做（CI 构建 ≠ 运行验证）；② CI workflow `.github/workflows/d4-installer.yml` 已入仓但未执行（分支未推送，push main/workflow_dispatch 才触发；三平台 runner 行为待集成后首跑）；③ 真实 Pi 材料/Return 冒烟未包含（本波零凭据）；④ 无签名/公证（如实记录，README 给 Gatekeeper/SmartScreen 正规应对，不要求关闭安全设置） | 集成推送后 d4-installer CI 三平台构建+冒烟绿；负责人 Windows 11 x64 / Ubuntu 24.04 桌面干净安装 + 升级/卸载数据保留 + 真实 Pi 冒烟；最终候选 SHA 全量回归 |
| D4-8 大规模树导航 | NOT_STARTED | — | — | — | 未实现 | 依赖 D4-0 | B9：结构规格已冻结于 `tests/fixtures/d4/b9-nav/` |

**本波收口复验（2026-09-30）**：合并 main（术语③ `87cbd2c` + D4 波 `4ebead9` + 文档）后全量复跑 — typecheck 全绿、全仓测试 522/522（studio 192/192）、`verify:d4` 9 PASS / 0 FAIL / 8 NOT_RUN（`evidence/d4/runs/d4-offline-20260930T123643289Z`）、`verify:d2` 21/0/0/1 基线不变（`evidence/d2/runs/d2-offline-20260930T123648205Z`）。运行代码与 `4ebead9` 的差异仅为术语③前端（其独立验证见上），组合树由本复验覆盖。

## 门禁状态

| 门 | 状态 | 说明 |
|---|---|---|
| D4-G0 | **工程面已过**（D4-0 于 `4ebead9` 交付并绑定离线证据；见矩阵首行） | 契约（ADR-003 + D4-contracts）、固定测试集（tests/fixtures/d4，含 B1/B2/B4 冻结集与双 MANIFEST）、实施拆分（D4-contracts §8）、验收入口（verify:d4 三入口 + selftest）已入仓并机械验证；继承 W1 v3 产品原则（ADR-003 状态说明段）。G0 无人工项 |
| D4-G1 | 未到 | Markdown 纵向路径（原文→Branch→Return→重启→找回）待 D4-1/2/3 + D4-4 |
| D4-G2 | 未到 | B1–B6、B8–B9 + B7 自动部分 + D3/W1/术语回归 |
| D4-G3 | 未到 | Mac 体验签收 → 3–5 人独立试用（负责人顺序，工程不提前代行） |

## D4-7 支持矩阵记录（charter §5：D4-0 记录具体测试 OS/浏览器版本）

| 平台 | 目标版本 | 本仓当前实测环境 | 状态 |
|---|---|---|---|
| macOS Apple Silicon | macOS 26.6.2（25G83），Apple M4 / 16 GB，Node 24.21.0，npm 11.19.0，Chrome 153.0.8010.37（headless，CDP） | 同左（D4-7 波已做本机真实安装实测：`evidence/d4/d4-7/d47-macos-20260930T135108Z`，55/55，含真实 open 唤起与 BROWSER 记录器双证） | **已实测（工程面）**；B8 的 Mac 体验签收仍按负责人人工顺序执行 |
| Windows 11 x64 | Windows 11（版本号待环境实测时记录），Chrome 最新稳定 | 无本机环境；CI `windows-latest` 构建冒烟已入仓（`d4-installer.yml`，**未执行**——分支未推送） | **BLOCKED：无目标环境**——B8 不得以跨平台构建成功替代运行验证；CI 冒烟绿也只是 runner 证据，不计负责人签收 |
| Ubuntu 24.04 LTS x64 | Ubuntu 24.04 LTS，Chrome 最新稳定 | 无本机环境；CI `ubuntu-24.04` 构建冒烟已入仓（同上，**未执行**） | **BLOCKED：无目标环境**（同上） |

## 与其他工作流的关系（不重复计入 D4）

- W1 P0/P1 整改、术语①②核心与最小③切片（`32f4778`…`085f979`）是
  D3/W1/术语工作，不是 D4 进度。**术语③完整前端已于 2026-09-30 晚交付并落
  main（`87cbd2c`）**：正文/操作分层、统一区间覆盖、选择期间不重绘、
  工具条/解释卡完整状态（issue #7 C ③），随交付验证 studio 131/131、
  typecheck、verify:d2 基线不变。按项目书 §2 它与材料阅读区整合但
  **保持独立验收记录**，不计入 D4 进度；D4-2 只复用其区间层接口，
  不以 D4 进度抵扣术语交付。
- D3 人工项（Mac 签收、3–5 人试用）按负责人计划延后，不阻止 D4 工程
  （issue #7 跟踪补充）。
- 最终停止条件（全项目）：D3、既定 D4（本文件矩阵）、W1 v3 必须整改、
  术语三部分与前端，以及规定顺序的人工签收全部具备可核验验收且无阻断
  （issue #8 §9）。
