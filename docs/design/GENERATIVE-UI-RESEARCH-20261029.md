# TreeAI Generative UI 调研与实施建议

调研日期：2026-10-29。代码阅读基线：`35ae4a012fd6beea0b66b9bb773dbe858dfedc45`。本文是后续能力提案，不修改 W1 v3 签署语义、不扩展现有 D4 验收范围。

> 实施记录：[第一版概念对比卡](GENERATIVE-UI-IMPLEMENTATION-20261029.md)。下文保留调研时的方案；实际交付范围、简化项和验证边界以实施记录为准。

建议把 Generative UI 用于支线里的比较、练习和推演，让用户通过操作形成理解，再把自己确认的收获带回主线。第一步做一个有来源的概念对比卡，验证它是否优于普通文字回答；随后再加入自测与收获整理。模型选择表达方式和内容，TreeAI 掌握来源、布局约束、操作权限和持久化。

## 1. 调研得到的技术边界

Generative UI 可以有不同程度的生成自由。对 TreeAI，最重要的区别是：模型决定哪些内容用什么交互表达，以及宿主能否验证、恢复这些表达。

| 路线 | 官方资料说明的能力 | 对 TreeAI 的判断 |
| --- | --- | --- |
| 固定组件与模型结果绑定 | Vercel AI SDK 的例子把工具结果交给预写组件呈现 | 适合第一步。可沿用这个模式，原生 DOM 也能实现，不必引入示例中的 React 或替换 Pi。[官方说明](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces) |
| 声明式组件目录 | A2UI 用数据描述界面，由客户端的组件目录渲染；截至调研日官网标记 v0.9.1 为 current、v1.0 为 candidate | 借鉴组件白名单、版本和动作边界；第一版只做 TreeAI 自己需要的窄契约。真正需要跨客户端互通时再评估标准适配。[官方说明](https://a2ui.org/) |
| 目录与渲染器框架 | json-render 提供 catalog、schema、registry 与多种渲染器 | 是具体工程参考。是否引入 core 应由原生前端适配量与依赖成本决定，不能把框架宣传的可预测性当作模型输出总是合法的证据。[源码与文档](https://github.com/vercel-labs/json-render) |
| Agent 与 UI 事件连接 | AG-UI 负责 Agent 与前端的事件通信、状态与交互 | 与 UI 内容描述不是同一层。TreeAI 已有 HTTP/SSE，首版不需要为显示一张卡替换通信层。[官方说明](https://docs.ag-ui.com/introduction) |
| 可嵌入工具应用 | MCP Apps 将工具关联的 HTML 资源放在受宿主控制的 iframe 中，通过消息协议交互 | 适合后续接入第三方交互工具。它本身不意味着界面由模型实时生成，也不替 TreeAI 处理来源与保存规则。[官方说明](https://modelcontextprotocol.io/extensions/apps/overview) |
| 直接生成交互程序 | Google Research 展示了按问题生成界面、工具和模拟的能力 | 长期值得探索，但自由程序的事实正确性、可操作性、隔离与长期重放成本更高。[研究介绍](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/) |

这些路线可以组合，不需要一次全部引入。上述选型是结合 TreeAI 现状的判断，不是各项目对 TreeAI 的适配承诺。正式接入外部协议前应固定具体版本，重新验证候选版与稳定版兼容性。

学习场景的启发也需要区分证据强弱。Google 2026-09 的 learning interactives 工作强调学习目标、提示、逐步反馈、事实与交互校验，并由教师审核公开内容；其教师评价支持可用性探索，不能直接证明 TreeAI 用户的长期学习效果。2025-11 的通用 Generative UI 研究在描述用户偏好时明确排除了生成速度。因此我们的实验必须把等待时间算进去，并测理解与来源判断，而不能只测“好不好看”。[教育研究](https://research.google/blog/the-future-of-practice-enabling-teachers-to-create-learning-interactives-with-generative-ui/)、[通用研究](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)

## 2. 从 TreeAI 的产品出发

TreeAI 的基本动作是：带着问题阅读自己的材料，从一个确切出处展开探索，再显式 Return 有价值的理解，之后还能找回并继续。材料服务于问题，数据库保留劳动成果。当前界面一次显示一个 Episode，并已有依据真实 Branch 父子关系绘制的 Session 关系视图。[产品入口](../../README.md)、[D4 产品目标](../d4/D4-project-v1.md)、[Session 工作区](SESSION-WORKSPACE.md)

据此，Generative UI 应服务三个问题：

1. **我能辨别了吗？** 把容易混淆的概念变成可按维度比较、可回看依据的对比卡。
2. **我真的理解了吗？** 用一道判断题、一个反例或预测任务暴露理解缺口，然后允许继续探索。
3. **我带回了什么？** 用户选择结论、保留条件、修改表述，形成自己的 Return。

这里真正值得生成的是比较维度、例子、练习与反馈，以及合适的组件选择。折叠、切换、选中、定位来源等行为应该由确定性代码完成。若固定表格已经同样有效，就只保留固定表格，无需追求生成自由度。

产品的稳定部分包括森林导航、当前 Tree/Branch、材料阅读器、轮次翻页、输入框、来源状态、保存状态和模型设置。模型不能重新排列这些控制，也不能把“生成了一张卡”标成“用户已掌握”或“主线已采用”。

## 3. 场景优先级

| 场景 | 具体交互 | 用户价值与主要代价 | 建议 |
| --- | --- | --- | --- |
| 概念对比 | 对比维度、并列解释、例子、来源展开、勾选结论 | 与阅读和探索直接相关；固定结构容易验收 | 第一个纵向实验 |
| 收获整理 | 从当前支线选择结论，编辑“结论／条件／待确认问题”，写入现有 Return 草稿 | 能形成产品闭环；必须保留人的显式提交 | 首个实验只做本地勾选与编辑，模型整理后续加入 |
| 理解自测 | 先回答，再看依据与反馈；答错可带着问题继续当前支线 | 能验证理解；题目歧义和模型答案质量需要独立评测 | 第二阶段 |
| 机制推演 | 调整受控参数，观察示意图或结果变化 | 适合反馈、概率、增长等机制；需验证公式、单位、边界与假设 | 第三阶段，先做已验证计算模板 |
| 论点与证据关系 | 把用户选定的已保存事实编排成关系图，点节点回到来源 | 适合较长探索；模型推断的逻辑边与真实 Branch 父子关系必须分开 | 后续实验，不新增全局画布 |
| 跨材料比较 | 用户明确选择材料范围后比较多个版本/来源 | 潜力大，但会增加上下文、引用与检索质量负担 | 单来源闭环通过后另立范围；不自动跨材料推理 |
| 自动改写全站布局 | 随模型回答移动导航和控件 | 学习成本与状态恢复成本高 | 当前不采用 |

优先级依据是与核心任务的距离和验收成本，不是已测出的用户收益排名。

## 4. 第一条完整体验

以“正反馈和负反馈有什么区别”为例，示例内容只用于说明交互，不是来自用户材料。

1. 用户从材料选区进入支线，得到原有文字回答。
2. 点击回答旁的“对比一下”。提交前显示将使用的回答、选区及必要邻近文本；不自动发送整份材料，也不自动读取其他 Tree。
3. 得到一张对比卡：比较维度为“变化方向、典型例子、常见误解”。每个有依据的条目可展开对应摘录，模型推断另行标识。
4. 用户切换维度、查看来源、勾选有用的结论；这些操作本地完成，不消耗新的模型请求。
5. 点击“整理为收获”，把所选内容填入现有 Return 草稿，允许编辑；有旧草稿时追加或明确替换，不能静默覆盖。
6. 用户仍通过现有“确认 Return”完成提交。保存、导航和采用沿用现有状态机；卡片不直接写入 Return，不自行宣称已经采用。
7. 隔天打开，同一对比卡从已保存的结构化结果重放。Pi session 不可用时卡片、来源快照和 Return 仍可读。

首版建议限制为单个 Branch、一个显式触发入口、一个 ComparisonCard 类型，至多 3 个概念、6 个维度。数值是初始产品上限建议，需在实验中调整。显示方式固定，内容按问题生成；以后再允许模型从对比、自测、文字三种表达中选择，并保留文字退路。

## 5. 实现设计

### 5.1 延续现有架构

```text
用户显式请求“对比一下”
  → Studio 校验 Tree/Branch/来源和上下文范围，创建生成任务
  → 预算预留与串行派发
  → 独立的辅助执行器调用现有 runtime-pi
  → 对完整结果做 schema、来源、大小与动作校验
  → TreeAI DB 保存 artifact 快照
  → SSE 通知 + HTTP 读取
  → 原生 DOM 的 ComparisonCard 渲染器
  → 本地操作 / 原来源定位 / 填入现有 Return 草稿
```

代码有两个值得复用的基础：已有 [Studio 事件投影](../../apps/studio/src/studio/event-observer.ts)，以及带隔离 runtime、排队、预算预检、取消和未知费用纪律的 [术语执行器](../../apps/studio/src/terminology/executor.ts)。后者是设计参考，不能直接把 GenUI 任务塞进术语账本或更改其已验收的用途分类。

**模型调用路径选择：** 第一版用专用辅助执行器、独立 PiRuntime 实例和受控 session 目录，复用同一个 Pi 适配器与配置方式。它与现有术语隔离方式一致，不引入第二种 runtime 或 Agent 框架。不可把 JSON 生成请求塞入主对话活跃 session，也不可共用术语执行器的活跃实例：每个 PiRuntime 只有一个活跃会话和一个在途 run。这样避免 UI 生成移动用户的 Pi 游标、被错计入对话 Episode，或因取消而打断用户追问。[运行时契约](../../packages/contracts/src/pi-runtime.ts)、[已有实例组装](../../apps/studio/src/index.ts)

当前 `PiPromptResult` 只有 `message` 和 `reference`。P0 可以对辅助调用的完整 message 解析限定 JSON，不假设 Pi 已有原生 UI 事件或所有提供方均支持 structured output。非法结果不得执行；不直接拿原始 JSON 作为普通回答给用户。用户仍能阅读生成前的原回答，并看到明确失败及手动重试入口。

### 5.2 两类契约

模型输出只含内容；归属和权限由服务端生成。建议区分：

```ts
// 示例草案，不是现有导出类型。
type GeneratedComparison = {
  kind: "comparison";
  title: string;
  concepts: { key: string; label: string }[];
  rows: {
    key: string;
    dimension: string;
    cells: { conceptKey: string; text: string; sourceKeys: string[] }[];
    takeaway: string;
    basis: "source-based" | "model-inference";
  }[];
};

type UiArtifactEnvelope = {
  artifactId: string;
  treeId: string;
  branchId: string;
  anchorTurnId: string;
  generationTaskId: string;
  revision: number;
  schemaVersion: number;
  catalogVersion: string;
  contextHash: string;
  document: GeneratedComparison;
  sourceBindings: ValidatedSourceBinding[];
  fallbackText: string;
  createdAt: string;
};
```

这里的 `ValidatedSourceBinding` 指服务端解析并验证的现有 Turn/Material 来源身份、区间、摘录与版本信息，正式类型应复用现有契约。模型只得到 `s1/s2` 这样的上下文内引用键；不能给自己生成 treeId、versionId、offset 或可执行动作。校验还要检查概念键唯一、单元格对应、引用键存在以及大小上限。类型正确仅证明结构正确，不证明结论被来源支持。

生成任务拥有自己的 taskId、派发记录、状态和费用记录；不伪造普通对话 Run、Turn 或 Pi entry。`anchorTurnId` 是卡片展示所依附的已保存回答，而不是声称生成卡片就是这条回答。候选 schema 中的字符串 ID 应在正式实现中使用 contracts 的品牌类型。

**动作从固定组件定义中产生。** 展开、勾选、筛选是本地动作；揭示来源交给现有来源解析；填入收获只改客户端草稿。后续“继续追问／从原出处开枝”必须走现有服务，并再次核验当前 Tree、来源、session 与幂等身份。客户端显示按钮不代表服务端授权。

### 5.3 原文与 UI 分层

现有 [conversation.js](../../apps/studio/public/core/views/conversation.js) 和 [turn-overlays.js](../../apps/studio/public/core/views/turn-overlays.js) 依赖原文身份、绝对 UTF-16 区间以及选择期间 DOM 稳定。

因此生成卡片应作为独立兄弟区域，挂在所属回答之后。不能把卡片文字插进原文选区根节点、改写 `turn.text`，也不能把图中节点坐标当作材料偏移。完成挂载还要保留正在选择的 Range、键盘焦点、轮次与滚动位置。

P0 不提供“直接从生成卡片任意选文建枝”：卡片是派生表达，其文字不是原材料。用户可以回到已绑定的原出处建枝，或编辑问题继续当前支线。如果后续需要从卡片文字创建来源，必须新增独立来源类型和持久身份，不能冒充原文锚点。

### 5.4 存储、回放与恢复

- 在 TreeAI DB 中独立保存生成任务与 UiArtifact；模型生成的内容标记为生成结果，不视为用户确认或 Return。
- artifact 使用不可变 revision；重新生成创建新 revision，保留旧快照，避免用户选中的结论被后台替换。
- 预算/派发和产物保存都有恢复点。相同 `(treeId, intentId)` 重试返回同一任务；同意图不同内容应冲突。请求已经发出但进程中断时记为结果/费用待核对，不自动重发，不能承诺上游模型“恰好调用一次”。
- P0 只在完整结构校验、保存成功后挂载。SSE 是通知，不是唯一事实源；断线通过 GET 获取任务状态和持久快照。
- 后续如引入增量 UI，事件至少带 artifactId/revision/sequence，拒绝旧版本与乱序写入；半成品显示加载状态，不成为可提交结论。
- `fallbackText` 从通过校验的结构确定性生成，支持旧渲染器与 Markdown 导出。未知组件版本退回文字，不静默调用模型“恢复”。
- 新的已保存产物必须进入导出包 schema、清单、校验及恢复验证。可读导出含文字与来源，不能只存截图或 iframe URL。
- 首版通过所在回答找回 artifact，不默默改变既有全文搜索的结果分母；后续索引需要独立可重建投影及独立验收。
- 未提交 Return 草稿继续遵守客户端草稿规则。卡片 UI 的展开/勾选状态可按 artifactId+revision 存本地，但它不等于已保存的产品收获。

### 5.5 费用与安全边界

显式触发才生成；页面打开、滚动、翻页、展开依据、勾选结论均零模型派发。复用已保存结果不重新生成。重新生成明确为新的计费请求；缓存键包含 Tree、来源/版本、contextHash、模型、提示与 schema/catalog 版本，避免跨树复用。

参考术语已有纪律实现独立的 GenUI 预算预留、派发前持久标记、完成结算、取消/超时未知费用及重启恢复。第一版不做自动多轮修复。实际 token/费用可取得时据实记录；无法取得时区分字符估算与未知费用，不伪称精确计费。全应用若没有统一预算机制，不能把 GenUI 自己的额度上限标为全局总额度。

仅渲染固定 DOM 组件；字符串按文本处理，不接受模型 HTML/JS、事件处理器、任意 URL、CSS 或计算表达式。来源材料即使包含指令也仅是待分析数据。服务端重新验证动作归属和来源，拒绝跨 Tree ID、过期 revision、超大结构及未知 action；沿用现有 loopback HTTP 的请求防护并审计新端点。模型工具保持 default-deny。

未来的模拟器先选已验证的公式模板，模型仅填参数、标签和解释。若再开放自由程序，则作为隔离实验单列 iframe sandbox、CSP、网络/存储/资源限制与消息白名单；这些不能被“用了某个 UI 协议”替代。

### 5.6 文件级工作拆分

以下新增路径均是建议，并非已实现文件。

| 所属层 | 建议改动 | 验收重点 |
| --- | --- | --- |
| `packages/contracts/src/` | 新增 `generative-ui.ts` 与公开导出 | 内容 schema、服务端包络、任务状态；不引入 Pi 类型 |
| `apps/studio/src/generative-ui/` | service、executor、prompts、validation | 上下文范围、预算、幂等、取消、解析与来源校验 |
| `packages/persistence/src/` | 新增任务与产物仓储和协调后的迁移 | Tree 外键、revision、派发恢复、重启可读 |
| `apps/studio/src/http/routes/` | 新增生成任务/产物读取/取消端点 | 归属与请求校验，错误与重试语义 |
| `apps/studio/public/core/` | controller、view、组件目录和实例状态 | 原文节点隔离、轮次归属、焦点/滚动、Return 草稿 |
| Studio 组装与事件 | `src/index.ts`、`core/compose-features.js` 等 | 隔离执行器生命周期，监听清理，终态补读 |
| 导出/恢复、静态服务、安装器 | 新资产与 schema 接线 | 静态 allowlist、资源打包、备份恢复无遗漏 |

保持五个核心包，Node/npm 与依赖锁文件不因本提案升级。HTTP 路径、迁移编号在正式开工时确定；不为一张卡引入通用页面编排引擎。

## 6. 分阶段交付与停止条件

| 阶段 | 范围 | 完成后能回答的问题 |
| --- | --- | --- |
| A 体验实验 | 固定示例内容，对比卡可展开依据、勾选、编辑收获；与普通文本/表格比较 | 交互本身是否有用？哪些操作多余？ |
| B 工程纵向闭环 | 单卡类型，真实 Pi 手动生成、验证、保存、重启、来源、Return 与导出恢复 | 能否在 TreeAI 的事实和状态纪律下可靠运行？ |
| C 表达选择实验 | 加入自测与模型整理，允许在小目录内建议形式，保留用户控制 | 模型选形式是否优于用户手选与固定模板？ |
| D 更丰富表达 | 经验证模拟模板、用户选定材料的比较；需要时再做协议适配 | 更复杂的生成自由是否带来足够收益？ |

不按未经验证的人日承诺工期。B 完成后先验证效果，再决定 C/D；不把“支持更多组件”当成进度目标。

建议新增一个与旧冻结集分开的评测集：20 个固定任务，包含双概念对比、信息不足、来源冲突、长文本与 Unicode，以及无需 UI 的简单问答。先冻结问题、来源与人工判断标准，再调提示；按提供方/模型记录完整分母。20 个只是首轮样本规模建议，不表示统计有效性或已运行结果。

三种条件分开比较：普通文字/Markdown 表格、固定对比卡、模型选择/组织的 UI。第一阶段使用相同内容检验交互价值，第二阶段才比较端到端生成质量。记录完成时间（含生成等待）、理解题表现、原文定位正确性、完成一条经编辑 Return 的情况、误引/歧义、失败/重试率与请求量。点击数、停留时间和 Return 数量只是辅助指标。

功能硬门槛：错误来源定位为零、跨树动作接受为零、重复提交不重复保存、session 丢失不影响保存产物可读、非生成操作零模型派发、取消与迟到结果不污染当前界面。用例还需覆盖断流、重启、响应丢失、未知 schema、来源版本变化、恶意字符串、超大结果、用户选文期间挂载，以及材料/对话来源的差异。

真实模型的结构通过率、延迟和费用应先测基线，再约定发布阈值；不能现在填一个百分比当成产品性能。若固定卡片已经同样有效，停止增加生成布局自由；若等待与认知负担抵消收益，则保留文字为默认入口。

正式实现后按影响范围先运行聚焦检查，再执行 `npm run typecheck`、`npm test`、D2/D4 verifier 与各自 selftest。新测试保留顶层 aggregator，避免非递归测试 glob 漏跑；浏览器、真实 Pi、安装包与目标平台分别记录。旧冻结夹具、分母、人工门禁和已知 BLOCKED/NOT_RUN 均保留。[测试要求](../development/testing.md)、[当前验收状态](../acceptance/status.md)

本轮只完成资料调研、代码阅读与方案设计；没有执行生产功能实现、模型质量评测或项目验收。下一步最小实施范围已经具体化：**单支线的 ComparisonCard，带真实来源、可编辑收获和重启可读能力。**
