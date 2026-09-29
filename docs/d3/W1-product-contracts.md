# W1 产品契约（草案，待负责人签署）

> **状态：DRAFT — 待签署。** 本文档是仓库内起草的 W1 契约文本，回应 GitHub
> issue #2《D3 验收：Gate 2 No Go 与修订方案》（2026-09-29）的 Gate 0 缺口
> 之一：「W1 Anchor/Return/失败幂等契约未冻结」。签署权在负责人；在负责人
> 签署之前，本文档不冻结任何契约、不构成 Gate 0 通过——Gate 0–2 与 A1–A7
> 的验收均为负责人决策（见 `docs/d3/D3-status.md`，该文件只记录状态）。
>
> **实现基线（2026-09-29 勘定，issue #5）**：本文本已对照 commit `56f8c31`
> 的实际实现与测试逐条核实——载体为 `packages/contracts/src/product.ts`、
> `apps/studio/src/service.ts`、`apps/studio/src/server.ts`、
> `apps/studio/public/app.js`，证据为 `apps/studio/tests/` 全部套件
> （实测 53/53 通过）与 `tests/integration/scenarios.test.ts`（D2 层支撑）。
> 各节标注 **已实现待冻结**：语义已实现并有自动化证据，但**未经负责人
> 签署，不构成冻结**。核实中发现的草稿与代码不一致处已在正文改正并汇
> 总于 §6（勘误与实现对照）。文档与代码的一致性以绑定 commit SHA 的证据
> （`evidence/d3/`）为准，不以本文档自述为准。

| 项目 | 内容 |
| --- | --- |
| 文档状态 | DRAFT 待签署（签署区块见文末，**留空——待负责人签署**） |
| 依据 | issue #2（2026-09-29）P0 与 A2–A5 缺口；2026-09-29 逐条核实对照（issue #5） |
| 契约载体 | `packages/contracts/src/product.ts`（TurnSelection / Turn / BranchOrigin / ReturnTargetAnchor 共享形状）、`apps/studio/src/service.ts`（产品语义）、`apps/studio/src/server.ts`（HTTP 映射）、`apps/studio/public/app.js`（客户端 draft/幂等键语义） |
| 证据口径 | 自动化离线 → `evidence/d3/offline/`；真实 Pi 与目标 Mac → `evidence/d3/real-pi/` |

## 1. 锚点（Anchor）契约

> **状态：已实现待冻结。** 判定与降级语义见 `service.ts` `#anchorStatus()`
> （L707–725）、`revealBranchOrigin()`（L1166–1203）与 `persistence` 的
> `setBranchOrigin()` 校验；证据：service 套件（见 §4 R1/R2）。`changed`
> 判定分支无直接用例（§6-3）。

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

实现对照：形状与不变量 = `product.ts` `TurnSelection`（L71–78）；写入时
校验（角色 / `anchorEntryId` 一致 / 偏移界内 / 切片一致）=
`persistence` `setBranchOrigin()`（`tree-repository.ts` L1070 起）；UI 选区
以 Range 前缀长度求绝对偏移、不搜索 = `app.js` `selectionOffsetsWithin()`
（L422–435）；高亮按偏移切片 = `renderTurnsInto()`（L565–586）。

### 1.2 锚点完整性三态

每个锚定分支的 origin 在读取时判定为三态之一。判定规则（每条独立成立
即归类）：

| 状态 | 判定条件（任一成立） | 语义 |
| --- | --- | --- |
| `unavailable` | 出处分支（`sourceBranchId`）已不存在；或锚点 turn（`anchorTurnId`）已不存在；或锚点 turn 所属 run 的 session 不可用（`availability.status === "unavailable"`）或该 run 查询不到 | 事实缺失或会话不可达，锚点不可用 |
| `changed` | 锚点 turn 存在但 `branchId !== sourceBranchId`；或 `role !== "assistant"`；或 `piEntryId !== origin.anchorEntryId`；或偏移越界（`start < 0`、`end < start`、`end > text.length`）；或 `text.slice(start, end) !== selection.text`；或锚点 turn 无 `runId` | 事实尚在，但不再满足锚点不变量 |
| `available` | 以上全部不成立 | 锚点完好，可定位、可揭示 |

实体缺失（分支/turn 查不到）优先判为 `unavailable`；其余按不变量逐条判
`changed`；最后以锚点 run 的 session 可用性决定 `unavailable` / `available`。

实现对照：逐条一致（`service.ts` `#anchorStatus()`，L707–725——实体缺失
→ unavailable；branchId/role/piEntryId/偏移/切片/runId → changed；锚点
run session 不可用 → unavailable）。

### 1.3 降级语义（不伪造）

`changed` / `unavailable` 锚点：

- 保存的选区摘录（`selection.text`）**始终完整可读**——降级不删除、不遮蔽
  已落库的产品事实；
- 揭示（reveal）与续聊（continuation）**拒绝执行并如实报告**当前状态与
  原因（不伪造定位成功、不静默改判为可用）；
- UI 不得把降级态渲染成可用态；降级视图必须给出可执行的去向（见 §3.4）。

实现对照：摘录恒显 = `app.js` `renderPanelAnchorContext()`（L669–687，
与 originStatus 同屏呈现）；揭示拒绝并如实报告 = `revealOrigin()`
（L1408–1411，"Source reference {status}; saved excerpt remains
available."）+ `service.ts` `revealBranchOrigin()` 只在 available 时定位；
续聊 fail-closed 见 §3.4。

## 2. Return 契约

> **状态：已实现待冻结。** 语义核心 = `service.ts` `submitReturn()` /
> `prompt()` / `composePromptText()`；HTTP 映射 = `server.ts`；客户端
> draft/幂等键 = `app.js`；证据：service / api / ui-probe 套件（见 §4
> R3–R8）。

### 2.1 状态机：draft / confirmed / delivered

| 状态 | 定义 | 迁移 |
| --- | --- | --- |
| `draft` | 仅存在于客户端：不落 TreeAI DB、不产生任何产品事实。**未显式提交前永不生效**——不进入 Pi 上下文、不在任何分支视图渲染为 turn。可自由编辑、丢弃 | `draft → confirmed` 仅由用户**显式提交**触发 |
| `confirmed` | 已持久化的 return turn（记录在主干分支，含出处分支 `fromBranchId`），`deliveredRunId === null`。对用户可见（主干上的 Return 卡，"待送达"） | `confirmed → delivered` 仅由主干 prompt 的送达事务触发 |
| `delivered` | `deliveredRunId` 非空——由**下一次**把它组装进 Pi 上下文的主干 prompt 设置，且**恰好一次**。`delivered` 为终态，`deliveredRunId` 此后不再变化、不重复送达 | 终态 |

实现对照：状态词汇与派生规则 = `product.ts` 文档块（持久层无独立状态列，
持久态由 `deliveredRunId` 派生）；draft 仅客户端 = `app.js`
localStorage 草稿（L745–879，键 `treeai-return-draft:<tree>:<branch>`）；
送达恰一次 = `prompt()` 的成功事务内 `markReturnDelivered`（L974–976）+
待送达筛选 `deliveredRunId === null`（L887–889）——已送达的 Return 不再
进入组装（service 测试：重启后再 prompt `deliveredReturns === 0`）。

### 2.2 targetAnchor：提交时快照

`targetAnchor` 是提交时刻对回源分支 origin 锚点的**快照**：
`{ sourceBranchId, anchorTurnId, anchorEntryId, selection }`。

- 它是**主干上的原分叉点附近**——Return 卡渲染的位置；UI 在锚点处显示
  Return 卡并反查 `deliveredRunId`（issue #2 P0）；
- 快照在提交时冻结：此后锚点退化（`changed` / `unavailable`）不移动、
  不改写已提交 Return 卡的位置，卡上保存的摘录仍然可读（与 §1.3 一致）。

实现对照：快照构造 = `service.ts` `submitReturn()`（L1264–1269，取自
origin，与提交同事务落库；service 测试「return persists its target anchor
snapshot of the branch origin」）；卡按 `targetAnchor.anchorTurnId` 定位 =
`app.js` `renderTurnsInto()`（L536–550、L615–619）+ `returnCard()` 反查
入口（L492–502）。**边界（如实）**：锚点 turn 不在当前视图（如嵌套支线
的 Return，其锚点在非主干分支）时，卡面降级为 "original anchor
unavailable"——摘录仍可经来源抽屉的 Returns 节读取（`renderDrawer`
L1719–1744），但卡面本身不再重复摘录（§6-5）。

### 2.3 idempotencyKey：幂等键

- **生成**：每次逻辑提交由客户端生成一个 UUID；
- **稳定性**：同一内容（同一 `(fromBranchId, text)`）的重试**复用同一键**；
  失败后用户编辑了文本（或改换来源分支）则**生成新键**——旧键作废，同键
  不同内容会被 409 拒绝（见下）；
- **存储**：return turn 的 `idempotencyKey` 建立**唯一约束**（partial
  UNIQUE，仅非空值参与）。数据库是最后一道防线：即便客户端缺陷导致同键
  重复提交，也不可能落两条 confirmed Return；
- **重放**：同键 + 同 `(fromBranchId, text)` → 返回**同一 Return**
  （HTTP `200`，重放，区别于首次的 `201` created）；
- **冲突**：同键 + 不同内容 → HTTP `409`（`return-conflict`），且**零写入**；
- **读模型**：树状态读模型暴露 return turn 的 `idempotencyKey`（连同
  `targetAnchor`、`deliveredRunId`），供客户端对账（§2.5）与 UI 反查。

实现对照：客户端生成/换键 = `app.js` `crypto.randomUUID()`（草稿创建与
失败后编辑换键，L836–842、L869–879）；唯一约束 = `persistence` migration
0004 `CREATE UNIQUE INDEX idx_turns_idempotency_key ON turns(idempotency_key)
WHERE idempotency_key IS NOT NULL`；重放/冲突 = `submitReturn()` 幂等前置
检查与并发兜底（L1245–1248、L1286–1296）+ `#alignWithExistingReturn()`
（L1300–1317）；读模型暴露 = `TreeState` turn 投影。**范围注记（如实）**：
唯一索引是 `turns(idempotency_key)` 上的**全局**（跨树）部分唯一索引，而
重放查找 `findReturnByIdempotencyKey` 按 `treeId` 过滤——同键用于另一棵
树会以约束冲突（HTTP 400）拒绝而非重放；客户端按本条使用 UUID，该边角
实际不可达（§6-2）。

### 2.4 提交顺序（写入顺序即契约）

**主干导航先于任何 Return 持久化。**

- 导航失败（如 Pi session 缺失 → `502 session-corrupt`）在**任何** Return
  落库之前抛出 → 同一失败上重试**零重复写入**，重试安全；
- 导航成功后的写入失败，重试只会补写一次（同键重放兜底，§2.3）；
- 主干尚无 session（new-session 续聊点）时不导航、不新建 session，Return
  直接落库，待首次主干 prompt 时建 session 并送达。

实现对照：`submitReturn()` 顺序 = 幂等重放检查（只读、先于导航）→
`switchBranch`（导航，失败先抛）→ 单事务落库（episode + return turn，
唯一索引判负整体回滚、无悬挂 episode，L1245–1296）；new-session 分支 =
`switchBranch()` 对 `new-session` 显式不导航不建会话（L1157–1161）。
（该 new-session 直落库分支无专属自动化用例——按构造覆盖，§6-7。）

### 2.5 响应丢失恢复

提交响应丢失（超时 / 断连 / 客户端崩溃后重启）时，客户端：

1. 先 **refetch 树状态**，按 `idempotencyKey` 匹配已落库的 Return；
2. 命中 → 按已提交处理，**不重复提交**；
3. 未命中 → 以**同一键**重新提交（此时若服务端其实已落库，走 §2.3 重放
   路径，返回同一 Return）。

实现对照：`app.js` `submitReturn()` catch 分支（L1587–1603：失败即
`GET /state`，`findReturnByKey()` 同键命中 → 清草稿按成功处理；未命中 →
保留草稿与键供同键重试）+ 草稿跨刷新持久化（§2.1）。

### 2.6 送达与反查

- confirmed Return 由**下一次主干 prompt** 组装进 Pi 上下文（前缀拼接，
  可确定性重放）；送达在**同一 DB 事务**内标记 `deliveredRunId`，失败的主
  干 prompt 不标记（Return 保持 `confirmed`，等待下一次）；
- **反查**：`deliveredRunId` 交叉引用 run 诊断面（`GET
  /api/trees/:treeId/diagnostics` 的 run 行：state / failure code+message /
  createdAt / terminalAt），UI 从 delivered Return 卡可跳转查看。

实现对照：组装 = `composePromptText()`（L454–460，前缀 `[Return from
branch …]` 块）+ `prompt()` 待送达筛选（L886–890）；送达事务 = 成功收敛
的同一 `repository.transaction`（L954–978，含 `markReturnDelivered`）；
失败路径不触碰该事务（收敛为 failed/aborted 的 catch 分支，L919–951）；
反查 = `RunDiagnostics` 安全投影（`getTreeDiagnostics` L1036–1072）+
`app.js` delivered 卡点击开来源抽屉定位该 run（L497–502、L1798–1805）。

### 2.7 HTTP 映射（Studio HTTP 面）

`POST /api/trees/:treeId/return`，请求体 `{ fromBranchId, text,
idempotencyKey }`：

| 响应 | 含义 |
| --- | --- |
| `201` | 首次创建（created） |
| `200` | 同键同内容重放，返回既有 Return |
| `409 return-conflict` | 同键不同内容，零写入 |
| `502 session-corrupt` 等运行期错误 | 导航失败（§2.4），零 Return 写入 |
| `400` / `404` | 参数或实体错误（缺键/空白键 → 400，字段名进消息；未知树/分支 → 404） |

响应携带更新后的树状态（`{returnTurn, state}`）。

实现对照：`server.ts` `/return` 处理（L351–368，`submission.created ?
201 : 200`）+ `sendError()` 映射（L87–130：`ReturnConflictError` → 409
`return-conflict`；运行期 `TreeAIError` → 502；`InvalidArgumentError`/
`ConstraintViolationError` → 400；`EntityNotFoundError` → 404）。

## 3. 失败幂等契约

> **状态：已实现待冻结。** 语义核心 = `service.ts` `prompt()` / `abort()` /
> `recoverInterruptedRuns()` / `#probeSessionAvailability()`；证据：service /
> api / events 套件 + `tests/integration/scenarios.test.ts`（D2 层收敛语义，
> 见 §4 R9–R13）。§3.2 含一处对旧稿的**勘误**（§6-1）。

### 3.1 单在途 prompt

每个服务实例同一时刻**至多一个在途 prompt 操作**（含会话对准阶段）。
第二个并发 prompt 以操作冲突拒绝（HTTP `409`），且**不产生任何**
episode / run / turn 部分写入。

实现对照：`#promptInFlight` 同步前缀置位（`prompt()` L876–879，第二个
prompt 确定性 `TypeError`）；`server.ts` TypeError → 409（L106–110）。

### 3.2 中止（abort）

- `abort` 仅接受**该树当前在途的 run**；已终态 / 无在途 / 另有在途的
  run → `409` 操作冲突（`RunNotActiveError`）；跨树 run 与空 runId →
  `400`（参数错误，`InvalidArgumentError`）；未知树 / run → `404`；
- 用户中止把 run 以单事务收敛为 **`aborted`**，**绝不改写为 `failed`**；
- prompt 已先一步 settle 时，`abort` 不产生效果、不改写结果（不撒谎）。

> **勘误（2026-09-29，§6-1）**：旧稿称其余目标"一律 `409` 操作冲突"——
> 与代码不符。实际映射（`server.ts` `sendError()` 与 abort 路由注释
> L373–385）：非活动 run → 409；跨树 run / 空 id → 400；未知树 / run →
> 404。本文按代码改正；如负责人裁定跨树亦应归 409，属契约变更（需改
> `server.ts` 映射与 api 测试）。

实现对照：校验链 = `abort()`（L1008–1025：树/run/episode/branch 逐级校验
+ 活动性检查）；收敛 = `prompt()` 的 user-abort 分支单事务
running → aborting → aborted（L923–939，含会话叶回位到续聊点）；已
settle 的 abort = 活动性检查拒绝，无副作用。

### 3.3 宿主重启收敛

- 重启时宿主把所有**非终态 run** 收敛为 `failed`（host-interrupted 语义，
  带宿主中断标记）；重复调用安全（无则空转）；
- **DB 是事实源**：进程内簿记（cursor / 在途 run）重启即失效，一切以
  TreeAI DB 为准重建。注入 journal 时，journal 侧同步执行 host-crash
  恢复（`journalRecovery`，构造时执行，失败不挂进程）。

实现对照：`recoverInterruptedRuns()` 构造时调用（L510–523，
`failNonTerminalRuns` 带 `details.hostInterrupted: true`——该 detail 只入
DB，诊断面不外泄）；journal 恢复 = 构造函数（L496–505）。

### 3.4 缺失 Pi session

- **产品事实全部可读**：Tree / Branch / Turn（含锚点摘录）不依赖 Pi
  session 文件——TreeAI DB 拥有产品事实（ADR-001 §4）；
- 受影响分支在状态读模型中**如实呈现 session 不可用**（锚点
  `unavailable`、续聊不可用），不隐藏、不降格为普通错误；
- **续聊 fail closed**：续聊如实失败（`502 session-corrupt`），**绝不静默
  重建 session**——重建即分叉历史，破坏 Pi 会话树与 DB 事实的一致性；
- **恢复提示必须可执行**：引导用户**从既有 turn 创建新分支**继续工作。
  该恢复不修复、也不伪装受影响分支的历史连续性，只给出继续工作的路径。

实现对照：可读性 = 读模型只查 DB；如实呈现 = `sessionAvailability` 实时
存在性探针修正 DB 缓存（`#probeSessionAvailability` L758–766：missing-file
且文件已恢复 → available；version-mismatch/corrupt → 维持 unavailable；
只探存在、绝不读内容）；fail-closed = 续聊走 `#ensureSessionAt` →
restoreSession 失败即抛（无重建路径）；可执行恢复 = `app.js`
"⑃ Branch from latest available answer"（横幅与面板降级提示共用，无候选
时禁用并说明原因——恢复是绕行不是解锁，fail-closed 入口保持禁用）。

### 3.5 模型错误

prompt 失败（上游 / 模型错误）把 run 收敛为 `failed` 并记录
`failure { code, message }`；不产生 assistant turn；已确认的 Return 保持
`confirmed` 不被标记送达。诊断面只外泄 code / message，不外泄 details、
原始 cause、session 引用与路径。

实现对照：失败收敛 = `prompt()` 非 user-abort 分支（L940–949，
`updateRunState(run.id, "failed", { failure })`，无 turn 写入）；安全投影
键集合由测试精确锁定（`getTreeDiagnostics` L1036–1072）。

## 4. 测试义务表

测试类别：**响应丢失 / 双击 / 并发 / 缺失 session / 重启收敛 / 中止 /
模型错误**（前四类为 issue #2 P0 明确要求；后三类来自本契约与 A4–A5）。
自动化 = 离线测试套件（`apps/studio/tests/`，`56f8c31` 实测 53/53 通过；
产物归 `evidence/d3/offline/`）；人工 = 目标 Mac / 真实 Pi 操作（记录归
`evidence/d3/real-pi/`，用 `evidence/d3/templates/run-record.md`）。下表
自动化列为**实际存在的用例**（不再以"随同一 push 落地"占位）；证据缺口
如实标注。

| # | 契约规则 | 测试类别 | 断言要点 | 自动化（离线，56f8c31） | 人工（目标 Mac / 真实 Pi） |
| --- | --- | --- | --- | --- | --- |
| R1 | 选区以绝对偏移定位（§1.1） | 双击（重复词 / 跨行 / 长答案） | 重复词第二处、跨行、长答案选区揭示高亮命中原位置，不依赖字符串搜索 | service.test.ts「anchor status preserves duplicate and cross-line selections and degrades when source is unavailable」（重复词第二处 + 跨行偏移不变量）、「branch anchoring is validated (answer role, slice integrity, bounds)」；**长答案 UI 级未验**（ui-probe 文本均为短句） | 目标 Mac 完整操作一遍（A2，含数千字符长答案） |
| R2 | 锚点三态判定与降级（§1.2–1.3） | 缺失 session | 判定规则逐条命中；降级时摘录可读、揭示/续聊拒绝且如实报告、不伪造 | available/unavailable 判定与降级：service.test.ts 同上用例（session 不可用 → originStatus unavailable）；api.test.ts 主流程（`/source` available）；**`changed` 分支无直接用例**——产品当前无 turn 改写路径，正常流不可构造（§6-3） | 真实 session 缺失抽查 |
| R3 | draft 不生效（§2.1） | 双击 | 草稿不落库、不进 Pi 上下文、不渲染为产品 turn | ui-probe「return flow: draft persistence with idempotency key, double-submit guard, submit finalization」（草稿仅存 localStorage 并携带幂等键，Return 卡仅在提交后出现于树状态）；"不进 DB / Pi 上下文"按构造成立（draft 只存在于客户端输入框与 localStorage，无落库通道） | UI 可见性确认（刷新后草稿恢复、未提交不渲染） |
| R4 | delivered 恰好一次（§2.6） | 双击 / 模型错误 | 下一次主干 prompt 送达并置 `deliveredRunId`；失败的 prompt 不置、不重复置 | service.test.ts「full D3 vertical slice…」（`deliveredReturns === 1`；重启后再 prompt `deliveredReturns === 0`——不重复送达）+「composePromptText prefixes pending returns deterministically」；**"失败 prompt 不置"无直接用例**（按构造成立，§6-4） | 真实 Pi 送达一次验证 |
| R5 | 同键同内容 → 同一 Return（§2.3） | 双击 | 双击提交第二次 `200` 重放；DB 仅一条 confirmed Return | api.test.ts「return idempotency over HTTP: 201 create, 200 replay, 409 conflict, 400 missing key」；service.test.ts「return idempotency: same key+content replays the same turn; different content conflicts」；ui-probe「return flow…」（DOM 级防双击恰一次 POST） | UI 双击提交按钮（实机口径） |
| R6 | 同键不同内容 → 409（§2.3） | 双击 | `409 return-conflict`，零写入 | 同上两用例（冲突持久化零写入断言）；并发同键异容：service.test.ts「concurrent same-key submits converge to one return (race-safe, no dangling episode)」 | — |
| R7 | 响应丢失先对账再重提（§2.5） | 响应丢失 | 响应丢失 → refetch 按键命中 → 不重复提交；未命中 → 同键重提安全 | ui-probe「return failure semantics: response-loss reconciliation, draft kept on failure, rekey on edit」；api.test.ts「response-loss resubmit and double-click converge to exactly one return」 | 断网 / 杀进程后恢复复现 |
| R8 | 导航先于 Return 持久化（§2.4） | 响应丢失 / 缺失 session | session 缺失 → 导航失败 `502` → 零 Return 写入；重试不重复 | api.test.ts「return with a missing Pi session file: 502 before any write; retry creates no duplicate Return」；service.test.ts「missing session: submit rejects with no return persisted; restore + same-key retry lands exactly once」 | — |
| R9 | 单在途 prompt（§3.1） | 并发 | 第二并发 prompt `409`，零 episode/run/turn 写入 | service.test.ts「concurrent prompt is rejected as a conflict and leaves no phantom run」；api.test.ts「diagnostics and abort endpoints…」（并发 409 + 无幽灵 run） | — |
| R10 | 中止语义（§3.2） | 中止 | 非活动 run → `409`；user-abort → `aborted` 不改写 `failed`；已 settle 的 abort 无效果 | service.test.ts「abort: only the active run of the tree is abortable; user-abort converges to aborted, not failed」（含 404/400/409 映射与中止后上下文隔离）；api.test.ts 同名面（「diagnostics and abort endpoints…」）；events.test.ts「abort over SSE: abort-requested precedes run-terminal aborted; journal projection agrees」；D2 层支撑：tests/integration/scenarios.test.ts「e2e error-convergence…」 | 真实 Pi 中途点停止 |
| R11 | 重启收敛（§3.3） | 重启收敛 | 非终态 run 重启后 `failed`（host-interrupted）；DB 事实源；重启后流程可继续 | service.test.ts「startup recovery converges interrupted runs to failed (I6 host-interrupt semantics)」+「full D3 vertical slice…」（重启恢复 + 分支/主干续聊）；api.test.ts「HTTP API serves the UI and the full D3 flow, surviving a restart」；events.test.ts「process restart: journal and diagnostics converge consistently (host-crash semantics)」 | kill 宿主后重启复现 |
| R12 | 缺失 session fail-closed + 可执行恢复（§3.4） | 缺失 session | 树/分支/turn 可读；续聊 `502` 不静默重建；恢复提示（从既有 turn 开新分支）可执行 | events.test.ts「session deletion: readable tree, unavailable branch, fail-closed prompt with no partial writes, recovery path」+「session availability derivation: live probe refines the cached assessment honestly」；ui-probe「branch panel degradation: recovery action posts an exact whole-answer /branches body, composer stays fail-closed」+「trunk session banner: disabled with reason when nothing is available; cross-branch recovery posts an exact body」 | 文件级移除 session，按 UI 提示恢复 |
| R13 | 模型错误收敛（§3.5） | 模型错误 | run `failed` + failure 记录；无 assistant turn；confirmed Return 不被标记送达 | events.test.ts「model error injection: run converges failed across HTTP, diagnostics, journal and SSE」（`/fail` 注入：failed + code/message + 零 turn + journal/诊断面一致）；安全投影：service.test.ts「diagnostics read model: safe projection only (no session refs, details, causes, paths)」；**"confirmed Return 不被标记送达"无直接用例**（按构造成立，§6-4） | 真实 Pi 侧错误配置一次 |

## 5. 明确非目标

- **本文档不签署 Gate 0。** W1 契约冻结需要负责人签署（下方签署区块）；
  在此之前本文档仅为草案文本——"已实现待冻结"只陈述实现与证据状态，
  **不构成负责人同意**。
- Gate 0–2 与 A1–A7 的 Go / No-Go 均为负责人决策；仓库文档只记录状态，
  绝不声称签署或通过（见 `docs/d3/D3-status.md`）。
- W1 契约冻结 ≠ D3 Go：issue #2 的 Go 条件另要求 `evidence/d3/` 下的真实
  Pi 操作证据、故障/幂等测试、设计对照与 3–5 人试用记录，全部绑定同一
  commit SHA 并经负责人签署。
- 未写入本文档的行为不因本文档而冻结；契约的后续修改需负责人批准并
  追加变更记录（沿用 `coordination/d2/` 的 CONTRACT-CHANGE 纪律）。本文
  2026-09-29 的逐条核实（§6）是**对齐实现的事实陈述**，不是契约变更——
  其中标注"待 owner 裁决"的偏差（§6-1/2/5）在负责人裁定前不改变现状。

## 6. 勘误与实现对照（2026-09-29，issue #5）

本节汇总 2026-09-29 对照 `56f8c31` 代码核实本契约时发现的**草稿与代码
不一致处与证据缺口**（正文已按代码改正或加注；逐条待负责人在冻结时裁
决）：

1. **§3.2 abort 错误码（已改正）**：旧稿称非活动目标"一律 409"。实际
   映射：已终态 / 无在途 / 另有在途 → `409`（`RunNotActiveError`）；跨树
   run 与空 runId → `400`（`InvalidArgumentError`）；未知树 / run →
   `404`。若负责人裁定跨树亦应归 409，属契约变更（需改 `server.ts`
   `sendError()` 与 api 测试）。
2. **§2.3 唯一约束的范围（加注）**：`idx_turns_idempotency_key` 是
   `turns(idempotency_key)` 上的**全局**（跨树）部分唯一索引；重放查找
   `findReturnByIdempotencyKey` 却按 `treeId` 过滤——同键用于另一棵树会
   以 400（约束冲突）拒绝而非重放。客户端按 §2.3 生成 UUID，该边角实际
   不可达；若契约需要"按树唯一"，需改索引并补测试（owner 决策）。
3. **§1.2 `changed` 判定无直接用例（加注）**：产品当前没有改写 turn 文本
   的路径，正常产品流无法构造 `changed` 态；自动化只覆盖
   `available`/`unavailable`。R2 的"判定规则逐条命中"强于现有证据——补
   测试需要伪造不变量破坏（如直改 DB）或引入编辑功能。
4. **§2.6/§3.5 "失败的 prompt 不标记送达"无直接用例（加注）**：送达只发
   生在成功收敛的同一事务内（`service.ts` `prompt()` L954–978），失败路
   径按构造不触碰；但无"pending return + 失败 prompt"的组合用例。补测试
   需要在有待送达 Return 的树上注入 `/fail`。
5. **§2.2 降级 Return 卡的摘录（加注）**：锚点 turn 在当前视图内时卡面
   呈现摘录；锚点不在当前视图（如嵌套支线的 Return）时卡面降级为
   "original anchor unavailable"，摘录仅在来源抽屉 Returns 节可读。若契约
   要求卡面恒显摘录，属 UI 待办（owner 决策）。
6. **实现基线表述过时（已改正）**：旧稿"实现本契约的代码变更与本文档
   同一 push 提交"不再成立——实现分布在 `8671136`（幂等/targetAnchor）、
   `6ff7146`（事件/journal/降级）、`d061b5f`（UI 改版）及 issue #3/#4 波
   次；本稿统一以 `56f8c31` 勘定。
7. **§2.4 new-session 直落库分支无专属用例（加注）**：主干尚无 session
   时 Return 不导航直接落库——`switchBranch()` 对 new-session 显式返回
   （L1157–1161），按构造覆盖，但无"空主干提交 Return"的独立用例。

## 签署

> **待负责人签署**——签署前本契约为 DRAFT，不冻结任何语义。签署人应对照
> §1–§3 正文与 §6 勘误逐条裁定（尤其 §6-1/2/5 的偏差项），并在结论列写
> 明"冻结"或"需修订（附修订项）"。

| 角色 | 签署 | 日期 | 结论（冻结 / 需修订） |
| --- | --- | --- | --- |
| 负责人 | （待签署） | （待签署） | （待签署） |
