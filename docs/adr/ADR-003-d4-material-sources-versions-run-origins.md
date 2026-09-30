# ADR-003：D4 材料来源类型、不可变版本与运行起点（Material Source Types, Immutable Versions, and Run Origins）

- **状态：Accepted（2026-09-30）**
- 创建日期：2026-09-30
- 作者：D4-0 波次工程（Integrator 执行）
- 决策权：负责人（产品语义）；工程实现细节由本项目书委派给本 ADR
- 负责人确认来源：issue #8《TreeAI D4 项目书 v1.1》（2026-09-30）§4 工作包 D4-0 指定交付「来源类型/材料版本/运行起点 ADR」；§3.3 明确「是否复用树内有效运行或创建独立 session 由开工 ADR 说明并测试」。
- 上游已批准事实：ADR-001（Pi 进程内嵌入与 SessionReference 数据边界，Accepted 2026-09-20）；ADR-002（Pi 改造治理，Accepted 2026-09-21）；W1 v3 产品契约（仓内镜像 `docs/d3/W1-product-contracts.md`，合规标准为已签署的外部 v3.0）；D2 契约治理流程（`docs/d2/contracts-README.md`）。

> **状态说明（不可移除）**：本 ADR 是 D4 项目书（issue #8 v1.1）D4-0 工作包的指定交付物。项目书 §3 已冻结产品语义；本 ADR 在其边界内只做工程决策（存储形状、来源契约扩展方式、运行起点策略），并列出测试义务。产品语义的任何变更须回到负责人；不以前端完成度或工期为由改写本 ADR 的产品约束。

## 1. 背景与上下文

D3 的来源契约只有 **Turn 来源**：`BranchOrigin`（`packages/contracts/src/product.ts`）以 `branchId` 为主键 1:1 挂在非根 Branch 上，引用 `anchorTurnId`/`anchorEntryId` 与该 assistant Turn 文本上的连续切片 `selection`，不变量由服务层保证（锚必须是 assistant Turn、切片相等、每枝至多一个来源）。Return 以 `ReturnTargetAnchor` 快照来源；术语批注 `TerminologyAnnotation` 同样锚定 assistant Turn 并保存 `sourceHash`。

D4 把同一能力延伸到用户导入的材料（charter §1）。材料没有 assistant Turn，也没有 Pi entry——**材料来源不得伪造它们**（charter §3.2）。因此需要：(a) 可区分的来源类型；(b) 不可变的材料与版本存储；(c) 无天然 Pi 分叉点时的显式运行起点。

治理边界：`packages/contracts` 的新增类型是**纯增量**（non-breaking addition），按 `docs/d2/contracts-README.md` 记录即可；既有 Turn 来源语义、已交付迁移（0001–0007）与 Pi SDK 边界（ADR-001/002）不动。

## 2. 决策一：来源类型 —— 平行来源表 + `branches.origin_kind` 判别

**备选方案**：

- 方案 A：加宽既有 `branch_origins` 表（`kind` 判别 + 各来源类型的可空列）。SQLite 的 ALTER 不能加表级 CHECK，落地需重建已交付表——触碰冻结结构，弃。
- 方案 B（**选定**）：新建 `material_branch_origins` 表（PK `branch_id`）与 `branch_origins` 平行；`branches` 增加 `origin_kind` 列。

**理由**：已交付迁移不可变（`packages/persistence/README.md` 纪律），新表零回填风险；两表各自以 `branch_id` 为主键，**结构性保证每枝至多一个来源**；「非根枝恰有一个来源、且类型与 `origin_kind` 一致」由 repository 事务纪律 + 完整性测试保证（与既有「锚必须是 assistant Turn」同一级服务不变量）；`origin_kind` 让读模型与 B4 搜索一次判别来源类型。

`origin_kind ∈ {'none','turn','material'}`：trunk 为 `none`；迁移 0008 对既有非根枝回填 `'turn'`。统一读接口：`getBranchOrigin(branchId)` 返回 Turn 来源或 Material 来源或 null。

**Material 来源形状**（charter §3.2 最小集）：

```ts
interface MaterialSelection {
  materialId: MaterialId; versionId: MaterialVersionId;
  blockId: string;            // 解析器产生的块/页标识
  start: number; end: number; // 版本 canonicalText 内 UTF-16 半开区间
  text: string;               // 原摘录
}
interface MaterialBranchOrigin {
  branchId: BranchId; treeId: TreeId;
  selection: MaterialSelection;
  sourceHash: string;         // 版本 canonicalText 的 SHA-256（与术语 sourceHash 同纪律）
  createdAt: IsoTimestamp;
}
```

**验证纪律**（与 Turn 来源共享，按材料改写）：

- `selection.text === canonicalText.slice(start, end)`；区间在版本 canonicalText 边界内；`blockId` 存在于版本 block map 且区间含于该块；
- 仅 `parse_status = ready` 的版本可精确建枝；`rejected/unsupported/failed/corrupt` 材料拒绝建枝并说明原因（charter §3.2 不把不支持伪装成成功空文档）；
- 材料来源**永不**携带 `anchorTurnId`/`piEntryId`；
- 锚点绑定 `versionId + sourceHash`，版本不可变 ⇒ 旧版本锚点永久可读；切换到新版本**不迁移**旧锚点到相似文字（charter §3.1/§3.2）。

**三态对齐 W1 §1.2/1.3**：材料来源同样有 `available`（版本在且切片相等）/ `changed`（材料已有更新版本——锚点仍读旧快照，展示时标注旧版本）/ `unavailable`（版本缺失——摘录快照仍可读）三态，只由产品事实判定；session 可续聊是独立维度，不降级来源状态；降级不阻断续聊（charter §3.2「来源可定位、旧版本可读与 Pi 可续聊分别判断」）。

**材料 Return**：落所属 Tree 主线；卡片展示材料标题、版本、页/段、摘录、确认时间与采用记录；无主线对话锚点时按确认时间放置并提供原文跳转，不伪造主线位置（charter §3.3）。

## 3. 决策二：材料与不可变版本 —— 内容寻址原件 + 每材料版本链

存储（迁移 **0008**；0009/0010 预留，登记于 `coordination/d4/README.md`）：

| 表 | 键 | 职责 |
|---|---|---|
| `materials` | `material_id` | 身份与标题；**文件名不是身份**（charter §3.1） |
| `material_blobs` | `content_hash`（原件字节 SHA-256） | 内容寻址原件存储；同字节全局一份；不同内容同名文件 hash 不同 ⇒ 不会错误去重 |
| `material_versions` | `version_id`；`UNIQUE(material_id, content_hash)` | 不可变版本：hash、parser 版本、导入时间、canonicalText、block map、状态 |
| `tree_material_links` | `(tree_id, material_id)` | 一树多材料、一材料多树；讨论/Return/运行按 Tree 隔离 |
| `tree_material_reading_state` | `(tree_id, material_id)` | 阅读位置按 Tree×材料持久化（charter §3.2 阅读与探索各自保留位置） |

- 同材料重复导入相同字节 → `UNIQUE` 命中，复用版本；内容变化 → 新版本，**不覆盖**旧摘录、批注与 Branch 来源（charter §3.1）。
- `parse_status ∈ pending | parsing | ready | failed | canceled | unsupported | rejected`；`unsupported/rejected` 在导入判定时即终态；解析可取消，迟到结果不挂到已离开的目标（沿用 D3 术语任务纪律）；失败不产生「已就绪」材料。
- 支持上限（charter §5 测试边界）：单文件 20 MiB、文本 PDF 200 页、单材料 canonical 100 万 UTF-16 单元——**在耗尽资源前明确拒绝**。
- 导入与索引全本地；不自动调用模型，不自动把整份材料发给模型（charter §3.1）。
- **canonical text 契约由解析器产生**（Markdown：`d4-md-v1` 源归一化——BOM 剥离、行尾归一 LF、无 Unicode 归一化、无 HTML 剥离；PDF：`d4-pdf-v1` 页阅读序），模型不计算坐标或偏移；block map 是对 canonicalText 的有序连续覆盖。

## 4. 决策三：运行起点 —— 独立 session，显式材料上下文，树内幂等首问

charter §3.3 留给本 ADR 的问题：材料建枝的首个 Run **复用树内有效运行/session，还是创建独立 session**？

**决策：创建独立 session。**

理由：

1. 材料 Branch 建枝时不存在任何真实历史 Turn。「复用」必然把未请求的历史带入上下文或伪造延续性——违反 charter §3.3「不制造假的历史回答」与 W1 无假历史纪律。
2. 既有新枝流程（原回答选区建枝、术语②推广）本来就是新 episode + 新 run + 新 session；材料入口复用同一 Branch/Origin/Run/Return 服务底层（charter §3.3），行为应一致，而不是新造一套。
3. 「同来源恢复已有探索」= 打开该来源已存在的 Branch，其 session 正常续聊；「显式另开」= 新 Branch + 新 session。Branch 之间永不共享 session（既有不变量）。

**首问构造（显式运行起点）**：

- 组合上下文 = 选区摘录 + 有界邻近块 + 材料标题与版本标签；确定性上限（首版 **24,000 UTF-16 单元**），超限截断并在组合文本与 UI 两处显式标记（charter §3.3「超长上下文有确定上限和截断提示」）；
- 用户 Turn 携带可审计前缀 `[exploration from material <标题> v<版本>]`（对齐 `NEW_EXPLORATION_TURN_PREFIX` / `TERMINOLOGY_PROMOTION_TURN_PREFIX` 模式，DB 可查、不冒充历史）；
- UI 在提交前说明本次使用的材料范围；
- 模型调用走既有受控配置、Run 与 ToolPolicy，无新调用路径。

**首问幂等（提交意图身份）**：沿用 Return `idempotencyKey` / 术语 `promotionKey` 的树内唯一模式——材料首问意图键 `UNIQUE(tree_id, intent_key)`：双击、响应丢失重试、进程重启重放同一键 → 同一 Branch、至多派发一次首问；同键不同内容 → 409。保存批注不自动建枝；浏览/搜索不创建 Turn（charter §3.3）。

**缺 session**：走 W1 §3.4 整树新探索既有语义（显式确认、新 session、可审计标记）；材料原文揭示与旧快照阅读不受 session 缺失影响。

## 5. 测试义务（说明并测试）

charter 要求本 ADR 的决策「说明并测试」。以下测试落在 D4-1/D4-3 的包内测试与验收脚本；验收前不得宣称通过：

1. **来源判别**：material Branch 读模型返回 material 来源；turn Branch 行为不变；trunk `origin_kind='none'`。
2. **材料来源验证纪律**：切片不等/越界/块不匹配 → 拒绝；非 `ready` 版本建枝 → 拒绝并给原因；材料来源无 `piEntryId`。
3. **版本不可变**：同字节重导复用版本；改版产生新版本且旧锚点/摘录/批注不变；同名不同内容不去重。
4. **独立 session**：材料 Branch 首个 run 的 sessionId ≠ 库内任何其他 run 的 sessionId；首个用户 Turn 之前不存在任何伪造历史 Turn。
5. **首问幂等**：响应丢失、双击、进程重启三路径重放同一 `intent_key` 不重复建枝/首问；同键不同内容 409。
6. **上下文上限**：超长选区触发截断标记与 UI 提示。
7. **负例状态**：加密/损坏/无文字层/超限材料得到明确 `rejected/unsupported` 状态，不是成功空文档（B1 负例集）。

## 6. 影响

- `packages/contracts`：新增 `src/material.ts`（纯类型增量，登记于 D2 契约治理记录）；`product.ts` 既有形状不变。
- `packages/persistence`：0008 新表；已交付迁移不动；迁移号在 `coordination/d4/README.md` 统一登记。
- `apps/studio`：材料 API、阅读区与建枝入口按 `docs/d4/D4-contracts.md` 实施；批注保存维持**显式保存**纪律（auto-save 保持关闭，与术语批注同一冻结纪律，除非负责人批准开启）。
- 不以 D4 为由重写运行时或前端框架（charter §4）；Pi SDK 边界不动。
