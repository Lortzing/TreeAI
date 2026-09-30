# ADR-004：D4-3 材料建枝的运行起点、恢复语义与幂等首问（Material Branching: Run Origin, Restore Semantics, and Idempotent First Question）

- **状态：Accepted（2026-10-01）**
- 创建日期：2026-10-01
- 作者：D4-3 后端波次（treeai-loop 调度会话派发）
- 决策权：负责人（产品语义）；工程实现细节由项目书委派给本 ADR
- 负责人确认来源：issue #8《TreeAI D4 项目书 v1.1》§3.3（「是否复用树内有效运行或创建独立 session 由开工 ADR 说明并测试」）、§4 工作包 D4-3；D4-0 交付的 [ADR-003](./ADR-003-d4-material-sources-versions-run-origins.md) §4 已定原则性方向（独立 session + 幂等首问键），本 ADR 是其 D4-3 落地细化。
- 上游已批准事实：ADR-003（Accepted 2026-09-30）；W1 v3 产品契约（`docs/d3/W1-product-contracts.md`，§3.4 缺 session 显式新探索、§3.2/§3.5 Return 采用与保存先于导航）；issue #7 术语整改（0009 派发账本纪律，「先对账后行动」）。

> **状态说明（不可移除）**：本 ADR 在 charter §3.3 冻结语义与 ADR-003 已定决策的边界内，只做工程决策（运行起点实现、恢复/另开语义、首问派发对账纪律、HTTP 契约两步拆分）。产品语义的任何变更须回到负责人；不以前端完成度或工期为由改写产品约束。

## 1. 背景与上下文

charter §3.3 要求：材料选文、术语入口和原回答选区**最终使用同一 Branch/Origin/Run/Return 服务底层**，仅来源解析和初始上下文构造不同。D4-3 交付该闭环的后端（`apps/studio/src/materials/branching.ts` 的 `MaterialBranchingService` + `service.ts` 最小接线 + `server.ts` 材料建枝区段）。需要本 ADR 说明并测试的问题：

1. 材料 Branch 首个 Run 的运行起点（session 复用 vs 独立）——ADR-003 §4 已决策「独立 session」，本 ADR 记录实现机制；
2. 「同来源恢复已有探索 / 显式另开」的判定边界；
3. session 丢失后的显式新探索如何携带材料上下文；
4. 首问派发的幂等与对账纪律（0009 账本纪律在材料面的对应物）；
5. `D4-contracts.md` §3 的 `from-material` 端点拆分（实现差异回写，见 §6）。

## 2. 决策一：独立 session 的运行起点（实现）

**材料 Branch 的首个 Run 在独立 session 上开始**（ADR-003 §4 原则的实现细化）：

- `TreeStudioService.#resolveContinuation`：分支无 run 且无 Turn 来源、但有 `material_branch_origins` 行 → 续聊点 = `new-session`（`hasMaterialBranchOrigin` 探针，`tree-repository.ts`）。材料来源没有 Pi 分叉点（charter §3.3），绝不挂靠树内任何既有运行/会话；首个 prompt（首问）经 `#ensureSessionAt` 建立全新 session；
- 首问的模型输入 = 组合材料上下文（`composedPrefix`，见 §7）+ 用户问题——两者都是**真实输入**；用户 turn 落库为显式前缀 + 问题原文（§4），DB 可审计、不冒充历史；
- 首问之后照常走「latest run 引用」续聊（与既有分支一致——材料分支不是特例，只是起点不同）；
- 测试义务（ADR-003 §5.4）：材料 Branch 首个 run 的 sessionId ≠ 库内任何其他 run 的 sessionId；首个用户 Turn 之前不存在任何伪造历史 Turn。

## 3. 决策二：恢复已有探索 vs 显式另开（同来源判定）

「同一来源」= 选区身份全等：`materialId × versionId × blockId × start × end`（`sameMaterialSelectionIdentity`）。缺一不可：同名词、同摘录文本在不同材料、不同版本、不同 Tree、甚至同版本不同偏移都**不会**被复用（零误匹配纪律，与 D4-2 区间解析层同一口径——绝不以相似文字兜底）。

- **a. 恢复**（`restoreOrOpen` mode `"restore"`）：树内以该选区为来源的最新 Branch（多枝取最新）被打开并续用其 session（`switchBranch` 对准续聊点）；导航失败如实分离携带（`navigation: failed/no-session`），session 不可用时 `sessionAvailability: "unavailable"` 供 UI 给出显式新探索入口。**不新建、不重注入材料上下文**——恢复的是既有探索；
- **b. 显式另开**（mode `"new"`）：新 Branch + 新 intentKey 绑定（新 session 意图）。同来源可多次另开（每次都是新提交）；
- **c. session 丢失**：走 W1 §3.4 既有语义（显式确认、新 session、可审计标记）——材料分支版 `promptNewMaterialExploration` 在 `#newExplorationContext` 中随行材料来源上下文块（`PromptOptions.newExplorationMaterialContext`）：显式声明旧上下文未恢复 + 材料标题/版本/选区/邻近窗口 + 分支已保存历史文本化带入。前置条件与 Turn 来源分支一致（session 当前不可用才成立；仍可用 → 409，无历史 session 同样拒绝——普通 prompt 即会新建）。旧历史保持可读，来源关系（material origin）不动。

`resume-or-create`（HTTP 层，§6）：先按 a 恢复，该来源在树内无探索（404）则按提交键新建——「搜索结果跳转回来继续原探索，不存在则从这处原文新开」的一次调用形态。

## 4. 决策三：首问提交意图身份与可审计前缀

- **原子绑定**：建枝 = Branch 行 + 材料来源 + 首问意图绑定（`material_first_questions`，PRIMARY KEY `(tree_id, intent_key)`，migration 0008 已有表）在 `MaterialRepository.createMaterialBranch` 的**单事务**内落库——任何一步失败零新增行（与术语推广 promote 的单事务纪律同源，issue #7 P0 整改口径）。双击、响应丢失重试、进程重启重放同一键 → 同一 Branch（`replayed=true`，零新行）；同键不同选区 → 409（一次逻辑提交不得静默换源）；
- **前缀只含 versionId**：首问用户 turn 的显式标记为 `[exploration from material <versionId>]`（`materialExplorationTurnPrefix`）。ADR-003 §4 的示意是 `[exploration from material <标题> v<版本>]`；本 ADR 细化为**只含 versionId**，理由：材料标题是可编辑显示名（不是身份，charter §3.1），把它写进 turn 前缀会让「同键异问」的对账基准随改名漂移——versionId 不可变，前缀因此稳定；
- **建枝零 Run/Turn**：建枝调用只落 Branch/来源/绑定（charter §3.3「浏览/搜索不创建 Turn」）；首问是独立的显式提交（§5）。保存批注（术语面）不自动建枝——本服务只被显式建枝入口调用。

## 5. 决策四：首问派发——「先对账后行动」的账本纪律

0009 术语派发账本（`terminology_promotion_dispatches`）的服务层对应物，**schema 边界记录**：材料首问**不新增**派发账本表（本波零迁移——0008 已含 `material_first_questions`；0010 已备案归 D4-8）。理由：0009 账本承载术语推广特有的预算预留/取消记账语义；材料首问没有预算语义，其提交身份已由 `(tree_id, intent_key)` 原子绑定承载，**派发结果的对账证据就在产品事实里**——落库的带前缀用户 turn（内容全等）与分支 Run 的终态性。对账规则（`MaterialBranchingService.firstQuestion`，先对账、后行动）：

1. 已落库首问 turn（前缀 + 问题原文全等）→ **幂等重放**：`dispatch: "succeeded"`，不重发、不重建枝（`landed` 给出定位）；
2. 首问已用**不同内容**落库（存在带前缀但内容不等的用户 turn）→ 409 `material-first-question-conflict`（首问对同一分支不可变——改问是普通续聊，不是首问重试；与术语「同键异问 → 409」同一纪律）；
3. 分支存在**非终态 Run**（在途/未收敛——进程在派发中退出后的库内形态）→ `dispatch: "unknown"`，**不盲发**（结果未知；重试前先对账该分支的 Runs）；
4. 其余（无落库 turn 且全部 Run 终态或无 Run）→ 从未送达或明确失败，**可（重）派发**（失败重试是显式允许的新尝试）；派发失败 → `dispatch: "failed"`（同键重试同样走 1–4）。

与术语账本一样，**绝不信「分支上有无 Turn」这类旁证**（对账证据一优先于任何推断）；派发结局 `succeeded | failed | unknown` 与 `TerminologyDispatchOutcome` 同词汇。

## 6. 决策五：HTTP 契约差异——from-material 拆两步（回写 D4-contracts.md §3）

`D4-contracts.md` §3 设计的 `POST /api/trees/:treeId/branches/from-material`（建枝+首问一体）在 D4-3 落地为**两步**（差异已回写契约文档）：

1. `POST /api/trees/:treeId/branches/from-material` —— 建枝/恢复（`{selection, intentKey, mode}`，mode ∈ `resume-or-create`|`new`），**零 Run/Turn**，响应携带组合上下文视图（`context`：窗口、块范围、上限、截断标记、组合文本）；
2. `POST /api/trees/:treeId/material-first-question` —— 幂等首问（`{intentKey, firstQuestion}`，目标分支经 `(treeId, intentKey)` 绑定解析，§5 对账）。

理由：charter §3.3 要求 **UI 在提交前说明本次使用的材料范围**——第 1 步的响应就是该说明的数据来源（与首问派发时逐字节相同的组合上下文）；把首问并进建枝请求会把「材料范围确认」变成事后通知，也让响应丢失后的重试无法区分建枝重放与首问重放两个提交身份。其余端点：`POST /api/trees/:treeId/material-return`（材料 Return + 来源卡，`{fromBranchId, text, idempotencyKey}`）；`POST /api/trees/:treeId/branches/:branchId/material-new-exploration`（缺 session 显式新探索，`{text}`）。

## 7. 上下文窗口边界（实现 ADR-003 §4 的 24,000 上限）

`composeMaterialContext`（纯函数、确定性——全部成分由不可变数据决定：版本 canonicalText、块图、选区）：

- 组合文本 = 标题/版本头（标题截断至 80 单元并标记）+ 选区摘录完整引用 + 有界邻近块窗口 + 截断标记；恒 ≤ `MATERIAL_CONTEXT_LIMIT_UNITS`（24,000 UTF-16 单元，ADR-003 冻结值）；
- 窗口从选区所在块起按整块交替向两侧扩展至预算；所在块自身超预算时改为选区两侧对称切片（选区完整保留）；
- 窗口未覆盖整份材料时在组合文本内**显式截断标记**（`truncationNote` 同一段文本进 UI 预览与模型输入两处）；
- **选区自身超 `MATERIAL_MAX_SELECTION_UNITS`（20,000）直接拒绝**（400，零派发）——截断用户自己的选区是不诚实的锚定（与术语解释的 `MAX_EXPLAIN_SELECTION_CHARS` 同一纪律）；预留 800 单元给标题/标签/截断标记，构造性保证组合文本恒 ≤ 上限。

## 8. 材料 Return 的主线放置与来源卡

- 完全复用 `TreeStudioService.submitReturn`：保存先于导航（导航失败不回滚、结果分离呈现）、树内幂等键、采用尝试/成功分开记录（W1 v3 §3.2/§3.5 既有语义）；
- 材料 Branch 的 `targetAnchor` 恒为 **null**（材料来源没有主线对话锚点，绝不伪造；charter §3.3「没有主线对话锚点时按确认时间放置并提供原文跳转」）；主线放置以确认时间（return turn `createdAt`）为准；
- 来源卡（`MaterialReturnCard`）从**不可变材料来源 + return turn** 派生：材料标题、versionId、parser 元信息、块/页标识（pdf-page 块含 1-based page）、原摘录、确认时间、采用记录（attempts / deliveredRunId / saved|attempted|adopted）与 `sourceJump`（materialId/versionId/blockId/start/end/sourceHash——阅读器据此定位原文，不伪造主线位置）。

## 9. 测试义务（说明并测试）

落在 studio 测试套件（`apps/studio/tests/materials-branching.test.ts`，离线 echo 驱动）与 `verify:d4` 的 `b3-material-exploration` 离线检查（`tests/support/verifier/d4-b3-exploration.ts`）：

1. **同来源建枝**（Markdown + 文字层 PDF，真实 B1 fixture 经真实导入管线）：建枝零 Run/Turn；组合上下文确定且与派发时逐字节相同；
2. **上下文上限诚实**：超限窗口截断标记如实（truncated + truncationNote + composedUnits ≤ 24,000）；选区超 20,000 拒绝（零派发）；
3. **独立 session**：首个 run 的 session 全新（≠库内其他 run 的 session）；首问前无伪造历史 turn；
4. **幂等首问**：重放（同键同问）不重复建枝/派发；重启后重放确定性；同键不同选区 409；同分支首问异问 409；
5. **对账纪律**：非终态 Run → `unknown` 不盲发；无落库 turn 且全终态 → 可重派发；
6. **恢复/另开**：同来源恢复返回既有 Branch；显式另开新建；同摘录不同材料/版本/树不误复用；跨树隔离（runs/Return 按 Tree）；
7. **材料 Return**：落所属 Tree 主线、targetAnchor null、卡片字段、幂等重放、采用尝试记录；
8. **缺 session 显式新探索**：session 丢失后普通续聊拒绝（fail-closed），显式新探索成功且材料上下文随行；session 可用时新探索 409；
9. **非 ready 版本**建枝 → 409 `material-not-ready`（不伪装成功）。

**不在本支**（如实 NOT_RUN）：B3 的真实 Pi 浏览器证据（run:d4-browser --mode real-pi，最终候选 SHA 回归）；前端 UI（后续波）。

## 10. 影响

- `apps/studio/src/materials/branching.ts`（新）：`MaterialBranchingService` + 组合上下文纯函数 + 冲突错误类型；
- `apps/studio/src/service.ts`：最小接线（`PromptOptions.newExplorationMaterialContext`、`#resolveContinuation` 材料 new-session、`submitReturn` targetAnchor null、`#newExplorationContext` 材料上下文块）；既有 Turn 来源行为不变；
- `apps/studio/src/server.ts`：材料建枝区段（§6 四端点）+ 两个 409 错误映射；
- `packages/persistence`：`MaterialRepository.createMaterialBranch`（单事务原子落库）+ `TreeRepository.hasMaterialBranchOrigin` 探针；**零新迁移**（表已在 0008；0010 归 D4-8）；
- `docs/d4/D4-contracts.md` §3：from-material 两步拆分差异回写（本 ADR §6）；
- 不碰：public/ 前端、search/、迁移、tests/fixtures/（B3 无冻结内容集——离线检查的确定性数据在检查内生成）。
