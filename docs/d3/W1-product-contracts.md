# W1 产品契约（草案，待负责人签署）

> **状态：DRAFT — 待签署。** 本文档是仓库内起草的 W1 契约文本，回应 GitHub
> issue #2《D3 验收：Gate 2 No Go 与修订方案》（2026-09-29）的 Gate 0 缺口
> 之一：「W1 Anchor/Return/失败幂等契约未冻结」。签署权在负责人；在负责人
> 签署之前，本文档不冻结任何契约、不构成 Gate 0 通过——Gate 0–2 与 A1–A7
> 的验收均为负责人决策（见 `docs/d3/D3-status.md`，该文件只记录状态）。
>
> **实现基线**：实现本契约的代码变更（Return `idempotencyKey`、
> `targetAnchor`、draft/confirmed/delivered 状态、存储唯一约束与配套测试）
> 与本文档**同一 push** 提交。文档与代码的一致性以绑定 commit SHA 的证据
> （`evidence/d3/`）为准，不以本文档自述为准。

| 项目 | 内容 |
| --- | --- |
| 文档状态 | DRAFT 待签署（签署区块见文末，留空） |
| 依据 | issue #2（2026-09-29）P0 与 A2–A5 缺口 |
| 契约载体 | `packages/contracts/src/product.ts`（TurnSelection / Turn / BranchOrigin 共享形状）、`apps/studio/src/service.ts`（产品语义）、`apps/studio/src/server.ts`（HTTP 映射） |
| 证据口径 | 自动化离线 → `evidence/d3/offline/`；真实 Pi 与目标 Mac → `evidence/d3/real-pi/` |

## 1. 锚点（Anchor）契约

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

### 1.3 降级语义（不伪造）

`changed` / `unavailable` 锚点：

- 保存的选区摘录（`selection.text`）**始终完整可读**——降级不删除、不遮蔽
  已落库的产品事实；
- 揭示（reveal）与续聊（continuation）**拒绝执行并如实报告**当前状态与
  原因（不伪造定位成功、不静默改判为可用）；
- UI 不得把降级态渲染成可用态；降级视图必须给出可执行的去向（见 §3.4）。

## 2. Return 契约

### 2.1 状态机：draft / confirmed / delivered

| 状态 | 定义 | 迁移 |
| --- | --- | --- |
| `draft` | 仅存在于客户端：不落 TreeAI DB、不产生任何产品事实。**未显式提交前永不生效**——不进入 Pi 上下文、不在任何分支视图渲染为 turn。可自由编辑、丢弃 | `draft → confirmed` 仅由用户**显式提交**触发 |
| `confirmed` | 已持久化的 return turn（记录在主干分支，含出处分支 `fromBranchId`），`deliveredRunId === null`。对用户可见（主干上的 Return 卡，"待送达"） | `confirmed → delivered` 仅由主干 prompt 的送达事务触发 |
| `delivered` | `deliveredRunId` 非空——由**下一次**把它组装进 Pi 上下文的主干 prompt 设置，且**恰好一次**。`delivered` 为终态，`deliveredRunId` 此后不再变化、不重复送达 | 终态 |

### 2.2 targetAnchor：提交时快照

`targetAnchor` 是提交时刻对回源分支 origin 锚点的**快照**：
`{ sourceBranchId, anchorTurnId, anchorEntryId, selection }`。

- 它是**主干上的原分叉点附近**——Return 卡渲染的位置；UI 在锚点处显示
  Return 卡并反查 `deliveredRunId`（issue #2 P0）；
- 快照在提交时冻结：此后锚点退化（`changed` / `unavailable`）不移动、
  不改写已提交 Return 卡的位置，卡上保存的摘录仍然可读（与 §1.3 一致）。

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

### 2.4 提交顺序（写入顺序即契约）

**主干导航先于任何 Return 持久化。**

- 导航失败（如 Pi session 缺失 → `502 session-corrupt`）在**任何** Return
  落库之前抛出 → 同一失败上重试**零重复写入**，重试安全；
- 导航成功后的写入失败，重试只会补写一次（同键重放兜底，§2.3）；
- 主干尚无 session（new-session 续聊点）时不导航、不新建 session，Return
  直接落库，待首次主干 prompt 时建 session 并送达。

### 2.5 响应丢失恢复

提交响应丢失（超时 / 断连 / 客户端崩溃后重启）时，客户端：

1. 先 **refetch 树状态**，按 `idempotencyKey` 匹配已落库的 Return；
2. 命中 → 按已提交处理，**不重复提交**；
3. 未命中 → 以**同一键**重新提交（此时若服务端其实已落库，走 §2.3 重放
   路径，返回同一 Return）。

### 2.6 送达与反查

- confirmed Return 由**下一次主干 prompt** 组装进 Pi 上下文（前缀拼接，
  可确定性重放）；送达在**同一 DB 事务**内标记 `deliveredRunId`，失败的主
  干 prompt 不标记（Return 保持 `confirmed`，等待下一次）；
- **反查**：`deliveredRunId` 交叉引用 run 诊断面（`GET
  /api/trees/:treeId/diagnostics` 的 run 行：state / failure code+message /
  createdAt / terminalAt），UI 从 delivered Return 卡可跳转查看。

### 2.7 HTTP 映射（Studio HTTP 面）

`POST /api/trees/:treeId/return`，请求体 `{ fromBranchId, text,
idempotencyKey }`：

| 响应 | 含义 |
| --- | --- |
| `201` | 首次创建（created） |
| `200` | 同键同内容重放，返回既有 Return |
| `409 return-conflict` | 同键不同内容，零写入 |
| `502 session-corrupt` 等运行期错误 | 导航失败（§2.4），零 Return 写入 |
| `400` / `404` | 参数或实体错误 |

响应携带更新后的树状态。

## 3. 失败幂等契约

### 3.1 单在途 prompt

每个服务实例同一时刻**至多一个在途 prompt 操作**（含会话对准阶段）。
第二个并发 prompt 以操作冲突拒绝（HTTP `409`），且**不产生任何**
episode / run / turn 部分写入。

### 3.2 中止（abort）

- `abort` 仅接受**该树当前在途的 run**；其余目标（已终态 / 无在途 / 另有
  在途 / 跨树）一律 `409` 操作冲突；
- 用户中止把 run 以单事务收敛为 **`aborted`**，**绝不改写为 `failed`**；
- prompt 已先一步 settle 时，`abort` 不产生效果、不改写结果（不撒谎）。

### 3.3 宿主重启收敛

- 重启时宿主把所有**非终态 run** 收敛为 `failed`（host-interrupted 语义，
  带宿主中断标记）；重复调用安全；
- **DB 是事实源**：进程内簿记（cursor / 在途 run）重启即失效，一切以
  TreeAI DB 为准重建。

### 3.4 缺失 Pi session

- **产品事实全部可读**：Tree / Branch / Turn（含锚点摘录）不依赖 Pi
  session 文件——TreeAI DB 拥有产品事实（ADR-001 §4）；
- 受影响分支在状态读模型中**如实呈现 session 不可用**（锚点
  `unavailable`、续聊不可用），不隐藏、不降格为普通错误；
- **续聊 fail closed**：续聊如实失败（`502 session-corrupt`），**绝不静默
  重建 session**——重建即分叉历史，破坏 Pi 会话树与 DB 事实的一致性；
- **恢复提示必须可执行**：引导用户**从既有 turn 创建新分支**继续工作。
  该恢复不修复、也不伪装受影响分支的历史连续性，只给出继续工作的路径。

### 3.5 模型错误

prompt 失败（上游 / 模型错误）把 run 收敛为 `failed` 并记录
`failure { code, message }`；不产生 assistant turn；已确认的 Return 保持
`confirmed` 不被标记送达。诊断面只外泄 code / message，不外泄 details、
原始 cause、session 引用与路径。

## 4. 测试义务表

测试类别：**响应丢失 / 双击 / 并发 / 缺失 session / 重启收敛 / 中止 /
模型错误**（前四类为 issue #2 P0 明确要求；后三类来自本契约与 A4–A5）。
自动化 = 离线测试套件（`apps/studio/tests/`，产物归
`evidence/d3/offline/`）；人工 = 目标 Mac / 真实 Pi 操作（记录归
`evidence/d3/real-pi/`，用 `evidence/d3/templates/run-record.md`）。

| # | 契约规则 | 测试类别 | 断言要点 | 自动化（离线） | 人工（目标 Mac / 真实 Pi） |
| --- | --- | --- | --- | --- | --- |
| R1 | 选区以绝对偏移定位（§1.1） | 双击（重复词 / 跨行 / 长答案） | 重复词第二处、跨行、长答案选区揭示高亮命中原位置，不依赖字符串搜索 | 重复词 + 跨行：service 层已覆盖；长答案 UI 级未验 | 目标 Mac 完整操作一遍（A2） |
| R2 | 锚点三态判定与降级（§1.2–1.3） | 缺失 session | 判定规则逐条命中；降级时摘录可读、揭示/续聊拒绝且如实报告、不伪造 | 已覆盖（死引用降级） | 真实 session 缺失抽查 |
| R3 | draft 不生效（§2.1） | 双击 | 草稿不落库、不进 Pi 上下文、不渲染为产品 turn | 随同一 push 落地（待验收） | UI 可见性确认 |
| R4 | delivered 恰好一次（§2.6） | 双击 / 模型错误 | 下一次主干 prompt 送达并置 `deliveredRunId`；失败的 prompt 不置、不重复置 | 已覆盖（组装与送达事务） | 真实 Pi 送达一次验证 |
| R5 | 同键同内容 → 同一 Return（§2.3） | 双击 | 双击提交第二次 `200` 重放；DB 仅一条 confirmed Return | 随同一 push 落地（待验收） | UI 双击提交按钮 |
| R6 | 同键不同内容 → 409（§2.3） | 双击 | `409 return-conflict`，零写入 | 随同一 push 落地（待验收） | — |
| R7 | 响应丢失先对账再重提（§2.5） | 响应丢失 | 响应丢失 → refetch 按键命中 → 不重复提交；未命中 → 同键重提安全 | 随同一 push 落地（待验收） | 断网 / 杀进程后恢复复现 |
| R8 | 导航先于 Return 持久化（§2.4） | 响应丢失 / 缺失 session | session 缺失 → 导航失败 `502` → 零 Return 写入；重试不重复 | 已覆盖（api 层） | — |
| R9 | 单在途 prompt（§3.1） | 并发 | 第二并发 prompt `409`，零 episode/run/turn 写入 | 已覆盖（concurrent prompt） | — |
| R10 | 中止语义（§3.2） | 中止 | 非活动 run → `409`；user-abort → `aborted` 不改写 `failed`；已 settle 的 abort 无效果 | 已覆盖（service + api） | 真实 Pi 中途点停止 |
| R11 | 重启收敛（§3.3） | 重启收敛 | 非终态 run 重启后 `failed`（host-interrupted）；DB 事实源；重启后流程可继续 | 已覆盖（startup recovery + restart survival） | kill 宿主后重启复现 |
| R12 | 缺失 session fail-closed + 可执行恢复（§3.4） | 缺失 session | 树/分支/turn 可读；续聊 `502` 不静默重建；恢复提示（从既有 turn 开新分支）可执行 | fail-closed 语义已覆盖；**UI 降级视图与恢复提示未建**（A4） | 文件级移除 session，按 UI 提示恢复 |
| R13 | 模型错误收敛（§3.5） | 模型错误 | run `failed` + failure 记录；无 assistant turn；confirmed Return 不被标记送达 | `failed` 收敛与安全投影已覆盖；真实模型错误需注入 | 真实 Pi 侧错误配置一次 |

## 5. 明确非目标

- **本文档不签署 Gate 0。** W1 契约冻结需要负责人签署（下方签署区块）；
  在此之前本文档仅为草案文本。
- Gate 0–2 与 A1–A7 的 Go / No-Go 均为负责人决策；仓库文档只记录状态，
  绝不声称签署或通过（见 `docs/d3/D3-status.md`）。
- W1 契约冻结 ≠ D3 Go：issue #2 的 Go 条件另要求 `evidence/d3/` 下的真实
  Pi 操作证据、故障/幂等测试、设计对照与 3–5 人试用记录，全部绑定同一
  commit SHA 并经负责人签署。
- 未写入本文档的行为不因本文档而冻结；契约的后续修改需负责人批准并
  追加变更记录（沿用 `coordination/d2/` 的 CONTRACT-CHANGE 纪律）。

## 签署

| 角色 | 签署 | 日期 | 结论（冻结 / 需修订） |
| --- | --- | --- | --- |
| 负责人 |  |  |  |
