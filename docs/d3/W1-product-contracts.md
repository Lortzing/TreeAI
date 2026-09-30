# W1 产品契约（仓内镜像，符合性标准为已签署 v3.0）

> **状态：仓内镜像——符合性标准是仓外已签署 v3.0。** 仓外《TreeAI W1
> 产品与研发联合契约 v3.0》已于 2026-09-30 **签署生效**；issue #7
> （2026-09-30 验收）裁定：W1 v3 产品决策**已授权签署、已完成，不重复
> 要求签署**，以签署版为符合性标准，仓内旧 DRAFT/待裁决文字不覆盖它。
> 本文档是签署版语义的仓内实现对照镜像：正文随实现对齐签署版；**研发
> 未符合条目在 §7 汇总**（当前：术语三部分 ①②③ 全部未交付）。本文档
> 不再携带签署请求；Gate 0–2 与 A1–A7 的验收仍为负责人决策（见
> `docs/d3/D3-status.md`，该文件只记录状态）。
>
> **v3.0 对齐（2026-09-30）**：保存先于导航 §2.4 / 幂等键按 Tree 唯一
> §2.3 / 采用尝试与首次成功采用分离 §2.1、§2.6 / `changed` 锚点不阻断
> 仍有效的续聊 §1.3——均已实现并有测试。**issue #7 P0/P1 整改
> （2026-09-30 本波落地）**：来源定位/续聊分离（§1.2/§1.3——锚点状态
> 不再由 session 可用性降格，揭示的 Pi 游标对齐作为独立可失败的
> navigation 结果分离返回）；整树 session 丢失后的显式新探索（§3.4——
> `promptNewExploration`，用户确认换轨：新 session + 摘录/已保存历史
> 作为首问上下文 + 旧上下文缺失声明，旧历史保持可读）；降级 Return 卡
> （§2.2/§6-5/§6-8——回退放置携带 targetAnchor 快照，区分来源位于其他
> Branch/已变化/缺失，摘录 + 确认时间在卡面，长摘录折叠，首次成功采用
> 时间从采用尝试记录反查）。
>
> **实现基线（2026-09-29 勘定，issue #5）**：本文本已对照实际实现与测试
> 逐条核实——载体为 `packages/contracts/src/product.ts`、
> `apps/studio/src/service.ts`、`apps/studio/src/server.ts`、
> `apps/studio/public/app.js`（`app.js` / `service.ts` / `server.ts` 的
> 行号已随 `4a925cd`——ToolPolicy 门控波次——更新；其余载体自
> `56f8c31` 未变），证据
> 为 `apps/studio/tests/` 全部套件（套件在 issue #5 波次持续扩充：
> `ui-probe`、`ui-regressions` 一律**文件级**引用，不作场景名/计数引用）
> 与 `tests/integration/scenarios.test.ts`（D2 层支撑）。各节标注
> **已实现**：语义已实现并有自动化证据（符合性以签署版为准，不再以
> 仓内签署为冻结前提）。文档与代码的一致
> 性以绑定 commit SHA 的证据（`evidence/d3/`）为准，不以本文档自述为准。

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 仓内镜像（符合性标准 = 仓外已签署 v3.0，2026-09-30；issue #7 裁定不重复签署） |
| 依据 | issue #2（2026-09-29）P0 与 A2–A5 缺口；issue #5（2026-09-29）逐条核实；issue #7（2026-09-30）P0/P1 整改与术语范围 |
| 契约载体 | `packages/contracts/src/product.ts`（TurnSelection / Turn / BranchOrigin / ReturnTargetAnchor 共享形状）、`apps/studio/src/service.ts`（产品语义）、`apps/studio/src/server.ts`（HTTP 映射）、`apps/studio/public/app.js`（客户端 draft/幂等键语义） |
| 证据口径 | 自动化离线 → `evidence/d3/offline/`；真实 Pi 与目标 Mac → `evidence/d3/real-pi/` |

## 1. 锚点（Anchor）契约

> **状态：已实现（issue #7 P0-1 波次对齐 v3 §1.2）。** 判定与降级语义见
> `service.ts` `#anchorStatus()`、`revealBranchOrigin()`（来源定位与
> Pi 游标对齐分离）与 `persistence` 的 `setBranchOrigin()` 校验；证据：
> service 套件（见 §4 R1/R2）。`changed` 判定分支已有直接用例（直改 DB
> 构造，§6-3）；session 不可用不再降格来源状态（P0-1，下表 + §1.3）。

### 1.1 选区：绝对字符偏移

`TurnSelection = { start, end, text }`：

- `start` / `end` 是**相对锚点 assistant turn 文本的绝对字符偏移**（`start`
  含、`end` 不含），不变量为 `0 <= start <= end <= anchorTurn.text.length`
  且 `anchorTurn.text.slice(start, end) === selection.text`；
- **重复词与跨行选区一律以绝对偏移消歧**。渲染、揭示（reveal）、校验都只
  信任偏移，禁止用字符串搜索在 turn 文本中"找回"选区——重复词场景下搜索
  会命中错误位置，跨行场景下搜索结果不唯一；
- `selection.text` 是提交时保存的摘录快照，随 origin 落库，永不因后续
  编辑而改写。

实现对照：形状与不变量 = `product.ts` `TurnSelection`（L81 起）；写入时
校验（角色 / `anchorEntryId` 一致 / 偏移界内 / 切片一致）=
`persistence` `setBranchOrigin()`（`tree-repository.ts` L1080 起）；UI 选区
以 Range 前缀长度求绝对偏移、不搜索 = `app.js` `selectionOffsetsWithin()`
（L487 起）；高亮按偏移切片 = `renderTurnsInto()`（L603 起）。

### 1.2 锚点完整性三态（issue #7 P0-1：与 session 可用性分离）

每个锚定分支的 origin 在读取时判定为三态之一。判定规则（每条独立成立
即归类）——**来源维度只读产品事实**（数据库原文、版本/切片与身份），
**与 Pi session 可用性无关**（signed v3 §1.2：来源身份与文本未变，揭示
就必须可用；session 损害是续聊维度的事实，由 `sessionAvailability`
单独呈现）：

| 状态 | 判定条件（任一成立） | 语义 |
| --- | --- | --- |
| `unavailable` | 出处分支（`sourceBranchId`）已不存在；或锚点 turn（`anchorTurnId`）已不存在 | 事实缺失，锚点不可用 |
| `changed` | 锚点 turn 存在但 `branchId !== sourceBranchId`；或 `role !== "assistant"`；或 `piEntryId !== origin.anchorEntryId`；或偏移越界（`start < 0`、`end < start`、`end > text.length`）；或 `text.slice(start, end) !== selection.text`；或锚点 turn 无 `runId` 或 runId 悬空 | 事实尚在，但不再满足锚点不变量 |
| `available` | 以上全部不成立 | 来源身份与文本未变，可准确定位、可揭示（**即使锚点 session 文件已删除**——数据库原文照常定位高亮） |

实现对照：逐条一致（`service.ts` `#anchorStatus()`——实体缺失
→ unavailable；branchId/role/piEntryId/偏移/切片/runId 悬空 → changed；
否则 available。**不再读取 run.session.availability**——issue #7 裁定旧
实现「仍用 run.session.availability 判来源」违反 v3 §1.2，已改正）。

### 1.3 降级语义（不伪造）与揭示的分离结果

`changed` / `unavailable` 锚点：

- 保存的选区摘录（`selection.text`）**始终完整可读**——降级不删除、不遮蔽
  已落库的产品事实；
- 揭示（reveal）**拒绝执行并如实报告**当前状态与原因（不伪造定位成功、
  不静默改判为可用、绝不以首个字符串匹配或整答回退到别的位置）；
- 续聊（continuation）**不受锚点降级阻断**（已签署 v3.0 §1.2）：来源
  已变化/不可用只说明"准确揭示"不可行；该分支若自身续聊上下文仍有效
  （续聊点可解析 + session 可用），允许继续，并说明基于当时上下文。
  受损维度各归各位（dimension-specific）：来源损坏阻断揭示，session
  损坏阻断续聊，互不放大、也绝不静默换锚；
- UI 不得把降级态渲染成可用态；降级视图必须给出可执行的去向（见 §3.4）。

`available` 锚点的揭示（**issue #7 P0-1：来源定位与 Pi 游标对齐分离**）：
`revealBranchOrigin()` 返回**纯产品定位**（sourceBranchId / anchorTurnId /
status / selection——全部来自数据库事实）+ **独立的 navigation 结果**：

- `navigated`——活动 Pi 会话已对准锚点条目（游标落出处分支）；
- `failed`（`code` + `message`，如 `session-corrupt`）——对齐尝试失败
  （锚点 session 缺失/损坏或运行期错误）。**失败不降格来源状态**：
  揭示返回的绝对偏移/摘录仍然准确，UI 照常高亮数据库原文，并如实提示
  「定位成功但活动会话未对准」（后续 prompt 自导航，续聊不受影响）。

实现对照：摘录恒显 = `app.js` `renderPanelAnchorContext()`（与
originStatus 同屏呈现）；揭示拒绝并如实报告 = `revealOrigin()`
（"Source reference {status}; saved excerpt remains available."）；
分离结果呈现 = `revealOrigin()` 对 `source.navigation.status === "failed"`
在**高亮照常落地后**以面板横幅如实提示（不吞掉、不降级）；
导航分离 = `service.ts` `revealBranchOrigin()`（锚点 session 经存在性
探针判不可用时不发起注定失败的运行期调用，`navigation` 携带
`session-corrupt` 如实分离返回）；续聊门控与锚点状态**相互独立** =
`service.ts` `#resolveContinuation()` 只看「分支自身最新 run（无则
origin 锚点 run）的 session 引用 + 可用性探针」，不看 `#anchorStatus()`
——`changed` 锚点的分支仍可续聊（§6-3）；fail-closed 的续聊（session
不可用）见 §3.4。

## 2. Return 契约

> **状态：已实现（符合性标准 = 已签署 v3.0）。** 语义核心 = `service.ts` `submitReturn()` /
> `prompt()` / `composePromptText()`；HTTP 映射 = `server.ts`；客户端
> draft/幂等键 = `app.js`；证据：service / api / ui-probe 套件（见 §4
> R3–R8）。

### 2.1 事实与状态：draft / saved / adoption attempt / successfully adopted（已签署 v3.0 §3.2）

| 状态 | 定义 | 迁移与规则 |
| --- | --- | --- |
| `draft` | 仅存在于客户端（浏览器本地 localStorage）：不落 TreeAI DB、不产生任何产品事实、不进入 Pi 上下文、不在任何分支视图渲染为 turn。可自由编辑、丢弃；明确不保证跨设备同步 | `draft → saved` 仅由用户**显式提交**触发 |
| `saved`（已保存） | 已持久化的 return turn（记录在主干分支，含出处分支 `fromBranchId` 与 `targetAnchor` 快照），`deliveredRunId === null` 且尚无采用尝试。保存成功不以 Pi 导航成功为前提（§2.4）——导航失败不回滚、不丢失 | `saved → attempted`（隐式）由某个主干 Run 把它组装进确定输入触发 |
| `adoption attempted`（采用尝试过） | 某个主干 Run 的确定输入已包含该 Return（`return_adoption_attempts` 有该 (return, run) 关联），但该 Run 尚未成功。失败/中止的尝试**不消耗**该 Return：仍待成功采用，下一次主干 prompt 前重新注入；此前尝试记录保留 | `attempted → delivered` 仅由**首次成功**收敛的主干 Run 触发 |
| `successfully adopted`（首次成功采用） | `deliveredRunId` 非空——**首次成功完成且包含该 Return 的主干 Run** 的身份，恰记录一次；此后不再作为待采用前缀注入 | 终态（就前缀注入而言）；`deliveredRunId` 只表示首次成功，不是全部采用尝试的替代记录 |

三组事实**分开记录**（已签署 v3.0 §3.2）：保存（turns 行）／采用尝试
（`return_adoption_attempts` 关联表，migration 0006）／Run 结果（runs 行
自身，读取面以关联 + run 状态联合投影）。不承诺"模型恰好看到一次"——
承诺的是：提交不重复保存、输入关联准确、成功采用可反查。UI 主呈现
"已保存·待采用 / 已采用"，失败尝试与 Run 结果可展开查看（来源抽屉），
不把全部内部状态堆在卡面。

实现对照：状态词汇与派生规则 = `product.ts` 文档块（持久层无独立状态列，
saved/attempted/adopted 由 `deliveredRunId` 与 `return_adoption_attempts`
派生）；draft 仅客户端 = `app.js` localStorage 草稿（键
`treeai-return-draft:<tree>:<branch>`）；采用尝试落库 = `prompt()` 在
createRun 后、运行前记录全部待采用 Return 的关联（`recordReturnAdoption
Attempt`）；首次成功采用 = `prompt()` 成功收敛事务内 `markReturnDelivered`
（条件 UPDATE，恰一次）；待采用筛选 `deliveredRunId === null`——已成功
采用的 Return 不再进入组装、也不再新增尝试（service 测试：失败 run 留下
尝试记录且不置 `deliveredRunId`，下次成功后尝试面含失败+成功两条、再后
无新尝试）。

### 2.2 targetAnchor：提交时快照

`targetAnchor` 是提交时刻对回源分支 origin 锚点的**快照**：
`{ sourceBranchId, anchorTurnId, anchorEntryId, selection }`。

- 它是**主干上的原分叉点附近**——Return 卡渲染的位置；UI 在锚点处显示
  Return 卡并反查 `deliveredRunId` 与采用尝试面（issue #2 P0）；
- 快照在提交时冻结：此后锚点退化（`changed` / `unavailable`）不移动、
  不改写已提交 Return 卡的位置，卡上保存的摘录仍然可读（与 §1.3 一致）。

实现对照：快照构造 = `service.ts` `submitReturn()`（取自
origin，与提交同事务落库；service 测试「return persists its target anchor
snapshot of the branch origin」）；卡按 `targetAnchor.anchorTurnId` 定位 =
`app.js` `renderTurnsInto()`（锚定路径 / 降级路径）+
`returnCard()` 反查入口。**降级放置（issue #7 P1 已实现，§6-5/§6-8
关闭）**：锚点 turn 不在当前视图（如嵌套支线的 Return，其锚点在非主干
分支）时，卡面**同样携带 targetAnchor 快照**并区分「来源位于其他
Branch / 已变化 / 缺失」（`returnFallbackReason()` 按快照反查树状态），
摘录 + 来源路径在卡面可读（短摘录内联、长摘录 `<details>` 折叠），确认
时间取产品 `turn.createdAt`，首次成功采用时间从采用尝试记录反查
（`deliveredRunId` 对应 run 的 `terminalAt`）。

### 2.3 idempotencyKey：幂等键（按 Tree 唯一，已签署 v3.0 §3.4）

- **生成**：每次逻辑提交由客户端生成一个 UUID；
- **稳定性**：同一内容（同一 `(fromBranchId, text)`）的重试**复用同一键**；
  失败后用户编辑了文本（或改换来源分支）则**生成新键**——旧键作废，同键
  不同内容会被 409 拒绝（见下）；
- **存储（唯一性按 Tree 限定）**：return turn 的 `idempotencyKey` 建立
  **树内**唯一约束（partial UNIQUE on `(tree_id, idempotency_key)`，仅
  非空值参与）。同一键可在**不同 Tree** 中各自独立使用——互不重放、互不
  冲突；同一 Tree 内同键至多一条 Return。数据库是最后一道防线：即便客户
  端缺陷导致同键重复提交，也不可能在同一棵树落两条已保存 Return；
- **重放**：同树同键 + 同 `(fromBranchId, text)` → 返回**同一 Return**
  （HTTP `200`，重放，区别于首次的 `201` created）；
- **冲突**：同树同键 + 不同内容 → HTTP `409`（`return-conflict`），且
  **零写入**；
- **读模型**：树状态读模型暴露 return turn 的 `idempotencyKey`（连同
  `targetAnchor`、`deliveredRunId`），供客户端对账（§2.5）与 UI 反查。

实现对照：客户端生成/换键 = `app.js` `crypto.randomUUID()`（草稿创建
L948 与失败后编辑换键 L960、L984）；树内唯一约束 = `persistence`
migration 0005（先 DROP 0004 的全局索引 `idx_turns_idempotency_key`，再
`CREATE UNIQUE INDEX idx_turns_idempotency_key_tree ON turns(tree_id,
idempotency_key) WHERE idempotency_key IS NOT NULL`——append-only，不改写
旧迁移）；重放/冲突 = `submitReturn()` 幂等前置检查与并发兜底（L1415–1495）
+ `#alignWithExistingReturn()`（L1507，按树过滤 `findReturnByIdempotencyKey`）；
跨树独立 = repository 测试「the same idempotency key is usable
independently in two trees」+ migration 0005 就地升级用例（v4 库升级到 v6
后同键入第二棵树成功、树内仍唯一）；读模型暴露 = `TreeState` turn 投影。

### 2.4 提交顺序：保存先于导航（写入顺序即契约，已签署 v3.0 §3.5）

**Return 持久化不依赖 Pi 导航。** 提交顺序固定为：

1. **校验**（只读）：树 / 来源分支 / 主干（Trunk）存在、`idempotencyKey`
   非空非空白、文本非空；
2. **幂等重放检查**（只读）：树内同键已存在 → 同内容走重放（§2.3），
   异内容 409，**均不导航**；
3. **单事务落库**（episode + return turn，唯一索引判负整体回滚、无悬挂
   episode）——**这一步成功即"已保存"**；
4. **再导航回主干**：尽力而为，结果**分离呈现**，任何失败都不回滚、不
   丢失已保存的 Return。

导航结果（`navigation` 字段）三态：

- `navigated`——已切回主干（游标在 Trunk）；
- `no-session`——主干尚无 session（new-session 续聊点）：不导航、不新建
  session，Return 已照常保存，待首次主干 prompt 建会话并组装；
- `failed`（`code` + `message`，映射 TreeAI 运行期错误码，如
  `session-corrupt`）——导航尝试失败（session 缺失/损坏、运行期错误）；
  Return **已保存**，响应与状态面如实分别呈现「已保存」与「返回主线失败」。

导航失败下的重试语义：以**同一键**再次提交 → 走 §2.3 重放路径（无重复
写入），并把重试当作**再次尝试导航的载体**；导航成功后游标落主干。写库
失败（冲突/校验）仍以 409/400/404 拒绝且零写入——与导航失败（201/200 +
`navigation.failed`）是两类不同的失败。

实现对照：`submitReturn()`（`service.ts` L1415–1495）= 校验与主干查找先
于重放检查（重放路径也能再导航）→ 单事务落库 → `#navigateBackToTrunk()`
（L1496–1506，经 `switchBranch`；游标为 null → `no-session`；运行期错误
捕获 → `failed`）；new-session 分支 = `switchBranch()` 对 `new-session`
显式不导航不建会话（L1334 起）；空主干无 session 仍保存 = service 测试
「an empty trunk without a session still saves the return」（§6-7）。

### 2.5 响应丢失、冲突、重试与收尾（已签署 v3.0 §3.6）

提交响应丢失（超时 / 断连 / 客户端崩溃后重启）时，客户端：

1. 先 **refetch 树状态**对账——同提交身份（`idempotencyKey`）、同来源
   分支、同文本**全同**才按成功处理；**不重复提交**；
2. 对账确认成功 → 清理草稿、呈现已保存结果；未知结果或真实失败 →
   **保留草稿、面板与重试入口**（同键可重试）；
3. 冲突（同键异容）→ **显式冲突提示**，保留文本，引导确认新的提交——
   不吞错、不自动丢弃；
4. 成功保存后的回程失败**不重新进入"尚未保存"状态**（§2.4）。

**收尾以保存结果与导航结果分别控制**（已签署 v3.0 §3.6）：清理草稿 /
关闭面板 / 焦点回主线各自取决于**已确认的保存结果**与**导航结果**——保存
成功即清草稿收面板（留着面板会诱导重复提交）；导航失败则跳过客户端再
导航（`skipSwitch`），主线横幅如实呈现「已保存，返回主线失败」+ 重新导航
指引；焦点回主线不受导航失败影响。

实现对照：`app.js` `submitReturn()`（L1834–1907）——成功路径（200 重放与
201 新建同为成功，L1849–1853）；失败先对账（L1854–1877：`GET /state`，
「幂等键 + 来源分支 + 文本」全同命中（`findReturnByKey` L1765 +
`returnMatchesDraft` L1783）→ 清草稿按成功处理；同键异容 → 显式冲突
（`returnConflictError` L1805：保留草稿与面板，「编辑换新键」引导）；
未命中 → 保留草稿与键供同键重试）；收尾分别控制（L1879–1900：
`navigation.failed` → `closePanel({focus:"main-input", skipSwitch:true})`
（L1522–1535，跳过 POST /switch）+ 横幅「Return saved — returning to the
Trunk failed」；其余 → 常规收尾，客户端游标对齐失败同样如实横幅）；面板
打开先对账（`syncReturnDraftForBranch` L908——已落库的持久草稿直接丢弃，
呈现已保存/已采用卡）+ 草稿跨刷新持久化（§2.1）。DOM 级回归见
`apps/studio/tests/ui-regressions.test.ts` 与 `apps/studio/tests/
ui-probe.test.ts`（导航失败收尾用例）。

### 2.6 采用尝试、首次成功采用与反查（已签署 v3.0 §3.2）

- 已保存（`deliveredRunId === null`）的 Return 由**每一次主干 prompt**
  组装进确定输入（前缀拼接，可确定性重放）。每个把它实际组装进输入的
  主干 Run 都记录一条**采用尝试**关联（`return_adoption_attempts`，
  (return_turn_id, run_id) 复合主键，migration 0006）——**含失败/中止的
  Run**；
- **首次成功采用**：`deliveredRunId` 仅由**首次成功收敛**的主干 Run 在同一
  DB 事务内设置，恰一次；此后该 Return 不再进入组装、也不再新增尝试；
- 失败/中止的尝试**不消耗** Return：不置 `deliveredRunId`，下一次主干
  prompt 重新注入，再次尝试（保留此前尝试记录）；
- **反查（尝试面 + 成功面）**：`deliveredRunId` 交叉引用 run 诊断面
  （`GET /api/trees/:treeId/diagnostics` 的 run 行）；尝试面经树状态读
  模型的 `returnAttempts` 安全投影（`ReturnAttemptView`：turnId / runId /
  runState / failure code+message / attemptedAt / terminalAt——不含 session
  路径等敏感面），UI 的 Return 卡与来源抽屉分别呈现「已采用（首次成功
  run）」与「尝试过 N 次（含各 run 结果）」。

实现对照：组装 = `composePromptText()`（L546，前缀 `[Return from branch …]`
块）+ `prompt()` 待采用筛选 `deliveredRunId === null`（L1052–1054）；尝试
落库 = createRun 后、运行前的同事务 `recordReturnAdoptionAttempt`（L1064–
1068，对全部待采用 Return 各记一条）；首次成功采用 = 成功收敛事务内
`markReturnDelivered`（L1153–1155，条件 UPDATE）；失败/中止路径不触碰
交付、不新增收尾（catch 分支）；读模型投影 = `#returnAttemptViews()`
（L842–856）→ `BranchView.returnAttempts`；UI = `app.js` `returnCard()`
（L524，卡面「已保存·待采用 / adoption attempted (N) / 首次成功采用」）+
`returnAttemptsFor()`（L520）+ 来源抽屉 Returns 节逐条尝试（L2073 附近）；
持久层测试「return adoption attempts record per-run associations and
survive reopen」+ service/api/ui 用例（失败 run 留尝试、成功后无新尝试）。

### 2.7 HTTP 映射（Studio HTTP 面）

`POST /api/trees/:treeId/return`，请求体 `{ fromBranchId, text,
idempotencyKey }`：

| 响应 | 含义 |
| --- | --- |
| `201` | 首次创建（created）——Return 已保存 |
| `200` | 树内同键同内容重放，返回既有 Return（也是导航重试的载体，§2.4） |
| `409 return-conflict` | 同树同键不同内容，零写入 |
| `400` / `404` | 参数或实体错误（缺键/空白键 → 400，字段名进消息；未知树/分支 → 404） |

**导航失败不是 HTTP 错误**（§2.4）：201/200 的响应体为
`{returnTurn, navigation, state}`——`navigation` 三态 `navigated` /
`no-session` / `failed`（`failed` 携带 `code` + `message`，映射 TreeAI
运行期错误码如 `session-corrupt`）。校验/冲突类失败（409/400/404）零写入
且**不尝试导航**。

实现对照：`server.ts` `/return` 处理（L357–376，`submission.created ?
201 : 200`，响应含 `navigation` 字段）+ `sendError()` 映射（L93 起：
`ReturnConflictError` → 409 `return-conflict`；`InvalidArgumentError`/
`ConstraintViolationError` → 400；`EntityNotFoundError` → 404）。API 用例：
「return with a missing Pi session file: saved first (201), navigation
failed in the response; same-key retries replay without duplicates」。

## 3. 失败幂等契约

> **状态：已实现（符合性标准 = 已签署 v3.0）。** 语义核心 = `service.ts` `prompt()` / `abort()` /
> `recoverInterruptedRuns()` / `#probeSessionAvailability()`；证据：service /
> api / events 套件 + `tests/integration/scenarios.test.ts`（D2 层收敛语义，
> 见 §4 R9–R13）。§3.2 含一处对旧稿的**勘误**（§6-1）。

### 3.1 单在途 prompt

每个服务实例同一时刻**至多一个在途 prompt 操作**（含会话对准阶段）。
第二个并发 prompt 以操作冲突拒绝（HTTP `409`），且**不产生任何**
episode / run / turn 部分写入。

实现对照：`#promptInFlight` 同步前缀置位（`prompt()` L1041–1044，第二个
prompt 确定性 `TypeError`）；`server.ts` TypeError → 409（L112 起）。

### 3.2 中止（abort）

- `abort` 仅接受**该树当前在途的 run**；已终态 / 无在途 / 另有在途的
  run → `409` 操作冲突（`RunNotActiveError`）；跨树 run 与空 runId →
  `400`（参数错误，`InvalidArgumentError`）；未知树 / run → `404`；
- 用户中止把 run 以单事务收敛为 **`aborted`**，**绝不改写为 `failed`**；
- prompt 已先一步 settle 时，`abort` 不产生效果、不改写结果（不撒谎）。

> **勘误（2026-09-29，§6-1）**：旧稿称其余目标"一律 `409` 操作冲突"——
> 与代码不符。实际映射（`server.ts` `sendError()` 与 abort 路由注释
> L382 附近）：非活动 run → 409；跨树 run / 空 id → 400；未知树 / run →
> 404。本文按代码改正；如负责人裁定跨树亦应归 409，属契约变更（需改
> `server.ts` 映射与 api 测试）。

实现对照：校验链 = `abort()`（L1187 起：树/run/episode/branch 逐级校验
+ 活动性检查）；收敛 = `prompt()` 的 user-abort 分支单事务
running → aborting → aborted（L1102–1105，含会话叶回位到续聊点）；已
settle 的 abort = 活动性检查拒绝，无副作用。

### 3.3 宿主重启收敛

- 重启时宿主把所有**非终态 run** 收敛为 `failed`（host-interrupted 语义，
  带宿主中断标记）；重复调用安全（无则空转）；
- **DB 是事实源**：进程内簿记（cursor / 在途 run）重启即失效，一切以
  TreeAI DB 为准重建。注入 journal 时，journal 侧同步执行 host-crash
  恢复（`journalRecovery`，构造时执行，失败不挂进程）。

实现对照：`recoverInterruptedRuns()` 构造时调用（L604 起 / 定义 L611，
`failNonTerminalRuns` 带 `details.hostInterrupted: true`——该 detail 只入
DB，诊断面不外泄）；journal 恢复 = 构造函数（L594 起）。

### 3.4 缺失 Pi session

- **产品事实全部可读**：Tree / Branch / Turn（含锚点摘录）不依赖 Pi
  session 文件——TreeAI DB 拥有产品事实（ADR-001 §4）；
- 受影响分支在状态读模型中**如实呈现 session 不可用**（锚点
  `unavailable`、续聊不可用），不隐藏、不降格为普通错误；
- **续聊 fail closed**：续聊如实失败（`502 session-corrupt`），**绝不静默
  重建 session**——重建即分叉历史，破坏 Pi 会话树与 DB 事实的一致性；
- **恢复提示必须可执行**：引导用户**从既有 turn 创建新分支**继续工作。
  该恢复不修复、也不伪装受影响分支的历史连续性，只给出继续工作的路径；
- **「以保存内容开始新的探索」（signed v3 §4.4，issue #7 P0-2 已实现）**：
  session 不可用的分支提供**用户显式确认的换轨入口**
  （`promptNewExploration`）：仅在分支续聊点 session 当前不可用时成立
  （可用 → `409 new-exploration-conflict`，应走普通续聊；无历史 session →
  同样拒绝）。确认后创建**全新 session**——锚点摘录与该分支已保存历史
  作为首问上下文显式带入，并声明旧运行上下文**未恢复**（不冒充旧会话
  恢复：用户 turn 携带 `[new exploration from saved content …]` 标记，
  数据库层面可审计）；首问成功后分支续聊点 = 新 session，**旧历史保持
  可读**（append-only），来源关系（origin）不动。UI 入口：composer 的
  「⑃ Start new exploration」（输入框保持可输入以键入首问；confirm 二次
  确认如实告知换轨后果）；普通续聊路径的 fail-closed 纪律不变。

实现对照：可读性 = 读模型只查 DB；如实呈现 = `sessionAvailability` 实时
存在性探针修正 DB 缓存（`#probeSessionAvailability`：missing-file
且文件已恢复 → available；version-mismatch/corrupt → 维持 unavailable；
只探存在、绝不读内容）；fail-closed = 续聊走 `#ensureSessionAt` →
restoreSession 失败即抛（无重建路径）；可执行恢复 = `app.js`
"⑃ Branch from latest available answer"（横幅与面板降级提示共用，无候选
时禁用并说明原因——恢复是绕行不是解锁，fail-closed 入口保持禁用）+
**「⑃ Start new exploration」**（主线/面板 composer，v3 §4.4）；
换轨语义 = `service.ts` `promptNewExploration()`（前置校验 +
`#newExplorationContext()` 上下文块 + `#ensureSessionAt` new-session +
用户 turn 标记）；HTTP = `server.ts`
`POST /api/trees/:treeId/branches/:branchId/new-exploration`（200
`{outcome, state}` / 409 `new-exploration-conflict` / 400 空文本）。

### 3.5 模型错误

prompt 失败（上游 / 模型错误）把 run 收敛为 `failed` 并记录
`failure { code, message }`；不产生 assistant turn；已保存的 Return 保持
待采用（不置 `deliveredRunId`，采用尝试记录保留，§2.6）。诊断面只外泄
code / message，不外泄 details、原始 cause、session 引用与路径。

实现对照：失败收敛 = `prompt()` 非 user-abort 分支（L1118，
`updateRunState(run.id, "failed", { failure })`，无 turn 写入）；安全投影
键集合由测试精确锁定（`getTreeDiagnostics` L1216 起）。

## 4. 测试义务表

测试类别：**响应丢失 / 双击 / 并发 / 缺失 session / 重启收敛 / 中止 /
模型错误**（前四类为 issue #2 P0 明确要求；后三类来自本契约与 A4–A5）。
自动化 = 离线测试套件（`apps/studio/tests/`，产物归 `evidence/d3/offline/`；
套件在 issue #5 波次持续扩充，计数不作引用口径，`ui-probe` /
`ui-regressions` 一律文件级引用）；人工 = 目标 Mac / 真实 Pi 操作（记录归
`evidence/d3/real-pi/`，用 `evidence/d3/templates/run-record.md`）。下表
自动化列为**实际存在的用例**（不再以"随同一 push 落地"占位）；证据缺口
如实标注。

| # | 契约规则 | 测试类别 | 断言要点 | 自动化（离线） | 人工（目标 Mac / 真实 Pi） |
| --- | --- | --- | --- | --- | --- |
| R1 | 选区以绝对偏移定位（§1.1） | 双击（重复词 / 跨行 / 长答案） | 重复词第二处、跨行、长答案选区揭示高亮命中原位置，不依赖字符串搜索 | service.test.ts「anchor status preserves duplicate and cross-line selections; session unavailability stays a separate dimension (v3 §1.2)」（重复词第二处 + 跨行偏移不变量 + 维度分离）、「branch anchoring is validated (answer role, slice integrity, bounds)」；长答案 UI 级已补：ui-probe §18（数千字符多段答案后段选区——精确偏移、揭示切片恰切两侧、非整条回退）+ 浏览器面 `selection-deep-long`（真实 Chromium 拖选、真实模型 13997 字符答案后段 13971–13996，见 W2 §4 长答案行） | 目标 Mac 完整操作一遍（A2，含数千字符长答案） |
| R2 | 锚点三态判定与降级（§1.2–§1.3，issue #7 P0-1：与 session 分离） | 缺失 session | 判定规则逐条命中（**只读产品事实**）；降级时摘录可读、揭示拒绝且如实报告、不伪造；session 不可用**不降格来源状态**；揭示的游标对齐作为独立 navigation 结果分离返回；续聊不被锚点降级阻断（signed v3 §1.2） | service.test.ts 同上用例（session 降级 → originStatus 仍 available、sessionAvailability 独立呈现）+「source reveal is decoupled from session availability (v3 §1.2, issue #7 P0-1)」（删除 session 文件后揭示照常定位 + navigation failed 分离 + 恢复后 navigated）；api.test.ts 主流程（`/source` available）；`changed` 判定与降级直接用例——service.test.ts「changed anchor (DB-constructed): …（W1 §6-3）」直改 DB 构造切片失配（originStatus 如实 changed + 同 turn 对照 available、摘录可读、揭示拒绝无回退、无静默修复；changed 不阻断续聊的边界一并如实锁定，§6-3） | 真实 session 缺失抽查 |
| R3 | draft 不生效（§2.1） | 双击 | 草稿不落库、不进 Pi 上下文、不渲染为产品 turn | `apps/studio/tests/ui-probe.test.ts`（文件级：草稿持久化与防双击场景——草稿仅存 localStorage 并携带幂等键，Return 卡仅在提交后出现于树状态）；"不进 DB / Pi 上下文"按构造成立（draft 只存在于客户端输入框与 localStorage，无落库通道） | UI 可见性确认（刷新后草稿恢复、未提交不渲染） |
| R4 | 首次成功采用恰一次 + 尝试面如实（§2.6） | 双击 / 模型错误 | 首次成功收敛的主干 Run 置 `deliveredRunId` 恰一次；失败/中止 run 不置、留下采用尝试记录、下次重新注入；成功后不再新增尝试 | service.test.ts「full D3 vertical slice…」（`deliveredReturns === 1`；重启后再 prompt `deliveredReturns === 0`——不重复注入）+「composePromptText prefixes pending returns deterministically」+「failed prompt never delivers the pending return; the next successful trunk prompt delivers it exactly once (W1 §6-4)」（已扩展：失败 run 留 `returnAttempts` 记录、成功后尝试面含失败+成功两条、再后无新尝试） | 真实 Pi 成功采用一次验证 |
| R5 | 同键同内容 → 同一 Return（§2.3） | 双击 | 双击提交第二次 `200` 重放；DB 仅一条已保存 Return | api.test.ts「return idempotency over HTTP: 201 create, 200 replay, 409 conflict, 400 missing key」；service.test.ts「return idempotency: same key+content replays the same turn; different content conflicts」+「return idempotency is scoped per tree: the same key lands independently in two trees (signed v3 §3.4)」；`apps/studio/tests/ui-probe.test.ts`（文件级：DOM 级防双击恰一次 POST） | UI 双击提交按钮（实机口径） |
| R6 | 同键不同内容 → 409（§2.3） | 双击 | `409 return-conflict`，零写入 | 同上两用例（冲突持久化零写入断言）；并发同键异容：service.test.ts「concurrent same-key submits converge to one return (race-safe, no dangling episode)」 | — |
| R7 | 响应丢失先对账再重提（§2.5） | 响应丢失 | 响应丢失 → refetch 按键命中 → 不重复提交；未命中 → 同键重提安全 | `apps/studio/tests/ui-probe.test.ts` + `apps/studio/tests/ui-regressions.test.ts`（均文件级：响应丢失对账——命中条件为键+来源分支+文本全同、失败保留草稿、改写换键场景）；api.test.ts「response-loss resubmit and double-click converge to exactly one return」 | 断网 / 杀进程后恢复复现 |
| R8 | 保存先于导航、失败分离呈现（§2.4，signed v3 §3.5） | 响应丢失 / 缺失 session | session 缺失 → Return **先保存**（201）+ `navigation.failed` 分离呈现、游标不动；同键重试重放（200）无重复；恢复后重试经重放路径导航成功 | api.test.ts「return with a missing Pi session file: saved first (201), navigation failed in the response; same-key retries replay without duplicates (signed v3 §3.5)」（含 DB 游标不动断言）；service.test.ts「missing session: submit saves the return first, navigation fails separately; same-key retries replay without duplicates (signed v3 §3.5)」；空主干无 session 仍保存 = 「empty-trunk return…（W1 §6-7）」；UI 收尾分离 = ui-probe/ui-regressions 导航失败用例 | — |
| R9 | 单在途 prompt（§3.1） | 并发 | 第二并发 prompt `409`，零 episode/run/turn 写入 | service.test.ts「concurrent prompt is rejected as a conflict and leaves no phantom run」；api.test.ts「diagnostics and abort endpoints…」（并发 409 + 无幽灵 run） | — |
| R10 | 中止语义（§3.2） | 中止 | 非活动 run → `409`；user-abort → `aborted` 不改写 `failed`；已 settle 的 abort 无效果 | service.test.ts「abort: only the active run of the tree is abortable; user-abort converges to aborted, not failed」（含 404/400/409 映射与中止后上下文隔离）；api.test.ts 同名面（「diagnostics and abort endpoints…」）；events.test.ts「abort over SSE: abort-requested precedes run-terminal aborted; journal projection agrees」；D2 层支撑：tests/integration/scenarios.test.ts「e2e error-convergence…」 | 真实 Pi 中途点停止 |
| R11 | 重启收敛（§3.3） | 重启收敛 | 非终态 run 重启后 `failed`（host-interrupted）；DB 事实源；重启后流程可继续 | service.test.ts「startup recovery converges interrupted runs to failed (I6 host-interrupt semantics)」+「full D3 vertical slice…」（重启恢复 + 分支/主干续聊）；api.test.ts「HTTP API serves the UI and the full D3 flow, surviving a restart」；events.test.ts「process restart: journal and diagnostics converge consistently (host-crash semantics)」 | kill 宿主后重启复现 |
| R12 | 缺失 session fail-closed + 可执行恢复 + 显式新探索（§3.4，v3 §4.4） | 缺失 session | 树/分支/turn 可读；续聊 `502` 不静默重建；恢复提示（从既有 turn 开新分支）可执行；**显式新探索**：用户确认换轨（新 session + 保存内容上下文 + 旧上下文未恢复声明）、首问成功、旧历史不变、session 可用时 409 拒绝换轨 | events.test.ts「session deletion: readable tree, unavailable branch, fail-closed prompt with no partial writes, recovery path」+「session availability derivation: live probe refines the cached assessment honestly」；service.test.ts「whole-tree session loss: explicit new exploration creates a new session, carries the saved content into the first prompt, and leaves the old history readable (v3 §4.4, issue #7 P0-2)」+「new exploration preconditions (v3 §4.4)…」（健康分支/无历史 session 409、锚点 session 丢失的支线从摘录起步）；api.test.ts「new exploration over HTTP (v3 §4.4)…」（200/409/400/404/405 全映射）；`apps/studio/tests/ui-probe.test.ts`（文件级：恢复动作精确载荷、横幅禁用与原因、新探索确认流 + 精确载荷 + 收尾） | 文件级移除 session，按 UI 提示恢复 + 实机走一遍新探索确认流 |
| R13 | 模型错误收敛（§3.5） | 模型错误 | run `failed` + failure 记录；无 assistant turn；已保存 Return 不被标记首次成功采用 | events.test.ts「model error injection: run converges failed across HTTP, diagnostics, journal and SSE」（`/fail` 注入：failed + code/message + 零 turn + journal/诊断面一致）；安全投影：service.test.ts「diagnostics read model: safe projection only (no session refs, details, causes, paths)」；「已保存 Return 不被标记」直接用例已补（service.test.ts「failed prompt never delivers the pending return…（W1 §6-4）」：失败后 Return 仍待采用、下次成功 prompt 首次成功采用恰一次、再后不重发） | 真实 Pi 侧错误配置一次 |

## 5. 明确非目标

- **本文档不是签署文本。** 符合性标准是仓外已签署 v3.0（2026-09-30，
  issue #7 裁定不重复签署）；本文档是其仓内实现对照镜像（§7 汇总研发
  未符合条目）。
- Gate 0–2 与 A1–A7 的 Go / No-Go 均为负责人决策；仓库文档只记录状态，
  绝不声称签署或通过（见 `docs/d3/D3-status.md`）。
- W1 契约符合 ≠ D3 Go：issue #2/#7 的 Go 条件另要求 `evidence/d3/` 下的
  真实 Pi 操作证据、故障/幂等测试、设计对照、术语三部分与 3–5 人试用
  记录，绑定最终候选 commit SHA 并经负责人验收。
- 未写入本文档的行为不因本文档而冻结；契约的后续修改需负责人批准并
  追加变更记录（沿用 `coordination/d2/` 的 CONTRACT-CHANGE 纪律）。本文
  2026-09-29 的逐条核实（§6）是**对齐实现的事实陈述**，不是契约变更；
  2026-09-30 的改稿按已签署仓外契约 v3.0 对齐正文与实现（头部注记），
  其中标注"待 owner 裁决"的偏差（§6-1/5）与开放项（§6-8/10/11）在负责
  人裁定前不改变现状。

## 6. 勘误与实现对照（2026-09-29 核实；2026-09-30 按签署版 v3.0 与 issue #7 复核）

本节汇总 2026-09-29 对照代码核实本契约时发现的**草稿与代码不一致处与
证据缺口**（正文已按代码改正或加注；`app.js` 相关行号已随 `8fd8684`
更新）。第 1–7 条为勘误与对照；第 8–11 条原为**待负责人决定的开放项**
——**2026-09-30 起符合性标准为仓外已签署 v3.0**（issue #7 裁定不重复
签署）：§6-2/6-3/6-9 已按签署版裁定并落地；§6-5/6-8 已按 issue #7 P1
整改落地（降级 Return 卡）；§6-1/6-10/6-11 保持如实标注（v3 未覆盖的
细节，以实现现状为准、留待后续契约修订）。

1. **§3.2 abort 错误码（已改正）**：旧稿称非活动目标"一律 409"。实际
   映射：已终态 / 无在途 / 另有在途 → `409`（`RunNotActiveError`）；跨树
   run 与空 runId → `400`（`InvalidArgumentError`）；未知树 / run →
   `404`。若负责人裁定跨树亦应归 409，属契约变更（需改 `server.ts`
   `sendError()` 与 api 测试）。
2. **§2.3 唯一约束的范围（已按签署版 v3.0 §3.4 裁定并落地）**：签署前
   `idx_turns_idempotency_key` 是 `turns(idempotency_key)` 上的**全局**
   （跨树）部分唯一索引，与本条所述"按 Tree 唯一"冲突。已签署 v3.0
   §3.4 明确采用按 Tree 唯一——migration 0005 就地升级（DROP 全局索引，
   建 `idx_turns_idempotency_key_tree ON turns(tree_id, idempotency_key)
   WHERE idempotency_key IS NOT NULL`），同键可跨树独立使用、树内仍唯一；
   测试：repository「the same idempotency key is usable independently in
   two trees」+ v4→v6 就地升级用例 + service「return idempotency is
   scoped per tree…」。§2.3 正文已同步改写。
3. **§1.2 `changed` 判定直接用例已补（直改 DB 构造，测试与本文档同一
   提交）**：产品当前没有改写 turn 文本的路径，正常产品流无法构造
   `changed` 态——按本条预期的补测路线伪造不变量破坏：service.test.ts
   「changed anchor (DB-constructed): originStatus reports changed, the
   excerpt stays readable, reveal refuses without fallback, nothing is
   silently repaired (W1 §6-3)」以直接 `UPDATE turns` 同长度前缀改写锚点
   答案（一处选区切片失配、同 turn 上另一选区仍匹配作对照）后整实例
   重启，断言真实 `#anchorStatus()` 如实报 `changed`（对照仍 available）、
   摘录快照可读、揭示拒绝且返回落库快照原文（无 whole-answer / 首次
   出现回退、零导航副作用）、DB 事实与选区快照不被静默修复。**边界
   （如实）**：`changed` 锚点不阻断分支续聊——服务层续聊只由「续聊点
   可解析 + session 可用性」门控。**已按签署版 v3.0 §1.2 裁定**：签署版
   明确「源/会话损害按维度区分，changed 锚点不阻断仍有效的续聊，也绝不
   静默重锚」——与实现一致，§1.3 正文已按签署版改写，该边界从"待 owner
   裁决"转为签署语义，测试继续如实锁定。
4. **§2.6/§3.5 "失败的 prompt 不标记送达"直接用例已补（`b0be424`）**：
   交付只发生在成功收敛的同一事务内（`service.ts` `prompt()`）；本条原为
   证据缺口加注，已由 service.test.ts「failed prompt never delivers the
   pending return; the next successful trunk prompt delivers it exactly once
   (W1 §6-4)」关闭——失败注入在 runtime 层（echo `/fail` 前缀钩子在待
   注入 Return 的组合文本下不可用），断言 run failed + Return 仍待采用
   （留采用尝试记录）+ 下次成功 prompt 首次成功采用恰一次 + 再后不重发。
   签署版 v3.0 §3.2 把"失败不消耗 Return"升格为签署语义（§2.6 已同步）。
5. **§2.2 降级 Return 卡的摘录（已按 issue #7 P1 整改落地）**：旧实现
   锚点不在当前视图时卡面降级为 "original anchor unavailable"、摘录仅在
   来源抽屉可读。issue #7 P1 要求卡面携带 targetAnchor 快照并区分来源
   去向——已实现：`returnCard()` 回退放置区分「来源位于其他 Branch /
   已变化 / 缺失」（`returnFallbackReason()`），摘录 + 来源路径在卡面
   （长摘录 `<details>` 折叠），确认时间取产品 createdAt，首次成功采用
   时间从采用尝试记录反查（ui-probe 场景锁定）。
6. **实现基线表述过时（已改正）**：旧稿"实现本契约的代码变更与本文档
   同一 push 提交"不再成立——实现分布在 `8671136`（幂等/targetAnchor）、
   `6ff7146`（事件/journal/降级）、`d061b5f`（UI 改版）及 issue #3/#4 波
   次；本稿以 `56f8c31` 勘定，`app.js` 相关行号与语义随 `8fd8684` 波次
   更新。
7. **§2.4 new-session 直落库分支直接用例已补（测试与本文档同一提交）**：
   主干尚无 session 时 Return 不导航直接落库——`switchBranch()` 对
   new-session 显式返回（`switchBranch()` L1334 起）。service.test.ts「empty-trunk
   return: submit persists directly without a session; the first trunk
   prompt creates the session and delivers it exactly once (W1 §6-7)」
   以仓储层铺设锚点构造空主干形状（「主干零 episode/run + 已存在锚定
   分支」在产品流不可达——任何树的首个 prompt 必然落在主干）后提交
   Return，断言直接落库（已保存 + targetAnchor 快照完整 + navigation
   "no-session"）、零 session 创建 / 零新 run，首次主干 prompt 才建
   session 并首次成功采用恰一次（deliveredRunId 绑定该 run；再后不重注入）。
8. **Return 卡的回退放置规则（已按 issue #7 P1 整改落地）**：锚点回合不在
   当前渲染分支（历史 Return、嵌套支线的 Return）时，卡按时间序原位渲染，
   **携带 targetAnchor 快照**并区分来源去向（其他 Branch / 已变化 / 缺失），
   摘录 + 来源路径在卡面（长摘录折叠）——实现为 `app.js` `renderTurnsInto()`
   回退路径 + `returnCard()`/`returnFallbackReason()`（ui-probe 场景锁定）。
   §6-5 的摘录呈现问题随之一并关闭。
9. **提交失败后的客户端状态（已按签署版 v3.0 §3.6 裁定为产品义务）**：
   签署版 §3.6 把收尾规则写入契约：未知结果先对账（键+来源+文本全同才按
   成功处理）；确认成功清草稿、未知/失败保留草稿面板与重试入口；冲突显
   式呈现保留文本；保存成功后的回程失败不重新进入"尚未保存"状态；清理
   草稿/关闭面板/焦点回主线以保存结果与导航结果分别控制。实现
   （`app.js` `submitReturn` L1834–1907，含 `navigation.failed` →
   `skipSwitch` 收尾）与测试（ui-probe/ui-regressions 导航失败用例）已
   对齐，§2.5 正文已写入。
10. **无 `idempotencyKey` 的遗留 Return（开放项）**：repository 层允许
    无键 Return 往返（service.test.ts:763「repository-level return
    without a key still round-trips (legacy shape)」）；§2.3 约定客户端
    恒带 UUID（唯一索引仅约束非空值）。无键 Return 是否属于冻结契约待
    裁定。
11. **与仓外联合讨论稿的等价性（按 issue #7 收束）**：本契约文本源自仓外
    联合讨论稿的仓内整理。仓外《TreeAI W1 产品与研发联合契约 v3.0》已于
    2026-09-30 **签署生效**；issue #7（2026-09-30 验收）裁定：**以签署版
    为符合性标准，仓内旧 DRAFT/待裁决文字不覆盖它，不再要求对照签署或
    重复签署**。本稿正文按签署版与 issue #7 整改项对齐（保存先于导航
    §2.4 / 幂等键按 Tree 唯一 §2.3 / 采用尝试与首次成功采用分离 §2.1、
    §2.6 / changed 锚点不阻断仍有效的续聊 §1.3 / 收尾分别控制 §2.5 /
    来源定位与游标对齐分离 §1.2–1.3 / 显式新探索 §3.4 / 降级 Return 卡
    §2.2、§6-5、§6-8）；仓内与签署版的差异以签署版为准。

## 7. 研发未符合条目（issue #7 口径，滚动更新）

符合性标准 = 已签署 v3.0。截至 2026-09-30（issue #7 P0/P1 整改 +
术语 ①② 核心波次后）：

- **术语三部分（issue #7 C 表）**：
  - **① 标注/提取**：**核心已交付**（隔离轻量无工具辅助执行器——独立
    runtime/sessionDir/provider/model + 非推理 thinkingLevel；UTF-16
    绝对偏移 + 切片全等 + sourceHash；去重/密度 ≤8/代码 URL 排除；
    三模式/缓存偏好/任务状态/预算 usage（chars/4 诚实估算口径）/
    取消迟到丢弃；冻结质量集 60 条 + 两轮真实模型试标记录（`evidence/d3/terminology/`）：
    紧化提示词后（`433f448`）全部机械门禁带裕度通过——解释 30/30、
    覆盖 69/75=92.0%（≥80% 门禁过）、负例误标 0/84=0.0%（≤10% 门禁
    过，连续三跑 0%）；**有用率 ≥90% 待人工标注**（跑批器输出标注
    工作表，如实 NOT_RUN）。**未开自动标注保存**（质量门禁未全过——auto 结果仅
    任务面呈现）。
  - **② 另一个建枝入口**：**已交付**（点词/划线解释 → 显式保存批注或
    幂等推广；复用 Anchor/Branch/Origin/Run/prompt；解释/提取零树
    写入/零主会话副作用；推广幂等键 + 首问派发/失败重试/同键重放；
    同词不同语境各自批注推广）。
  - **③ 配套前端**：**最小面已交付**（选区武装解释入口、解释卡全状态、
    保存/推广动作、抽屉 Terminology 节与用量）；**完整 ③ 未交付**——
    正文/操作分层、统一标注/来源区间、选择期间不重绘、模式/工具条/
    已有探索呈现的完整状态、响应式/键盘/触屏/reduced-motion 全矩阵
    （issue #7 下一步 2 的第 5 阶段）。
- **最终候选版本回归**：新版负面路径（P0-1/P0-2/P1/术语的行为变化）与旧
  30 项一起的真实浏览器/真实 Pi 跑批待最终候选 SHA 统一执行（issue #7
  下一步 3——本轮已落地浏览器/echo 面自测与离线全绿；术语首轮真实试标
  已在工作树跑通，绑定干净 SHA 的证据记录见 D3-status 该波次行）。

## 签署

> **符合性标准在仓外**：仓外《TreeAI W1 产品与研发联合契约 v3.0》已于
> 2026-09-30 签署生效（issue #7 裁定：已完成、不重复要求签署）。本仓内
> 镜像不携带签署请求——上表仅作历史记录保留；语义冻结以签署版为准，
> 仓内文档与实现的符合性由绑定 SHA 的证据（`evidence/d3/`）与负责人
> 验收（issues）裁定。
