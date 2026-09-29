# W2 高保真原型：状态清单与动效分镜

> **来源与地位**：权威的前端设计总体方案（高保真视觉稿、状态与动效规范）
> 位于**仓库外**的负责人交付夹，不入仓。本文档是依据 GitHub issue #2
> 《D3 验收：Gate 2 No Go 与修订方案》（2026-09-29）P1「视觉与试用」要求
> 整理的**仓库内可执行清单**，用于驱动实现与验收对齐；**W2 签收前由负责
> 人将本清单逐项对照交付夹源设计**。本文不代替源设计、不构成 W2 通过，
> 状态记录以 `docs/d3/D3-status.md` 为准。
>
> **状态列口径（2026-09-29 逐行同步）**：下行 §1–§4 全部状态行已对照
> commit `56f8c31` 的实际代码逐行重写——不沿用旧表的自述（issue #5 指出
> 大量行仍写「旧形态/未开始」，与顶部更新记录不符），以代码为准。「已实
> 现」一律读作**「待 owner 验收」**：对照源设计与实机口径签收之前不构成
> 满足 W2。除非行内特别注明，所有「已实现 / 部分」行的**通用待人工项**
> 是同一组：录屏逐屏对照源设计（含窄窗 <720px、键盘焦点、
> `prefers-reduced-motion` 实机抽查，见 §5）；行内「待人工项」只列该行
> 特有的增量。实现路径中的行号以 `56f8c31` 为准（文件会继续演进，锚点
> 以函数/选择器名为主）。

## 更新记录

- **2026-09-29 · issue #5 逐行状态同步（本条）**：按 D3 验收 review P0
  要求，把 §1–§4 每行改写为 状态 / 实现路径 / 自动证据 / 待人工项 四列，
  全部对照 `56f8c31` 实际代码核实（非沿用旧表或更新记录自述）。同步
  结论：§1 四项原则、§2.2–§2.8 各屏的目标形态、§3 M1–M7、§2.4 持久草稿
  均已落地（旧表大量写「未开始/旧形态」已过时）；仍为缺口/偏差的是：
  §2.1 列表加载失败无重试按钮、初始焦点未编程设定、新建按钮非全宽；
  §2.4 409 无专属引导文案、错误横幅无朗读语义（无 tabindex/aria-live）；
  §2.6 降级时焦点不移到说明区、摘录为换行呈现而非源设计约定的横向滚动；
  §2.7 窄窗抽屉为右侧全宽滑入而非约定的自底向上（以上偏差待 owner 对照
  源设计裁决）；§2.6 的 UI 级揭示/高亮场景无自动断言（服务/HTTP 层有）。
  §0 状态词改为 已实现/部分/未开始（原「已落地（旧形态）」废止）。
  studio 套件实测 53/53 通过（ui-probe 8 场景 / 156 断言）。本条为纯文档
  变更，不改动代码与测试；实机/录屏/源设计对照证据仍全部归 owner。
- **2026-09-29 · issue #3 修复波次（journal/恢复/滚动纪律）**：§2.7 打开-加载
  失败态落地（journal 三态：加载中/已载/失败——失败呈现"journal failed
  to load + Retry"，不再与"无事件"混淆；Retry 即回加载态）；§2.8 恢复
  提示升级为可直接执行按钮（"⑃ Branch from latest available answer"，
  主线横幅与面板降级提示共用；无可用候选时禁用并给出原因；恢复是绕行
  不是解锁——原 fail-closed 输入禁用保持）；流式与新内容滚动纪律修正
  （48px 贴底判定——用户已向上阅读时，delta 渲染与终态重渲均不再强制
  滚底；在底部时照常贴底；首次打开仍直接落底）。78/78 探针断言 +
  367/367 测试通过。仍属 owner 待验收（实机/录屏口径不变）。
- **2026-09-29 · `6ff7146`**：§2.5 流式推送（SSE `/events`：snapshot +
  run-started/message-delta/abort-requested/run-terminal/tool-activity，
  EventSource 替代轮询、断流降级轮询）、§2.7 来源抽屉（per-run 出处 +
  Return 出处 + journal 尾部 `/journal` + 如实空态）、§2.8 缺失 session
  降级（服务端 `sessionAvailability` 实时探针 + 分支 tab 徽标 + 常驻面板
  提示 + 续聊入口 fail-closed 禁用 + 主线可 dismiss 横幅）已按实现口径
  落地；事件与 journal 端点的自动化测试见
  `apps/studio/tests/events.test.ts`。
- **2026-09-29 · `d061b5f`**：主线阅读 + 局部支线改版落地（实现口径）——
  主阅读面板恒为 Trunk；支线以锚点作用域的右侧覆盖层面板打开（开合与
  转场期间主线阅读位置不动）；面板头部固定「View source / Back to
  Trunk」操作；锚点 Return 卡（M3 插入 / M4 徽标动效 + deliveredRunId
  反查入口）；Return 草稿 localStorage 持久化（W1 §2.1 客户端语义）；
  每分支滚动位置恢复；键盘焦点管理（面板入焦/Esc 逐层关闭并还原焦点）；
  M1–M7 动效与全局 `prefers-reduced-motion` 降级（流式 caret 改为静态
  指示）；窄窗 <720px（面板/抽屉全宽、侧栏抽屉、状态条压缩）。实现取舍：
  面板为覆盖层而非推挤（保证主线不动）；origin banner 内容并入面板头部。
  上述项的状态应读作「待 owner 验收」；**录屏逐屏对照、窄窗实机、
  屏幕阅读器检查仍为 owner 手动步骤**（含 §4 目标 Mac 完整操作）。

## 0. 状态词

| 状态 | 含义 |
| --- | --- |
| 已实现 | 已按目标形态实现，有代码路径与自动证据；**读作「待 owner 验收」**——对照交付夹源设计与实机口径签收之前不构成满足 W2 |
| 部分 | 部分实现：行内注明已实现面与缺口；缺口可能是待实现项，也可能是与源设计约定的偏差（待 owner 裁决） |
| 未开始 | 未开工 |

原「已落地（旧形态）」状态随 `d061b5f` 主线阅读改版落地而**废止**——旧
表中使用该状态的行已全部按现行实现重写，不再出现。

## 1. 目标交互模型（issue #2 P1）

| 原则 | 含义 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 主线阅读 + 局部支线 | 主阅读面板始终跟随**主线**（Trunk / 当前主分支）；支线以**锚点作用域的局部侧板**打开，不做整页 tab 切换 | 已实现 | `app.js` `state.panelBranchId`（L75）+ `renderMainConversation()` 恒渲染 Trunk（L653）+ `openBranchPanel()`/`closePanel()`（L1313/L1346）；tab 点击 = 开面板而非换视图（`renderBranchTabs` L317–325）；面板为右侧覆盖层：`index.html` `#branch-panel`（L51）、`style.css` `#branch-panel` `position:absolute`（L329–342）；服务端游标对齐仍走 `POST /switch` | ui-probe「visual baseline…」（面板必需 id/aria 各恰一次）、「branch panel degradation…」（tab 点击 → 面板打开 + `/switch` 恰一次）、「Esc on the branch panel…」 | — |
| 固定来源 / 回程 | 来源（锚点出处揭示）与回程（回主干）操作**固定位置常驻**，不随滚动 / 切换消失 | 已实现 | `index.html` `#panel-fixed-actions`（⌖ View source / ↩ Back to Trunk，L57–60）；`style.css` `#panel-header` 为面板头固定区、不随内容滚动（L355–363）；`app.js` `revealOrigin()` / `closePanel()` | ui-probe「visual baseline…」（`#panel-header`、`#panel-fixed-actions` 结构断言） | 实机确认滚动/转场期间常驻可见 |
| 锚点 Return 卡 | Return 卡渲染在其 `targetAnchor` **原分叉点附近**（见 W1 §2.2），不是孤立列表项 | 已实现 | `app.js` `renderTurnsInto()` 按 `targetAnchor.anchorTurnId` 把 Return 卡排在锚点答案之后（L536–550、L615–619）+ `returnCard()`（L451）；锚点不在当前视图 → 原位降级标注（L553–556） | ui-probe「visual baseline…」（`r0` 紧随 `a1` 渲染、meta 含摘录与 confirmed 徽标）、「return flow…」（`r-1` 紧随 `a2`）；service.test.ts「return persists its target anchor snapshot of the branch origin」 | 对照源设计的卡片样式 |
| 状态转场克制 | 转场明确而克制，**减少动态效果**；全部动效有 `prefers-reduced-motion` 等价物 | 已实现 | 动效仅 M1–M7（见 §3）：`style.css` 时长变量（L14–16）+ 全局 `prefers-reduced-motion` 即时化块（L551–561）；JS 侧 `prefersReducedMotion()`/`scrollBehavior()`（`app.js` L148–153）；streaming 指示为静态 caret（L630–634；`style.css` L304–306 无循环动画） | ui-probe「visual baseline…」断言 caret 存在与占位形态（静态类名）；**动效时序与 reduced-motion 实效无自动断言**（桩 `matchMedia` 恒 false、CSS 不参与桩求值） | reduced-motion 开关实机对照；逐动效对照源设计 |

## 2. 逐屏清单

每屏枚举：用途 / 状态（含空、错误、降级变体）/ 转场 / 数据来源（API）/
键盘焦点顺序 / 窄窗（<720px）/ `prefers-reduced-motion` 变体，并给出
该屏状态。

### 2.1 空状态 / Tree 列表

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 首次进入引导建树；既有树的选择与打开 | 已实现 | `index.html` `#new-tree` / `#tree-list` / `#empty-state`（L15–23）；`app.js` `renderTrees()`（L261）、`createTree()`（L1288）、启动 IIFE 自动打开首棵树（L1888–1899） | ui-probe「visual baseline…」（自动打开首棵树、树视图可见）；api.test.ts「HTTP API serves the UI and the full D3 flow…」（GET/POST `/api/trees`） | — |
| 状态 | 空库（无任何 Tree → 引导文案，"新建"为唯一主操作）；列表（非空，显示可区分的树标识）；加载失败（错误条 + 重试，不空白） | 部分 | 空库与列表已实现（同上行）；加载失败为**通用错误横幅**（`showError()`，L189–196，8 秒自动隐藏；启动/开树失败经 guard 呈现）——**无专门"重试"按钮**，重试 = 刷新页面或重选树 | 列表/空库见上行；加载失败**无自动 UI 断言**（ui-probe 未脚本化列表请求失败） | 断网/后端失效场景实机验证；是否补重试按钮待 owner 裁决 |
| 转场 | 新建成功 → 进入主线阅读（无过场动画或仅透明度） | 已实现 | `createTree()` → `renderAll()` 即时重渲，无过场动画（符合"无过场动画"的克制口径） | ui-probe 各场景经同一渲染路径（间接） | 录屏确认 |
| 数据来源 | `GET /api/trees`；`POST /api/trees` | 已实现 | `app.js` `refreshTrees()`（L1252）、`createTree()`（L1288） | api.test.ts 主流程 + 「HTTP layer rejects malformed bodies…」（404/405 映射） | — |
| 键盘焦点顺序 | 初始焦点在"新建"；Tab 序 = 新建 → 列表项（Enter 打开） | 部分 | Tab 序天然符合 DOM 序（`#new-tree` 在列表前，均为原生 button，Enter 即激活——`index.html` L15–16）；**初始焦点未编程设定**（启动后焦点在 body，非"新建"按钮） | 无自动断言 | 键盘实机核查；是否补初始焦点待 owner 裁决 |
| 窄窗 <720px | 列表单列，主操作按钮全宽 | 部分 | 列表单列天然成立（`ul/li`）；树侧栏收进抽屉 + 顶部开关（`style.css` L521–534；`app.js` `closeSidebar()`/侧栏开关 L1817–1825；`index.html` L11，含 `aria-expanded`）；**"新建"按钮未设全宽**（无 `width:100%` 规则） | 无自动断言（样式面） | 窄窗实机；全宽口径待 owner 对照源设计 |
| prefers-reduced-motion | 列表更新即时呈现（无进入动画） | 已实现 | 列表更新本无动画（`replaceChildren` 即时重渲）——按构造成立；全局降级块兜底 | 无专属断言 | 实机抽查 |

### 2.2 主线阅读（Trunk 主视图）

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 主线（Trunk / 当前主分支）的连续阅读与对话；所有支线从这里分出、回到这里 | 已实现 | `renderMainConversation()` 恒渲染 Trunk（L653–666）；`#main-pane` 常驻（`index.html` L39–48） | ui-probe「visual baseline…」+「streaming scroll discipline…」 | — |
| 状态 | 空 Trunk（无 turn → 引导首个 prompt）；正常阅读；prompt 在途（输入锁定 + 运行状态条）；prompt 失败（错误条 + 失败码，输入解锁可重试）；aborted（如实呈现 aborted 终态，非失败） | 已实现 | 空 Trunk 文案（`renderTurnsInto` L525–533）；在途锁定 `updateComposerLocks()`（L216–228）+ 流式占位（L622–636）+ 运行状态条 `renderDiagnostics()`（L883–933）；失败 = 常驻失败面板（`renderFailurePanel` L936–955，不自动消失、可 dismiss）+ 错误横幅 + 输入解锁；aborted 终态独立着色（L910–915；`style.css` `.last-run-state.aborted` L176–178） | 在途/失败/aborted 的服务与 HTTP 面已测（api.test.ts「diagnostics and abort endpoints…」、events.test.ts「model error injection…」「abort over SSE…」）；UI 级失败面板/空态无直接断言 | 实机逐状态变体操作（空/在途/失败/中止） |
| 转场 | turn 追加即时；在途 → 终态仅改状态指示器（见 2.5） | 已实现 | turn 重渲即时（`renderTurnsInto` `replaceChildren`）；在途→终态仅改 `#run-status` 与失败面板（M5） | ui-probe「streaming scroll discipline…」（占位 → 终态权威刷新，间接覆盖） | 录屏确认 |
| 数据来源 | `GET /api/trees/:treeId`；`POST /api/trees/:treeId/prompt` | 已实现 | `openTree()`（L1267）、`sendPrompt()`（L1446–1449，branchId 显式携带） | api.test.ts 主流程 | — |
| 键盘焦点顺序 | 输入框为常驻主焦点；发出 prompt 后焦点保持在输入框；Esc 不丢焦点 | 已实现 | `sendPrompt()` 收尾 `input.focus()`（L1475）；Cmd/Ctrl+Enter 发送（L1847–1858）；Esc 仅在抽屉/面板/侧栏开时拦截，主线时无操作不丢焦点（L1870–1886） | 同机制断言于 ui-probe「return flow…」（提交后焦点回 `#prompt-input`）；prompt 后焦点保持无直接断言 | 键盘实机 |
| 窄窗 <720px | 消息全宽、输入区吸底；运行状态条保持可见 | 已实现 | `.turn { max-width: 100% }`（`style.css` L542）；输入区吸底由 flex 列布局保证（`#conversation` flex:1 + `#composer`）；状态条压缩 = `#run-detail`/`#policy-note` 收起、`#run-status`（状态点 + 短词）保持（L538–539） | 无自动断言（样式面） | 窄窗实机 |
| prefers-reduced-motion | 新 turn 不平滑滚动（直接定位）；无滚动动画 | 已实现 | `scrollBehavior()`（reduce → `auto`）用于 `renderTurnsInto` 滚动定位（L643–646）与全部 `scrollIntoView`/`scrollTo` 调用点 | 无自动断言（桩 `matchMedia` 恒 false） | 实机 reduced-motion 对照 |
| 阅读位置 | **每分支滚动位置恢复**（切走再回来恢复原位，见 §4） | 已实现 | `state.scrollPositions` 按 `tree:branch` 记忆（L108–109）+ scroll 监听（L1829–1840）+ `renderTurnsInto` 恢复/贴底判定（L638–649，含 48px 贴底阈值） | ui-probe「streaming scroll discipline…」（scrollTop 50 在 stick 渲染后保持——记忆/恢复机制生效）；面板往返恢复无直接断言 | 实机切树/切分支往返 |

### 2.3 支线局部面板（branch side panel）

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 从主线某锚点分出的支线的**局部**阅读与续聊；作用域限定在其锚点，不替换主视图 | 已实现 | `openBranchPanel()`（L1313–1338，含 `alignCursor:false` 例外：建支线/揭示不预对齐）；面板渲染 `renderPanel()`（L713–722）；主线不动（覆盖层，`style.css` L329–342） | ui-probe「branch panel degradation…」「Esc on the branch panel…」 | — |
| 状态 | 打开（正常）；支线空（无后续 turn → 引导续聊）；锚点徽标 available / changed / unavailable；session 不可用降级（只读 + 恢复提示，见 2.8）；在途 prompt（面板内输入锁定） | 已实现 | 支线空文案（L525–533）；锚点徽标 `renderPanelAnchorContext()`（origin-status 三态着色，L669–687）；session 降级 `renderPanelSessionNote()`（L694–710）+ fail-closed `updateComposerLocks()`；面板内在途锁定 + 面板内流式占位（`renderTurnsInto` streaming 分支 L624） | ui-probe「branch panel degradation…」（降级提示常驻、恢复按钮、面板输入禁用） | changed/unavailable 变体实机（changed 态正常产品流不可构造，见 W1 §6） |
| 转场 | 进入侧滑/淡入 150–200ms（见 §3）；退出对称；转场期间主视图阅读位置不动 | 已实现 | M1/M2：`showPanel()`/`hidePanel()`（L1122–1158）+ `style.css` `panel-in`/`panel-out`（L344–353）；覆盖层保证主线布局与阅读位置不动 | 无时序自动断言（ui-probe 以 220ms 等待退场收尾后断言 `hidden`——结构面） | 录屏对照（转场期间主线不动） |
| 数据来源 | `GET /api/trees/:treeId`；`POST /api/trees/:treeId/prompt`（`branchId` = 支线）；`POST /api/trees/:treeId/branches`（从主线选区开支线） | 已实现 | 面板打开 `POST /switch`（`openBranchPanel` L1320–1324）；`sendPrompt("panel")`（L1440–1449）；`branchFromTurn()` POST `/branches`（L1502–1520） | ui-probe「branch panel degradation…」（tab 开 → `switchCount`+1；恢复路径不 `/switch`） | — |
| 键盘焦点顺序 | 面板打开后焦点移入面板首个可交互元素；Esc 关闭面板并把焦点还给触发元素（回到主线） | 已实现 | `focusIntoPanel()`（L1215–1238：常规 → 支线输入框；session 降级 → 恢复按钮为首个焦点，禁用时退回降级提示本身）；Esc 还原 `state.panelFocusReturn`（`closePanel` L1366–1373 + document keydown L1870–1886） | ui-probe「Esc on the branch panel…」（焦点还原到触发 tab）；降级态首焦点无直接断言 | 键盘实机（含降级态） |
| 窄窗 <720px | 面板占满主区域（推栈式）；固定来源/回程按钮保持可触达 | 已实现 | `#branch-panel { width: 100% }`（`style.css` L545）——覆盖层全宽，为"推栈式"的覆盖等价形态；固定操作在面板头不随滚动消失 | 无自动断言（样式面） | 窄窗实机 |
| prefers-reduced-motion | 进入/退出改为透明度 0↔1（无位移）或直接出现 | 已实现 | 全局降级块把 `panel-in`/`panel-out` 动画即时化（`style.css` L551–561，`animation-duration: 0.01ms`） | 无自动断言（CSS 不参与桩求值） | 实机 reduced-motion 对照 |

### 2.4 Return 草稿与提交（含锚点 Return 卡）

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 在支线上整理结论并**显式提交**回主干；已提交的 Return 卡在主干 `targetAnchor` 原分叉点附近呈现 | 已实现 | `#return-panel`（`index.html` L71–78，编辑 + 显式提交按钮）；Return 卡定位见 §1 第三行 | ui-probe「return flow…」 | — |
| 状态 | 草稿（客户端、未持久化、未生效；空 / 已编辑）；提交在途（按钮禁用 + 单飞，防双击）；导航失败（`502`，草稿保留，同键可重试）；`confirmed`（卡呈现"待送达"）；`delivered`（卡呈现送达 + `deliveredRunId` 反查入口）；`409 return-conflict`（提示内容已改，引导用新键重提） | 部分 | 草稿 ✓（localStorage + 会话内，见下"持久草稿"行）；提交在途 ✓（`updateComposerLocks` 禁用 `#submit-return` + `guard` 单飞，L216–228/L198–210）；失败保留草稿 + 同键重试 ✓（`submitReturn` catch，L1587–1603）；confirmed 待送达徽标 ✓ / delivered + 反查入口 ✓（`returnCard` L478–507，点击开抽屉定位该 run）。**缺口**：`409` 无专属引导文案——冲突经通用错误横幅呈现服务端消息；"失败后编辑即换新键"（L869–879）使同键异容在正常 UI 流不可达；另：响应丢失对账按"同键命中即按成功"处理（L1592–1596），与 409 的同键异存场景在客户端不区分（该边角经正常流不可达，owner 知悉即可） | ui-probe「return flow…」（防双击恰一次 POST、成功清草稿收面板）、「return failure semantics…」（失败保留草稿、改写换键、重试同键）；`502` 特定分支（降级提示联动）与 409 呈现无自动 UI 断言；服务端 409 语义见 api.test.ts「return idempotency over HTTP…」 | 409/502 实机呈现口径；是否补专属冲突引导待 owner 裁决 |
| 转场 | 卡插入 ≤200ms（高度 + 透明度）；confirmed → delivered 仅改卡片徽标 | 已实现 | M3 `return-insert`（`style.css` L276–281 + `returnCard` insert class 与 `MOTION_EPOCH_MS` 观测窗口 L447–467）；M4 `badge-change`（L283–288 + `seenDeliveredRunIds` 变化检测 L483–491） | 结构面：ui-probe 断言卡与徽标文案（「visual baseline…」）；动效类名/时序无断言 | 录屏对照动效 |
| 数据来源 | `POST /api/trees/:treeId/return`（`{fromBranchId, text, idempotencyKey}`）；`GET /api/trees/:treeId`（对账与渲染）；`GET /api/trees/:treeId/diagnostics`（`deliveredRunId` 反查） | 已实现 | `submitReturn()`（L1569–1611：POST `/return` → 失败时 GET `/state` 对账 `findReturnByKey` L1551）；反查经 `openDrawer({focusRunId})` + `renderDrawer` runs 列表（L1798–1805） | ui-probe 4/5（POST 载荷、对账、清除）+ api.test.ts「return idempotency over HTTP…」「response-loss resubmit and double-click…」 | 真实 Pi 送达一次验证（W1 R4 人工列） |
| 键盘焦点顺序 | 提交成功后焦点回主线输入框（回程）；冲突 / 失败提示可 Tab 触达并朗读 | 部分 | 提交成功焦点回主线 ✓（`closePanel({focus:"main-input"})` L1604 + `$("prompt-input").focus()`）；**缺口**：`#panel-error-banner`/`#error-banner` 为普通 `div`，无 `tabindex`/`role`/`aria-live`（`index.html` L41/L64）——不可 Tab 触达、不朗读 | 回程断言于 ui-probe 4/5（`activeElement === #prompt-input`）；横幅朗读语义无断言（未实现） | 朗读语义补建为后续实现项（owner 排期） |
| 窄窗 <720px | 草稿编辑与 Return 卡全宽 | 已实现 | Return 卡基础样式即全宽（`.turn.return { align-self:stretch; max-width:none }`，`style.css` L266–271）；textarea 全宽（L493–502）；窄窗 `.turn` 100% | 无自动断言（样式面） | 窄窗实机 |
| prefers-reduced-motion | 卡插入即时 | 已实现 | 全局降级块（M3 即时化，L551–561） | 无自动断言 | 实机对照 |
| 持久草稿 | 草稿跨视图切换 / 刷新保留（客户端本地存储；不进 TreeAI DB、不生效——见 W1 §2.1） | 已实现 | localStorage key `treeai-return-draft:<tree>:<branch>`（L745–749）；`readPersistedDraft`/`persistReturnDraft`/`removePersistedDraft`（L755–799，隐私模式静默降级为会话内草稿）；面板重开恢复 `syncReturnDraftForBranch()`（L817–843，空草稿不覆盖预填惯例） | ui-probe「return flow…」（持久化、携带幂等键、成功清除）、「return failure semantics…」（失败保留、改写换键、恢复） | 刷新/跨视图实机确认 |

### 2.5 Run 状态（idle / streaming / aborting + 终态）

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 如实呈现当前运行面状态与终态，提供中止 | 已实现 | `renderDiagnostics()`（L883–933）+ `abortActiveRun()`（L1480–1495，绕过 busy 锁——在途时正需可点） | api.test.ts「diagnostics and abort endpoints…」、events.test.ts SSE 套件 | — |
| 状态 | 运行面 `idle` / `streaming` / `aborting`（aborting 时中止按钮禁用）；终态 `succeeded` / `failed` / `aborted`（来自 run 行，含 failure code + message） | 已实现 | `#run-status` 三态 + aborting 时禁用（L924–926）；终态与失败码经 `#diagnostics` run 行（`RunDiagnostics` 安全投影）；aborted 独立着色（L910–915） | api.test.ts（streaming 观测、abort 200、`aborted` 终态 + `failure:null`）；events.test.ts「abort over SSE…」（abort-requested → run-terminal aborted 顺序） | 真实 Pi 中途点停止（W1 R10 人工列） |
| 转场 | 指示器状态切换 ~100ms（颜色 / 文案）；无其他动画 | 已实现 | M5：`.run-status` `transition: color/background-color/border-color var(--motion-state)`（`style.css` L150–160） | 无时序断言 | 录屏对照 |
| 数据来源 | `GET /api/trees/:treeId/diagnostics`（在途时轮询）；`POST /api/trees/:treeId/runs/:runId/abort` | 已实现（主通道已升级为 SSE，轮询为降级） | 主通道 SSE `/events`（`connectEvents` L999–1086：snapshot + 五类事件）；断流/不可用降级轮询（`onerror` → `startDiagnosticsPolling` L1008–1012；`sendPrompt` L1444）；abort 端点（L1487） | events.test.ts「SSE streaming…」（snapshot → run-started → message-delta* → run-terminal、断开干净关闭） | 断流降级实机验证 |
| 流式推送 | **流式 UI push**（token 级实时输出） | 已实现 | SSE `message-delta` → 流式占位回显 `updateStreamingPlaceholder()`（L1090–1113：只改文本节点、贴底纪律）；终态后 `/state` 权威刷新取代占位（L1062–1079） | events.test.ts「SSE streaming…」（delta 拼接 = `echo:[stream-me]`）；ui-probe「visual baseline…」（占位 + 静态 caret 形态）、「streaming scroll discipline…」 | 真实 Pi 流式观感 |
| 键盘焦点顺序 | 中止按钮始终可 Tab 触达；状态变化可被屏幕阅读器感知（aria-live） | 已实现（结构面） | `#abort-run` 原生 button（可见时可 Tab，无在途时隐藏）；`#run-status` `aria-live="polite"`（`index.html` L31）；两个会话容器 `aria-live="polite"`（L40/L63） | 结构存在（ui-probe 必需 id 断言）；aria-live 无行为断言 | 屏幕阅读器实机 |
| 窄窗 <720px | 状态条压缩为图标 + 短文案 | 已实现 | 状态点（`.run-status::before`）+ 短词（idle/streaming/aborting）保留，详情/策略注记收起（`style.css` L538–539） | 无自动断言（样式面） | 窄窗实机 |
| prefers-reduced-motion | 状态切换即时；streaming 指示不用旋转/循环动画（静态图标或文字） | 已实现 | 切换即时（全局降级块）；streaming 为静态 caret 文本 ` ▍ streaming…`（L630–634；`style.css` L304–306 无动画）——按构造无循环动画 | ui-probe「visual baseline…」（caret 文本断言） | 实机对照 |

### 2.6 锚点揭示与高亮

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 从支线（或 Return 卡）跳回主线锚点出处，高亮原选区 | 已实现 | 面板头 `⌖ View source` → `revealOrigin()`（L1401–1431）：available → 主线内揭示（面板保持）或打开出处分支面板呈现；高亮按**服务端判定的绝对偏移**渲染（`renderTurnsInto` `text.slice(start,end)` L565–586） | 服务/HTTP 面：api.test.ts（`/source` 端点 available + cursor 对齐）；service.test.ts（`revealBranchOrigin` 语义）。**UI 级揭示/高亮场景无自动断言**（ui-probe 未脚本化 source 揭示） | 实机揭示操作 + 录屏 |
| 状态 | `available`（定位 + 高亮 + 滚动到锚点）；`changed`（显示保存的摘录 + "原文已变化"说明，拒绝定位）；`unavailable`（显示保存的摘录 + 不可用原因，拒绝定位）——降级不伪造（W1 §1.3） | 已实现 | available → `state.sourceHighlight` + `revealAnchorTurn()`（L1241–1248：滚动 + 焦点）；changed/unavailable → 面板错误提示"Source reference …; saved excerpt remains available."（L1408–1411）+ 摘录恒在面板头部可读（`renderPanelAnchorContext` L669–687） | 三态判定：service.test.ts「anchor status preserves duplicate and cross-line selections and degrades…」（available/unavailable；**changed 无直接用例**——无 turn 改写路径，见 W1 §6）；UI 降级呈现无自动断言 | 实机降级变体（真实 session 缺失抽查，W1 R2 人工列） |
| 转场 | 高亮一次性强调（脉冲 1–2 次）后保持静态高亮 | 已实现 | M6 `anchor-pulse` 900ms 单次（`style.css` L126–134）+ `pulsedHighlightKey` 防重播（L575–580） | 无时序断言 | 录屏对照 |
| 数据来源 | `POST /api/trees/:treeId/branches/:branchId/source`；`GET /api/trees/:treeId` | 已实现 | `revealOrigin()` POST `/source`（L1403–1406）；`/state` 刷新 | api.test.ts 主流程（source 200 + state.cursor） | — |
| 键盘焦点顺序 | 揭示后焦点移至锚点 turn；降级时焦点到说明区 | 部分 | 揭示后焦点移至锚点 turn ✓（`revealAnchorTurn` `el.focus()`，锚点 turn `tabindex=-1` + `.anchor-focus`，L588–589/L325）；**缺口**：降级路径走 `showError` 横幅，**不移焦点**到说明区（L1408–1411） | 焦点移动无自动断言 | 键盘实机（含降级路径）；降级焦点归属待 owner 裁决 |
| 窄窗 <720px | 高亮全宽；摘录横向滚动（不截断换行） | 部分（有偏差） | 高亮全宽 ✓（`.turn` 100%，L542）；**摘录为换行呈现而非横向滚动**——`#panel-anchor-context { overflow-wrap: anywhere }`（`style.css` L366–371），与源设计约定"横向滚动不截断换行"不同（实现取舍：避免窄窗横向滚动条） | 无自动断言（样式面） | 窄窗实机；与源设计的偏差待 owner 裁决 |
| prefers-reduced-motion | 平滑滚动改直接跳转；脉冲改静态高亮 | 已实现 | `scrollBehavior()` reduce → `auto`（揭示滚动 L1245）；脉冲经全局降级块即时化（静态高亮直接出现） | 无自动断言 | 实机对照 |

### 2.7 来源抽屉（Run 溯源 + Journal）

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | 查看任一 turn 的 run 溯源（runId → 状态 / 失败 / 时间戳）与事件 Journal（权限 / 工具决策记录） | 已实现 | `renderDrawer()`（L1679–1806）：per-run 出处（诊断面安全投影）、Return 出处（含 `deliveredRunId`）、journal 尾部（保守摘要）、工具活动（如实空态） | ui-probe「journal drawer…」；events.test.ts「journal endpoint…」「tool-activity events project tool name and phase only…」 | — |
| 状态 | 关闭；打开-有数据；打开-无 Journal（如实呈现"未接入 / 无记录"，不伪造）；打开-加载失败 | 已实现 | journal 三态（`state.journalEvents`：`null` = 加载中，`{ok:true, events}` = 已载，`{ok:false}` = 失败——L57–59 注释、L103–105）：加载中 / 已载（含如实空态"no journal events recorded…"）/ 失败 + Retry（"journal failed to load — Retry"，L1754–1764） | ui-probe「journal drawer: failure with retry, honest empty state, Esc focus restore」（失败不伪装成无事件、重试回加载态、3 次拉取计数） | — |
| 转场 | 抽屉滑入 150–200ms（见 §3） | 已实现 | `showDrawer()`/`hideDrawer()`（L1160–1196）+ `style.css` `#source-drawer.enter/exit`（L444–445，与面板同一动效语汇） | 无时序断言 | 录屏对照 |
| 数据来源 | `GET /api/trees/:treeId/diagnostics`（run 溯源）；Journal 读面 | 已实现 | `/diagnostics`（runs 列表，`state.diagnostics`）；`/journal?limit=20`（`loadJournal` L1649–1660，journal 投影经 `service.ts` `getTreeJournal`/`summarizeJournalEvent` 保守摘要）；工具活动经 SSE `tool-activity` | events.test.ts「journal endpoint: tree-filtered, newest last, limit respected, 404/400 mapping」「policy boundary…」（保守投影，参数/路径不外泄） | 真实 Pi 工具活动呈现（离线驱动如实为空） |
| 键盘焦点顺序 | 打开后焦点入抽屉；Esc 关闭并还原焦点到触发元素 | 已实现 | 打开 `$("source-drawer").focus()`（L1641，容器 `tabindex=-1`）；Esc 还原 `drawerFocusReturn`（`closeDrawer` L1663–1671 + document keydown L1872–1876） | ui-probe「journal drawer…」（`activeElement` 断言 + Esc 还原到开关） | 键盘实机 |
| 窄窗 <720px | 抽屉全宽（自底向上） | 部分（有偏差） | 全宽 ✓（`#source-drawer { width:100% }`，L545）；**自底向上 ✗**——实现为右侧全宽滑入（与面板同一动效语汇），非约定的底部上滑 | 无自动断言（样式面） | 窄窗实机；方向与源设计的偏差待 owner 裁决 |
| prefers-reduced-motion | 透明度过渡或直接出现 | 已实现 | 全局降级块（滑入即时化） | 无自动断言 | 实机对照 |

### 2.8 缺失 session 降级视图

| 项目 | 约定 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- |
| 用途 | Pi session 文件缺失时**保持可浏览** + 给出**可执行**恢复提示 | 已实现 | 主线横幅 `renderSessionBanner()`（L343–367，可 dismiss、session-corrupt 失败亦强制显示）；分支 tab 徽标 "· session missing"（L306–313）；面板降级提示 `renderPanelSessionNote()`（L694–710，常驻非 dismissible） | ui-probe「branch panel degradation…」「trunk session banner…」；events.test.ts「session deletion…」 | 文件级移除 session 实机复现（W1 R12 人工列） |
| 状态 | 受影响分支 / 锚点标记"session 不可用"；产品事实（turns / 摘录）保持只读可浏览（DB 是事实源，W1 §3.4）；续聊入口禁用并说明原因（fail closed，不静默重建）；恢复提示（从既有 turn 开新分支）可直接执行 | 已实现 | 树/分支/turn 只读可浏览（读模型不依赖 session 文件）；续聊 fail-closed（`updateComposerLocks` 禁用输入与发送 + 提示文案说明原因）；恢复按钮 `sessionRecoveryControls()`（L401–420："⑃ Branch from latest available answer"，无候选时禁用 + 原因）→ `branchFromLatestAvailableAnswer()`（L1531–1548，从 session 仍可用分支的最新 assistant 答案整条建支线并以面板打开）；服务端可用性 = `sessionAvailability` 实时存在性探针（`service.ts` `#probeSessionAvailability` L758–766） | ui-probe「branch panel degradation…」（恢复按钮精确 POST `/branches` 载荷、fail-closed 不放松、新支线入口按构造启用、不做 `/switch`）+「trunk session banner…」（全分支不可用时禁用 + 原因；跨分支恢复精确载荷；横幅保持）；events.test.ts「session deletion…」（可读性 + 502 fail-closed + 零部分写入 + 恢复路径）、「session availability derivation…」（探针对缓存评估的如实修正） | 实机按 UI 提示恢复一遍 + 录屏 |
| 转场 | 与正常视图一致（降级是数据状态，不是独立动效场景） | 已实现 | 降级元素复用既有样式（横幅/提示条），无独立动效 | — | — |
| 数据来源 | `GET /api/trees/:treeId`（originStatus / 降级状态）；`POST /api/trees/:treeId/branches`（恢复路径） | 已实现 | `/state`（`sessionAvailability`/`originStatus` 读模型）；`POST /branches`（恢复） | 同"状态"行 | — |
| 键盘焦点顺序 | 恢复提示按钮是降级视图内首个焦点 | 已实现 | `focusIntoPanel()`：session 降级时优先聚焦恢复按钮（禁用时退回降级提示本身，`tabindex=-1`，L1217–1221）；主线横幅按钮原生可 Tab | 常规开面板焦点已断言（ui-probe「branch panel degradation…」）；降级首焦点无直接断言 | 键盘实机（降级态） |
| 窄窗 <720px | 提示条全宽 | 已实现 | 横幅/面板提示随容器全宽（面板全宽 L545；横幅为块级元素） | 无自动断言（样式面） | 窄窗实机 |
| prefers-reduced-motion | 同正常视图 | 已实现 | 无专属动效（同"转场"行） | — | — |

## 3. 动效分镜（状态转场清单）

总则：每个动效必须有 `prefers-reduced-motion` 等价物；转场克制（数量少、
时长短、无循环装饰动画）；状态绝不只靠动效表达（同时有颜色 / 文案 / 图标）。

实现口径：全部动效集中于下表 M1–M7；时长变量集中于 `style.css` `:root`
（`--motion-state: 100ms` / `--motion-panel: 180ms` / `--motion-card: 200ms`，
L14–16）；`prefers-reduced-motion` 等价物 = 全局降级块（`animation-duration/
transition-duration: 0.01ms`、`scroll-behavior: auto`，L551–561）+ JS 侧
`matchMedia` 控制滚动 `behavior`（`app.js` L148–153）。**自动证据的边界**
（如实声明）：ui-probe 桩 DOM 不求值 CSS、`matchMedia` 恒 false——动效
时序与 reduced-motion 实效**无自动断言**，仅有 JS 侧类名/收尾计时的结构
面覆盖（面板/抽屉退场 220ms 后 `hidden`）；逐项实机对照归 owner。

| # | 动效 | 触发 | 常规形态 | reduced-motion 等价 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | 支线面板进入 | 打开支线 | 侧滑 + 淡入，150–200ms，ease-out | 仅透明度 0→1（或直接出现，无位移） | 已实现 | `style.css` `#branch-panel.enter { animation: panel-in 180ms ease-out }`（L344–349）+ `app.js` `showPanel()`（L1122–1138，reflow 保证从初始态播放） | 结构面（ui-probe Esc 场景经同一开合路径） | 实机对照 |
| M2 | 支线面板退出 | 关闭支线 | 对称退出 ~150ms | 仅透明度 1→0 | 已实现 | `panel-out 150ms ease-in forwards`（L345、L350–353）+ `hidePanel()`（L1140–1158，播完才置 `hidden`） | 结构面（ui-probe 以 220ms 等待收尾后断言 `hidden === true`） | 实机对照 |
| M3 | Return 卡插入 | Return `confirmed` | 高度展开 + 淡入，≤200ms | 即时插入 | 已实现 | `@keyframes return-insert`（clip-path 展开 + 淡入，L276–281）+ `returnCard()` insert class 与 `MOTION_EPOCH_MS = 260` 观测窗口（重渲不重播，L447–467） | 卡与徽标文案断言（ui-probe「visual baseline…」「return flow…」）；动效类名无断言 | 录屏对照 |
| M4 | Return 卡状态变化 | `confirmed` → `delivered` | 徽标颜色 / 文案切换 ~100ms | 即时切换 | 已实现 | `@keyframes badge-change`（L283–288）+ `seenDeliveredRunIds` 变化检测（L483–491）；`--motion-state: 100ms` | 徽标文案断言（delivered 文本 + 反查入口，ui-probe「visual baseline…」）；动效无断言 | 录屏对照 |
| M5 | Run 状态指示变化 | idle → streaming → aborting / 终态 | 颜色 + 文案过渡 ~100ms；streaming 用静态指示（不旋转） | 即时切换 | 已实现 | `.run-status` transition `var(--motion-state)`（L150–160）+ 状态点 `::before`；streaming 静态 caret 文本（`app.js` L630–634；`style.css` L304–306） | caret 文本断言（ui-probe「visual baseline…」）；过渡时序无断言 | 录屏对照 |
| M6 | 锚点高亮强调 | 揭示到位 | 背景脉冲 1–2 次后保持静态高亮 | 直接静态高亮 | 已实现 | `@keyframes anchor-pulse` 900ms 单次（L126–134）+ `pulsedHighlightKey` 防重播（`app.js` L575–580） | 无时序断言 | 录屏对照 |
| M7 | 滚动定位 | 揭示 / 切分支 | 平滑滚动 | 直接跳转（`auto`） | 已实现 | `scrollBehavior()`（`app.js` L151–153）用于：`renderTurnsInto` 贴底（L643–646）、`revealAnchorTurn`（L1245）、Return 卡定位（L1608）、抽屉反查定位（L1803）；首次打开固定 `auto`（L645） | 滚动行为值断言（ui-probe「branch panel degradation…」：首渲染 `lastScrollBehavior === "auto"`）；reduce 分支无断言（桩恒 false） | 实机 reduced-motion 对照 |

## 4. A2 加固清单（issue #2：长答案 / 重复词 / 跨行 / 滚动位置及目标 Mac 完整操作未验）

| 项 | 现状 | 验证步骤 | 状态 | 实现路径 | 自动证据 | 待人工项 |
| --- | --- | --- | --- | --- | --- | --- |
| 长答案 | service 层选区不变量已覆盖；UI 渲染 `pre-wrap` | 在数千字符多段答案的**后段**选区建支线 → 揭示回锚点：高亮位置准确、无布局位移、滚动到位 | 部分 | 渲染保多段换行：`.turn { white-space: pre-wrap }`（`style.css` L263）；选区/高亮均按绝对偏移（见下两行） | service.test.ts「branch anchoring is validated (answer role, slice integrity, bounds)」（偏移不变量） | 数千字符后段选区的 UI 定位与目标 Mac 完整操作未验 |
| 重复词（绝对偏移） | 服务层已覆盖；UI 渲染走偏移 | 答案中同一词出现 ≥2 次，选**第二处**建支线 → 揭示必须高亮第二处（绝不允许首个字符串匹配顶替） | 部分（服务层已测；UI 级与实机未验） | UI 选区计算 `selectionOffsetsWithin()`（以 Range 前缀长度求绝对偏移，非字符串搜索，L422–435）；高亮按偏移切片渲染（L565–586）；揭示拒绝字符串搜索定位（W1 §1.1） | service.test.ts「anchor status preserves duplicate and cross-line selections and degrades when source is unavailable」（重复词第二处偏移） | ui-probe 无重复词揭示场景（UI 级自动断言缺口）；目标 Mac 验证 |
| 跨行选区 | 服务层已覆盖；UI 未验 | 选区跨换行 → 建支线 → 揭示高亮跨行完整、不截断 | 部分（同上） | 同上（偏移跨换行天然成立；`pre-wrap` 保换行渲染） | 同上（跨行 `repeat\nrepeat` 选区用例） | 同上 |
| 每分支滚动位置恢复 | 已实现（见 §2.2 阅读位置行） | 在支线 A 滚到中部 → 切到支线 B / 回主线 → 返回 A：A 的阅读位置恢复 | 已实现 | `state.scrollPositions` + scroll 监听 + `renderTurnsInto` 恢复（§2.2 阅读位置行的路径） | ui-probe「streaming scroll discipline…」（记忆/恢复机制 + 贴底纪律）；面板往返恢复无直接断言 | 实机三视图往返 |
| 目标 Mac 完整操作 | 未验 | 在目标 Mac 上按 §2 逐屏完整操作一遍（含全部状态与降级变体），录屏归档 | 未开始 | — | — | owner：按 §2 逐屏操作 + 录屏归 `evidence/d3/real-pi/`（用 `evidence/d3/templates/run-record.md`） |

## 5. 试用与验收衔接

- **录屏逐屏对照**（含窄窗、键盘焦点、`prefers-reduced-motion`）：按 §2
  逐屏录制，记录归 `evidence/d3/real-pi/`（用
  `evidence/d3/templates/run-record.md`，录屏归档位置以链接占位）。
  本清单标注「已实现」的行均以此为签收前提（状态词 §0）。
- **3–5 人独立试用**：同一真实任务脚本、逐人记录卡点 / 耗时、修复阻断
  问题后复测——记录归 `evidence/d3/trials/`。
- 本清单各项的 owner 验收以逐项对照交付夹源设计为前提；负责人将其与
  交付夹源设计逐项对照后方可签收 W2。本文档不代负责人作出任何门禁结论。
