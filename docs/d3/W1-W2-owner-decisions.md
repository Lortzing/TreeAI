# W1/W2 负责人裁决清单（issue #6 P0-1）

> **状态：裁决准备材料——不是签署，不冻结任何语义。** 本清单按 GitHub
> issue #6《D3 验收｜0ccd3c5…｜No Go》修订优先级 **P0-1「负责人冻结 W1，
> 并关闭产品分歧」**整理：把该条要求逐项裁决的五项产品分歧（第一部分）、
> W1 §6 的开放项 8–11（第二部分）与 W2 其余待裁决偏差（第二部分附表）
> 汇成一份负责人可直接落笔的决策表。**本文件不代替 W1/W2、不构成 Gate 0
> 通过**；只有负责人在裁决栏落笔才构成裁决（issue #6 P0 原文口径：
> 「不要仅在签署栏填名字」「未裁决项不得写成『已实现即通过』」）。
>
> **裁决方式**：在每项末尾的裁决栏写明「**接受现状** / **修改后冻结
> （附修订项）**」，并署日期；需要附带条件或保留意见写入备注列。裁决
> 栏留空的项维持开放，不因实现已存在而视为通过。
>
> **裁决效力与 SHA 绑定**：裁决结论与日期由负责人（或经其确认的提交）
> 提交进仓库后生效，并绑定 `docs/d3/D3-status.md` 届时记录的 commit SHA
> （沿用 W1 §5 与 `evidence/d3/` 的 SHA 绑定纪律）。在此之前，本清单
> 不改变任何现状。
>
> **核实基线（2026-09-29）**：本清单所有代码行为描述均于 2026-09-29
> 对照工作树逐条核实（HEAD `ffc62bf`，main）。行号以函数 / 选择器名为
> 主锚、行号为辅（同 W2 头部口径：文件会继续演进）。**行号口径**：
> `service.ts` / `server.ts` / `packages/**` / `service.test.ts` /
> `ui-regressions.test.ts` 本波次未被改动，所引行号当前准确；
> `app.js` / `index.html` / `style.css` / `ui-probe.test.ts` 已随本波
> 次并行实现漂移（问四、问五与附表附-1 / 附-3 所涉变更已落地工作树），
> 这四个文件的行号一律指 **HEAD `ffc62bf` 时点**，语义描述不受影响。
> 问四、问五与附表的现状按「HEAD 已提交形态」与「本波次已落地形态」
> 两个分支如实并列。
>
> **事实与建议的分离**：各项「现状」小节是对照代码核实过的事实（每条
> 附文件 / 函数 / 行号）；「工程建议」小节是研发意见，负责人可以不采纳
> 建议而不必怀疑事实部分。

---

## 第一部分：issue #6 P0-1 的五项产品分歧

### 问一：Return 幂等键全局唯一还是按 Tree 唯一

**现状（事实）**

- 唯一约束是**全局**（跨树）的：`packages/persistence/src/migrations/0004-return-idempotency.ts`
  （L23）`CREATE UNIQUE INDEX idx_turns_idempotency_key ON
  turns(idempotency_key) WHERE idempotency_key IS NOT NULL`——索引不含
  `tree_id`。
- 重放查找却**按树过滤**：`packages/persistence/src/tree-repository.ts`
  `findReturnByIdempotencyKey()`（L1050–1062），`WHERE tree_id = ? AND
  idempotency_key = ? AND role = 'return'`。
- 同键用于另一棵树的实际路径：`apps/studio/src/service.ts`
  `submitReturn()`（L1328–1397）——树内重放检查（L1346）查不到他树的键
  → 照常导航回主干 → 落库时被全局索引判负 →
  `ConstraintViolationError` → 树内按键重读仍为空（L1389–1394）→
  原样上抛 → `apps/studio/src/server.ts` `sendError()`（L94）映射
  **HTTP 400 `invalid-argument`**（消息携带 SQLite 唯一约束原文）。
  Return 零写入（episode + return turn 同事务整体回滚，无悬挂 episode；
  此前的导航游标对准已照常发生）。**不是重放、不是 409，是 400。**
- 客户端按 `(tree, branch)` 维护草稿与键：localStorage 键
  `treeai-return-draft:<tree>:<branch>`（`apps/studio/public/app.js`
  `returnDraftStorageKey()`，L779–781）；每份新草稿
  `crypto.randomUUID()`（`syncReturnDraftForBranch()` / `ensureReturnDraft()`），
  失败后编辑才换新键（input 监听：`draft.failed && value !== draft.text`）。
  跨树复用同一键需要 UUID 碰撞或跨树复制草稿——存储键结构使后者不可构
  造，前者概率可忽略（W1 §6-2「该边角实际不可达」成立）。
- 文档位置：W1 §2.3「范围注记（如实）」与 §6-2。

**选项**

- **A 接受现状冻结**：契约明确「全局部分唯一索引 + 树内重放查找」——
  同键用于另一棵树 = 400（如实的约束冲突、零写入、不重放他树 Return）。
  W1 §2.3 已有该范围注记，裁决后只需在 §6-2 标注「已裁决：接受」。
  工程代价：**零**（无代码变更）。
- **B 修改后冻结（按 Tree 唯一）**：改为
  `UNIQUE(tree_id, idempotency_key)`。实现必须走**追加式 migration**
  （现有库已建全局索引：`DROP INDEX idx_turns_idempotency_key` 后
  `CREATE UNIQUE INDEX … ON turns(tree_id, idempotency_key) WHERE
  idempotency_key IS NOT NULL`）+ persistence 同键两树各自落库的往返测试
  + api/service 边界测试 + W1 §2.3/§6-2 改写。工程代价：**小**（一次
  migration + 2–3 个测试用例），收益只作用于客户端不可达的边角。

**工程建议：A。** 理由：(1) 该边角按客户端纪律不可达；(2) 现状不对称
的失败方向是安全的——只会 400 拒绝，绝不会把另一棵树的 Return 错当重
放、也不会落重复行；(3) 全局唯一对客户端缺陷**更严**：若未来某客户端
bug 跨树复用键，全局索引会立刻以 400 暴露，按树唯一会静默放行两条并行
Return，把缺陷掩盖成正常数据；(4) B 的唯一收益是让一个不可达路径从
400 变成合法行为，成本收益不成比例。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### 问二：Return 已纳入 Run 与该 Run 成败如何分别表达

**现状（事实）**

- **「已纳入」只在成功事务里发生**：`service.ts` `prompt()` 的送达标记
  `markReturnDelivered(pending.id, run.id)` 与
  `updateRunState(run.id, "succeeded")`、user/assistant turn 写入在**同一**
  `repository.transaction` 内（L1050–1074）。失败 / 中止分支（L1015–1047）
  不触碰送达——Return 保持 `confirmed`（`deliveredRunId === null`），下次
  主干 prompt 会再次组装（待送达筛选 L983–985：`role === "return" &&
  deliveredRunId === null`；组装前缀 = `composePromptText()` L499–505）。
- 因此产品中**不存在「已纳入一个失败 Run」的可观测状态**：
  `deliveredRunId` 永远指向 succeeded run。「已纳入」与「成败」当前
  **不分别表达**——送达本身就是成功 run 的标记。
- UI 表达分两个面：Return 卡（`app.js` `returnCard()`，L483–542）二态
  ——`confirmed` 呈 "confirmed — delivered on the next Trunk prompt"
  （L536）；`delivered` 呈 "delivered into Trunk context (run …)" + 点击
  反查（L524–534）→ 来源抽屉 Runs 节定位该 run 行（state / failure
  code / 起止时间，`renderDrawer()` L1857–1866）。Run 成败本身由常驻
  失败面板（`renderFailurePanel`）与诊断面表达（W2 §2.2 / §2.5）。
- 证据：service.test.ts「full D3 vertical slice…」（重启后再 prompt
  `deliveredReturns === 0`——不重复送达）；「**失败的 prompt 不标记送
  达**」无直接用例（W1 §6-4，按构造成立——失败路径按构造不触碰成功
  事务）。
- **如实边界**：模型错误的 run 里，组合文本（含 Return 前缀）已发给模
  型——`packages/runtime-pi/src/pi-runtime.ts` `drivePrompt()` 的判定次
  序是 `session.prompt` 正常返回后、从终态 `stopReason === "error"` 判错
  （L448–477）。Pi 会话侧是否保留该次 user 条目取决于 SDK 落盘时序；
  若保留，下次重试会再次组装同一 Return，**Pi 会话历史中该前缀可能出现
  两次**。TreeAI DB 不记录该次组装（无 turn、无送达）——DB 仍是「每条
  Return 恰好送达一次」的事实源，但 Pi 会话不保证该前缀只出现一次。
- 文档位置：W1 §2.6（送达与反查）、§3.5（模型错误——「已确认的
  Return 保持 `confirmed` 不被标记送达」已写入）、§6-4（证据缺口）。

**选项**

- **A 接受现状冻结**：契约明确「已纳入 = 送达 = 由成功 run 标记」——
  失败的 run 不产生「已纳入」事实，Return 保持待送达并随下一次 prompt
  重送。W1 §3.5 已有对应句子；§2.6 建议补一句失败语义并把上节「如实
  边界」（失败重送可能使 Pi 会话内前缀重复；DB 送达恰一次不受影响）作
  为范围注记写入。工程代价：**零**（可选补测见下）。
- **B 修改后冻结（区分「已尝试组装」与「送达」）**：例如失败也标记
  `attemptedRunId`（新列 + migration）或把 delivered 语义改为「已组
  装」。工程代价：**中**——W1 §2.1 状态机、`prompt()` 两个失败分支、
  读模型投影、Return 卡三态、反查语义、service/api 测试与 W1
  §2.6/§3.5 全部要改；且必须回答「失败的组装之后，下次还送不送」：
  不送则 Return 内容可能从未进入任何成功上下文（模型看过、DB 说没送
  达）；送则「恰好一次」退化为「至少组装一次」。A 之下这个问题有干净
  的答案：失败的 run 没有产生 assistant turn，从产品视角等于没发生。

**工程建议：A**，并将「如实边界」写成 W1 §2.6 的范围注记；同时把
§6-4 的测试缺口作为裁决后的补测项（小：在有待送达 Return 的树上注入
`/fail`，断言 run failed + Return 仍 confirmed + 下次 prompt 送达恰一次
——一个 service 用例即可）。理由：现状语义可检测、可解释（用户关心的
是「我的 Return 进没进主线上下文」，失败的 run 没有产生任何回答，如实
重送正是用户预期的行为）；B 引入的新状态机复杂度与它要表达的区分度不
成比例。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### 问三：降级 Return 卡是否必须持续显示原摘录

**现状（事实）**

- 锚点 turn 在当前渲染视图内 → Return 卡 meta 行含摘录：`returnCard()`
  （L504–507）`anchored on “{anchor.selection.text}” from {branch}`，卡
  紧随锚点答案渲染（`renderTurnsInto()` L567–582、L647–651）。
- 锚点不在当前视图（**嵌套支线的 Return**——其锚点在非主干分支；或无
  `targetAnchor` 的历史 Return）→ 卡按时间序**原位**渲染（L584–588），
  meta 行降级为 "original anchor unavailable"（L507）；卡面主体是
  Return 文本本身（L540），**不含摘录**。
- 摘录当前的完整可读路径：(1) 来源抽屉 Returns 节**恒显**摘录——
  `renderDrawer()` L1884–1895 `anchored on “{anchor.selection.text}”
  from …`（读自 `turn.targetAnchor` 快照，与锚点是否在视图无关；
  `targetAnchor === null` 的历史 Return 才显示 unavailable）；(2) 支线
  面板头部恒显**该分支自身 origin** 的摘录（`renderPanelAnchorContext()`
  L701–719）——注意这是分支 origin，不是主干上 Return 卡的视角。
- **数据可得性**：降级路径调用 `returnCard(turn, null)` 时，
  `turn.targetAnchor` 快照就在 turn 上（`renderTurnsInto` L573 只对
  `targetAnchor === null` 的 turn 跳过锚定归类）——卡面显示摘录**不缺
  数据**，是当前实现选择不显示。
- 文档位置：W1 §2.2「边界（如实）」与 §6-5。

**选项**

- **A 接受现状冻结**：卡面摘录仅锚点在视图时显示；降级卡不显示，摘录
  经来源抽屉读取。工程代价：**零**。建议裁决 A 时在 W1 §2.2 明写「降
  级卡摘录经来源抽屉 Returns 节读取」为契约语义（而非遗漏）。
- **B 修改后冻结（降级卡也显示快照摘录）**：`returnCard()` 增加分支
  ——`anchor === null && turn.targetAnchor !== null` 时仍渲染摘录，措辞
  注明锚点不在当前视图（如 `excerpt “…” (anchor outside this view)`）；
  `targetAnchor === null` 的历史 Return 维持 unavailable 文案。工程代价：
  **小**——`app.js` `returnCard()` 约 3–5 行 + ui-probe / ui-regressions
  补降级卡摘录断言 + W1 §2.2/§6-5、W2 §1「锚点 Return 卡」行改写；
  无数据 / 服务端变更。

**工程建议：B。** 理由：(1) W1 §1.3 的降级原则是「保存的选区摘录
**始终完整可读**——降级不删除、不遮蔽已落库的产品事实」，降级 Return
卡是唯一一个摘录不在同屏的降级面，与该原则的精神不一致（抽屉可读是较
弱的满足：需要两次交互）；(2) 数据已在 turn 上，纯呈现变更；(3) 与
§6-8 回退放置规则联动冻结时，一张原位渲染的卡自带「它从哪来」的摘
录，回退规则才自洽。若负责人希望零改动收口，A 亦成立（抽屉路径完整可
用），但建议按上句把抽屉读取明写进契约。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### 问四：窄窗来源抽屉——保留右侧滑入还是改为底部上滑

**现状（事实，两个分支如实并列）**

- **HEAD `ffc62bf` 已提交形态：右侧滑入。**
  `apps/studio/public/style.css` `#source-drawer` 基础规则
  `position: fixed; top: 0; right: 0; bottom: 0`（L429–443），进出场动效
  复用 `panel-in` / `panel-out`（`translateX(24px)` 自右滑入，L444–445
  与 L344–353）；窄窗 <720px 只改全宽（`@media (max-width: 719px)` 块
  L519–546 中 `#branch-panel, #source-drawer { width: 100%;
  max-width: 100% }`，L545）——**方向不变**。W2 §2.7 窄窗行据此记
  「自底向上 ✗——实现为右侧全宽滑入……方向与源设计的偏差待 owner 裁
  决」。
- **本波次方向：自底向上（源设计；已随本波次并行实现落地）。** 与本清
  单同批交付的并行实现任务已按源设计方向实现窄窗（<720px）来源抽屉自
  底向上（底部整幅上滑）：`style.css` 新增 `@keyframes drawer-up-in` /
  `drawer-up-out`（`translateY(100%)` 整幅位移）并在 `@media
  (max-width: 719px)` 块内覆写 `#source-drawer.enter` / `.exit`（宽窗右
  侧滑入的 `panel-in` / `panel-out` 基础规则不变；reduced-motion 由全
  局降级块照常即时化）。**如裁决保留右侧滑入，需回退该实现**——回退
  点：`style.css` 的 `drawer-up-in` / `drawer-up-out` 两个 `@keyframes`
  + 窄窗块内 `#source-drawer.enter` / `.exit` 覆写 +
  `apps/studio/tests/ui-probe.test.ts` 窄窗词法断言（本波次新增的对
  `drawer-up-*` 键幅与窄窗块声明的断言，位于「narrow window: <720px
  rules exist in style.css…」场景，HEAD 时点起于该测试 L2006）。

**选项**

- **A 底部上滑（源设计方向；本波次已实现）**：冻结该方向。工程代价：
  **已付**（随本波次落地）；W2 §2.7 窄窗行改「已实现（待实机验收）」。
- **B 保留右侧滑入（HEAD `ffc62bf` 形态）**：回退本波实现（上述回退
  点，一次回退提交 + 词法断言还原）；W2 §2.7 行以「接受偏差」口径冻
  结。工程代价：**一次回退**。

**工程建议：A。** 理由：W2 的权威源设计在负责人交付夹，仓库内清单的
约定列本来就是「自底向上」——B 是把已按源设计落地的实现退回一个文档
自己标记为偏差的形态，唯一收益是「不回退」，而回退恰是 B 的成本；窄窗
下抽屉无论从右还是从底都是全屏覆盖，功能等价，差异只在设计一致性；
A7 签收以逐项对照源设计为前提，A 少一处需要在签收表里专门解释的偏
差。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### 问五：错误横幅朗读、初始焦点、列表加载失败重试是否属于 D3 必须项

**现状（事实；HEAD `ffc62bf` 时点三项均未实现；本波次并行实现已按源设计方向落地，工作树含下述变更）**

- **错误横幅朗读**：`apps/studio/public/index.html` `#error-banner`
  （L41）/ `#panel-error-banner`（L64）为普通 `div`——无 `role` /
  `tabindex` / `aria-live`；`app.js` `showError()`（L204–211）设
  `textContent` + 8 秒自动隐藏。对照：`#run-status` 已有
  `aria-live="polite"`（index.html L31）、两个会话容器已有
  `aria-live="polite"`（L40 / L63）——**错误横幅是唯一缺朗读语义的动
  态错误面**。W2 §2.4 键盘焦点行记「缺口：不可 Tab 触达、不朗读」。
- **初始焦点**：启动 IIFE（`app.js` L2049–2060）`refreshTrees()` → 自
  动开首棵树或 `renderAll()`，全程无编程聚焦——焦点留在 body，不落
  「新建」按钮；Tab 序天然符合 DOM 序（`#new-tree` 在列表前，
  index.html L15–16）。W2 §2.1 键盘焦点行记「初始焦点未编程设定」。
- **列表加载失败重试**：`refreshTrees()` 失败经启动 catch → `showError()`
  通用横幅（8 秒自动隐藏）；无专属重试按钮，重试 = 刷新页面或重选树
  （W2 §2.1 状态行如实记录「加载失败无自动 UI 断言」）。
- **本波次方向（已落地）**：与本清单同批交付的并行实现任务已按源设计
  方向实现三项——错误横幅 `role="alert"`（隐式 aria-live 朗读语义）+
  `tabindex="0"`（可 Tab 触达）；启动初始焦点一次性编程设定到「新建」
  按钮（成功 / 失败路径一致落位，后续重渲不夺焦）；树列表加载失败为侧
  栏**常驻重试面**（错误事实 + Retry 按钮，重试不整页刷新、在途禁用 +
  「Retrying…」明示）。
- 相关断言面：`apps/studio/tests/ui-regressions.test.ts` 对两横幅的
  hidden / 文案已有断言（HEAD 时点 L1084 / L1123 / L1225 / L1278 /
  L1372 / L1400 一带）——朗读语义补建不改变这些断言的通过性。

**选项**

- **A 三项全部纳入 D3 必须项（源设计方向；本波次已实现）**：冻结为实
  现口径；A7 人工签收按含三项的口径对照。工程代价：**已付**。
- **B 三项全部不属 D3 必须项**：实现**保留为非阻塞改进**（不回退、不
  删除）；W2 §2.1 / §2.4 相应行的验收口径改为「D3 范围外改进项」；D3
  验收不再依赖这三项。工程代价：**零**（实现保留），仅 W2 行改口径。
- **C 部分纳入（负责人逐项勾选）**：例——朗读语义纳入、初始焦点与列
  表重试列为改进项。工程代价：零（实现均已落地），仅验收口径区分。

**工程建议：A。** 理由：(1) 三项都不是新需求——W2 §2.1 / §2.4 的
「约定」列本来就这么写（错误可被屏幕阅读器感知、初始焦点在「新建」、
加载失败有重试不空白），A 只是让验收口径与既有约定一致，B 则要把三行
约定改写成「接受偏差」；(2) 成本已付，A 不产生任何增量工程；(3) 朗读
语义是 A7「屏幕阅读器检查」的前置——错误不可朗读时，屏幕阅读器验收本
身就不完整；(4) 若负责人确要收缩 D3 范围，最可让步的是**列表重试**
（刷新 / 重选树已可达同一结果），最不应让步的是**朗读语义**。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

---

## 第二部分：W1 §6 开放项 8–11

### §6-8：Return 卡的回退放置规则

**现状（事实）**

- 锚点 turn 在当前渲染分支 → Return 卡紧随锚点答案渲染
  （`renderTurnsInto()` L567–582、L647–651，锚定归类按
  `targetAnchor.anchorTurnId` 命中当前视图 turn 集合）；锚点不在当前视
  图 → 按时间序**原位**渲染 + 降级标注（L584–588；`returnCard()`
  L483–542）。ui-probe 有「anchored Return renders immediately after
  its anchor turn」结构断言（HEAD 时点 L1317 一带）。
- W1 §2.2 只约定「原分叉点附近」，**回退放置规则未入契约**（§6-8 原
  文）。

**选项**

- **A 冻结现行规则**：把回退规则写入 W1 §2.2——锚点 turn 在当前渲染
  分支 → 紧随其后；否则按时间序原位 + 降级标注；摘录呈现跟随问三的
  裁决。工程代价：**零**（纯文档）。
- **B 改放置策略**（如降级 Return 集中置顶、或不在主干渲染仅抽屉呈
  现）：需改 `renderTurnsInto()` 与 ui-probe / ui-regressions 断言。工
  程代价：小–中；且丢掉「原位时间序」与主干叙事顺序的一致性，无产品
  收益可见。

**工程建议：A。** 规则已实现、有结构断言，时间序原位是「原分叉点附
近」在数据允许范围内的最贴近解释。与问三联动：若问三裁决 B，§2.2 的
回退规则条目应一并写入「降级卡显示快照摘录（注明锚点不在当前视图）」。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### §6-9：提交失败后的客户端状态

**现状（事实）**

- `app.js` `submitReturn()` catch（L1727–1751）：失败 → `GET /state` 对
  账（`findReturnByKey` + 三元谓词 `returnMatchesDraft`：键 + 来源分支 +
  文本全同，L1644–1681）；三元全同命中 → 按成功清草稿；**同键异容 →
  显式冲突**（`returnConflictError` L1684–1698：冲突事实 + 草稿与面板
  保留 + 「编辑换新键」引导）；**未命中 → 草稿与键保留**（localStorage
  持久化；input 监听仅 `draft.failed` 后改写才换新键）、面板保持、同键
  可重试。面板重开先对账（`syncReturnDraftForBranch()` L853–898——已
  落库的持久草稿直接丢弃，呈现 confirmed / delivered 卡）。
- 回归覆盖：`apps/studio/tests/ui-regressions.test.ts`（文件级：409 冲
  突保留草稿与面板、对账三元谓词、面板打开对账、收起失败呈现在主线）
  + ui-probe（文件级：防双击恰一次 POST、失败保留草稿、改写换键）。
- W1 §2.4 只约定服务端写入顺序；**客户端失败状态未入契约**（§6-9 原
  文）。

**选项**

- **A 写入 W1 §2.5**：把客户端失败状态四要素入契约——失败后草稿与幂
  等键保留（持久化）、面板不收、同键重试 / 编辑换键、冲突显式提示不
  吞错；成功（含 200 重放）才清草稿、收面板、焦点回主线。工程代价：
  **零**（行为已实现且有 DOM 级回归）。
- **B 不入契约**：客户端失败状态留为实现细节。工程代价：零，但契约
  对「失败后用户看到什么、能否安全重试」没有约束。

**工程建议：A。** 响应丢失恢复（§2.5）只写服务端半边时，恰是
issue #2 / #5 反复要求的场景缺了客户端半边；行为已实现、已回归，冻结
零成本、不冻结有回归风险。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### §6-10：无 idempotencyKey 的遗留 Return

**现状（事实）**

- HTTP 面恒要求键：`server.ts` `/return` 路由
  `requireString(body, "idempotencyKey")`（缺 / 空白 → 400，字段名进消
  息，L157–163）；`service.ts` `submitReturn()` 校验非空（L1337–1339）；
  部分唯一索引只约束非空值。api.test.ts「return idempotency over HTTP:
  201 create, 200 replay, 409 conflict, 400 missing key」覆盖缺键 400。
- repository 层无键 Return 可往返（service.test.ts:763
  「repository-level return without a key still round-trips (legacy
  shape)」）——migration 0004 前的历史行两列为 NULL，读路径必须容忍
  （migration 0004 头注释：「既有行两列保持 NULL……不回填、不改写」）。
  读模型投影中无键 Return 的 `idempotencyKey` 为 null，客户端对账按键
  相等匹配，null 永不命中草稿 UUID——不参与幂等对账。
- 当前**唯一**的无键写入方是直连 repository 的测试本身；service / HTTP
  写路径不可能产生无键 Return。

**选项**

- **A 冻结为**：「写路径恒带键（HTTP 缺键 400）；读路径容忍历史无键
  Return（只读兼容，不属于产品语义、不参与幂等对账）」。工程代价：
  **零**。
- **B 仓库层禁止无键写入**：改 persistence 校验并改写 :763 用例。工程
  代价：小；收益近零（写路径已不可能产生），且有把「历史行必须可读」
  （migration 0004 前向增量设计）与「禁止写入」纠缠出回归的风险。

**工程建议：A。** 与 migration 0004 的前向增量设计一致；B 防御的是一
个已不存在的写入方。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### §6-11：与仓外联合讨论稿的等价性

**现状（事实）**

- W1 文本源自仓外联合讨论稿的仓内整理；仓内无法核验两者等价（W1
  §6-11 原文）。注意：仓内文本已经两轮逐条对照代码修正（issue #5 波次
  + issue #6 波次；§6-1 / §6-6 列出修正）——**它很可能已与仓外原稿不
  同**，差异方向是「以代码为准」。
- 该对照是 issue #5 P0「W1 与 W2 签收」列出的签署前提之一。

**选项**

- **A 逐节对照仓外原稿**：负责人确认无未携带的要求后记录结论。工程代
  价：负责人时间（两份散文的逐字对照，出错率高）；若发现未携带要
  求，转入修订。
- **B 宣布仓内 W1 文本为唯一权威版本（supersede 仓外稿）**：不再做等
  价性对照；仓外稿的使命在内容携入时结束。工程代价：零；风险是仓外
  稿若含未携入的要求会就此丢失——只有负责人能判断。

**工程建议：B 为主、附带一次重点抽查。** 对照 §2.3（幂等键）与 §3.2
（abort 错误码）两节——它们是勘误改写过、最可能偏离原稿共识的段落；
若原稿在这两节有仓内文本没有的要求，按需修订。理由：仓内文本的可信
度锚在代码对照与测试上，逐字等价对照反而把可信度降回到两份散文的一
致性；声明 supersede 让「签署哪个文本」无歧义。

| 裁决（接受现状 / 修改后冻结） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### §6-1..7：勘误 / 对照（无需逐项裁决；冻结时一并确认）

以下各项正文已按代码改正或加注，不构成分歧，冻结 W1 时随签署一并确
认即可；其中三项与第一部分重叠，裁决栏见彼处：

1. **§3.2 abort 错误码（已改正）**：非活动 run → 409；跨树 run / 空
   runId → 400；未知树 / run → 404（`server.ts` `sendError()` L89–132
   + abort 路由注释）。残余选项「跨树 abort 亦归 409」属契约变更（需
   改 `server.ts` 映射与 api 测试）——默认接受已改正现状，如需变更在
   签署备注注明。
2. **§2.3 唯一约束范围（加注）**——即**问一**，裁决栏见彼处。
3. **§1.2 `changed` 判定无直接用例（加注）**：产品无 turn 改写路径，
   正常流不可构造 `changed` 态；自动化只覆盖 available / unavailable。
   冻结时确认接受该证据边界；补测试需直改 DB 伪造不变量破坏或引入编
   辑功能。
4. **§2.6 / §3.5「失败的 prompt 不标记送达」无直接用例（加注）**——
   即**问二**的证据面（送达只在成功事务内，`service.ts` L1050–1074）；
   可选补测见问二建议。
5. **§2.2 降级 Return 卡的摘录（加注）**——即**问三**，裁决栏见彼处。
6. **实现基线表述过时（已改正）**：实现分布多波次（`8671136` /
   `6ff7146` / `d061b5f` / issue #3–#6 波次），本稿基线随波次勘定。
7. **§2.4 new-session 直落库分支无专属用例（加注）**：
   `switchBranch()` 对 new-session 显式返回 null 不导航
   （`service.ts` L1257–1261），按构造覆盖；无「空主干提交 Return」的
   独立用例。

### 附表：W2 其余待裁决偏差（不在 P0-1 五问之内；issue #6 A7 / P1「先裁决并修复上表 W2 偏差」口径）

以下三项是 W2 逐屏清单中自记的偏差。**附-1 与附-3 已随本波次并行实现
按源设计方向落地（工作树已含变更）；附-2（摘录横向滚动）本波次未涉及、
维持换行呈现。**为完整关闭「产品分歧」一并附上：

| # | W2 位置 | 现状（事实） | 选项与代价 | 裁决 / 日期 / 备注 |
| --- | --- | --- | --- | --- |
| 附-1 | §2.6 键盘焦点行：降级时焦点到说明区 | **已随本波次落地**：`#panel-anchor-context` 加 `tabindex="-1"`（index.html）+ 揭示降级分支聚焦它（`app.js` `revealOrigin()` 降级分支 `$("panel-anchor-context").focus()`；实现取舍：聚焦常驻说明区（摘录 + 状态徽标）而非 8 秒自动隐藏的横幅——横幅消失会连焦点一起丢）；HEAD `ffc62bf` 时为降级走 `showError()` 横幅、不移焦点 | A 接受本波实现（源设计方向；代价已付）；B 回退为「横幅呈现、焦点不动」（回退点：index.html 的 `tabindex` + `revealOrigin()` 降级分支 focus 调用 + ui-probe 断言） |  |
| 附-2 | §2.6 窄窗行：摘录横向滚动 | 摘录为换行呈现（`#panel-anchor-context { overflow-wrap: anywhere }`，`style.css` 的 `#panel-anchor-context` 规则，本波次未改），非源设计约定的横向滚动（实现取舍：避免窄窗横向滚动条） | A 接受换行（实现取舍入契约）；B 改横向滚动（`overflow-x: auto; white-space: pre` + 断言；长摘录窄窗出横向滚动条） |  |
| 附-3 | §2.1 窄窗行：「新建」按钮全宽 | **已随本波次落地**：窄窗块新增 `#new-tree { width: 100% }`（`style.css` `@media (max-width: 719px)` 内）+ ui-probe 词法断言；HEAD `ffc62bf` 时无此规则 | A 接受本波实现（代价已付）；B 回退（窄窗块该行 + 词法断言） |  |

**范围外注记（如实）**：`docs/d3/D3-status.md` A4 行提及一处「owner
ruling suggested under W1 §6」的架构观察——**每树谱系单一 session 文
件，文件级丢失会把整树标记不可用、恢复分支的首个 prompt 亦
fail-closed**（证据：`evidence/d3/real-pi/20260929T104445Z-faults-abort-restart-session.md`）。
W1 §6 现无对应条目，该事项也不在 issue #6 P0-1 五问与本清单 §6-8..11
之内（属 session 架构而非 Return/锚点契约）。如负责人希望一并裁决，
可在下行批注或指示增补 W1 §6-12：

| 架构观察裁决（可选） | 日期 | 备注 |
| --- | --- | --- |
|  |  |  |

### 浏览器面新发现（issue #6 浏览器波，2026-09-29，`fcfae52`）

浏览器 UI 级跑批器（`scripts/run-d3-browser.mjs`，真实 Chrome 驱动真实
UI）在真实渲染面上发现的偏差——非 W2 自记项，属新增裁决面。同波的
`closeDrawer` aria 陈旧缺陷已修复（`279e86a`，`closeDrawer` 补
`renderDrawer()` 对齐开关状态；ui-probe 断言两向立即翻转），不列裁决：

| # | W2 位置 | 现状（事实） | 选项与代价 | 裁决 / 日期 / 备注 |
| --- | --- | --- | --- | --- |
| 附-4 | §2.7 来源抽屉（宽窗行） | 抽屉为 fixed 右侧整幅覆盖层（`#source-drawer` `z-index:20`、宽 360px、`top/right/bottom:0`）。打开时**同时盖住**主线 composer 的 Send 按钮（`.composer-actions` 右对齐）与 Sources 开关自身（branch-bar 最右）——鼠标用户关闭抽屉的唯一路径是 **Esc**；开关上的「× Close sources」文案对鼠标不可达。窄窗全幅抽屉同理盖住整幅视口 | A 接受现状（键盘 Esc 为唯一关闭路径；W2 §2.7 键盘行已列 Esc 逐层关闭语义；代价为零）；B 抽屉加自身关闭按钮（抽屉头部加「×」按钮 + 点击关闭；改动点：`renderDrawer()` 头部 + `closeDrawer` 复用 + ui-probe/browser 断言）；C 抽屉改非覆盖布局（主线让位；动效与阅读位置语义需重设计，代价最高） |  |

证据：`evidence/d3/browser/20260929T144428Z-echo-product-loop.md`（elementFromPoint 覆盖防护在抽屉打开时拒绝 Send/开关点击，逐项复现）；同 SHA 真实 Pi 浏览器录制同现。

---

## 第三部分：签署路径

全部裁决栏填写后，剩余步骤（按序，均为轻量文档/记录动作）：

1. **按裁决更新 W1 / W2**：W1 §6 各项标注裁决结论（§6-8..11 的结论并
   入正文或以「已裁决」落款；§6-1..7 随签署一并确认）；W2 相应行
   （§2.1 / §2.4 / §2.6 / §2.7）按裁决改状态与口径。裁决为「修改后冻
   结」的项按其修订项排期实现（本清单已逐项给出改动点与代价）。
2. **填 W1 签署表**（W1 文末）：产品 / 研发 / 负责人三行——签署、日
   期、结论（「冻结」或「需修订（附修订项）」）。负责人行签署后 W1 脱
   离 DRAFT。
3. **记录到 D3-status**：裁决日期、执行裁决的 commit SHA、W1 签署状
   态（Gate 0 的 W1 半边关闭）；W2 剩余项回到 A7 人工验收路径（逐屏
   对照源设计 + 签收表绑定同一 SHA）。
4. **空裁决栏的项维持开放**——不得写成「已实现即通过」（issue #6
   P0 原文口径）。
