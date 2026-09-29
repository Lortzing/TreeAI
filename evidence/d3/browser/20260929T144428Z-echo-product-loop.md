# TreeAI D3 浏览器 UI 级操作记录【echo driver】

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器 UI 录制，**不是真实 Pi 证据**；真实 Pi 的浏览器录制见同日
> `20260929T144350Z-realpi-product-loop.md`。

## 基本信息

- 记录 ID：`d3-browser-20260929T144428Z-echo-product-loop`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`fcfae525cbc091a689c7c9e9a20a609c47a5eb46`（运行代码与该 SHA 一致；`gitDirty: true` 仅由未跟踪文件构成——历史运行产物目录与本机配置，无已跟踪文件改动）
- 记录类别：☑ 浏览器 UI 级操作　☑ 故障注入　☑ 幂等测试　☐ 真实 Pi（本记录为 echo）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` v1.0.0（`--mode selftest`）spawn 真实 Studio CLI（`--driver echo`）+ 本机 Chrome headless（CDP over DevTools WebSocket），以**真实输入事件**（鼠标点击 / 拖选、键盘提交、原生输入管线文本注入）驱动真实 UI

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome 153.0.8010.37（headless=new，CDP 通道；127.0.0.1 本地回环，无外网）
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）
- 视口：1280×900（宽窗断言）与 480×800（窄窗断言，`max-width: 719px` 媒体查询实测命中）

## 操作步骤（逐条）

前提：临时数据目录全新。跑批器对 22 项检查逐项登记，本记录按其 stdout 事实誊录（状态词沿用 D2 约定）。结果：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**。

1. chrome-boot / studio-boot / page-boot：Chrome CDP 通道建立；echo studio `/api/health` ok；页面渲染——空态可见、零树、启动焦点落在「新建」（new-tree）。
2. tree-create：真实点击「＋ New Tree」→ 树视图打开、分支页签仅 Trunk。
3. trunk-main-line：两轮主干 prompt（第 2 轮经 **⌘+Enter 键盘路径**提交）→ 4 turns 渲染；API `/state` 同为 4 turns。
4. selection-anchoring：在第 1 轮答案上**真实鼠标拖选**（字符区间 24–52）→ 原生 Selection 产生、`.has-selection` 状态就位、按钮切换为「⑃ Branch from selection」。
5. branch-a-create：点击该按钮 → 支线 A 建立，局部面板打开、标题「Branch 1」、锚点上下文携带所选摘录。
6. branch-a-followups：面板内两轮追问（第 2 轮经 **Ctrl+Enter**）→ 面板 4 turns。
7. switch-navigation：面板收起 → 主线回合不受支线影响（4 turns 不变）→ 经页签切回支线 A → 面板内容完整、主线无支线内容泄漏。
8. branch-b-create：从第 2 轮答案的**不同子区间**（30–61）拖选建支线 B（标题「Branch 2」，摘录与 A 不同）。
9. branch-b-followups：两轮追问 → 面板 4 turns。
10. no-context-bleed：渲染面上的跨支线探针——B 面板只见 birch + 主干可见词（maple），绝无 cedar；A 面板只见 cedar + maple，绝无 birch（echo 语义下机械可证）。
11. return-flow：支线 A 面板 Return 草稿（按 W1 预填上一答案 → **全选覆盖**输入）→ 显式提交 → 面板收起、主干出现 anchored Return 卡（「confirmed — delivered on the next Trunk prompt」待送达态）；来源抽屉 Returns 区显示「not yet delivered」；服务端 1 条 return、`deliveredRunId: null`。阅读后**经 Esc 关闭抽屉**（抽屉为 fixed 覆盖层，打开时盖住 Send 按钮与其自身开关——见「本波发现」）。
12. return-delivery：主干第 3 轮 prompt → 卡片徽标翻转为 delivered（`delivered into Trunk context (run …)`）；服务端核对 `deliveredRunId` === 该轮 run。
13. model-error-convergence（echo 专属确定性注入）：`/fail` 前缀 prompt → 错误横幅（`role="alert"`，文本 `upstream: …`）+ 常驻失败面板（`Run … failed — upstream`）+ composer 解锁；随后正常 prompt 成功（回声含 back-online）；服务端存在 failed run（code `upstream`）。
14. server-restart-recovery：studio 子进程 **SIGKILL** → 页面在下一动作呈现诚实错误横幅（非静默丢弃）；同数据目录重启 + 整页刷新 → 树 / 分支（trunk+A+B 共 3）/ 回合 / cursor 完整；主干续聊可用。
15. missing-session-degradation：移走数据目录 `sessions/` 下 session 文件（echo 为 `*.jsonl`）→ 整页刷新 → 会话横幅可见、**fail-closed**（composer 禁用）、恢复动作「Branch from latest available answer」如实呈现（全 lineage 不可用时禁用并给出原因）；还原文件 → 刷新即完全恢复。
16. NOT_RUN（预期）：response-loss-midstream——echo ~1ms 轮次无确定性在途窗口；「杀进程」半面已由 server-restart-recovery 覆盖，在途整页刷新半面在真实模型录制中执行。
17. a11y-semantics：错误横幅 `role="alert"` + `tabIndex 0`（可 Tab 触达）；抽屉开合 `aria-expanded` 双向 + **Esc 关闭**（焦点还原给开关——本波修复后立即翻转，见「本波发现」）；`#panel-anchor-context` `tabindex="-1"` 可编程聚焦。
18. narrow-window-layout：480px 视口——侧栏开关可见（`display:block`）、`#run-detail` 隐藏、侧栏开合 `aria-expanded`/`body.sidebar-open` 语义就位；来源抽屉**自底部上滑**（`drawer-up-in` 关键帧、全宽 480px），宽窗对照为右侧滑入 360px。
19. reduced-motion：`prefers-reduced-motion: reduce` 仿真 → 真实计算样式 `animation-duration` / `transition-duration` 折叠为 0.01ms（Chromium 序列化为 0.00001s）；复位后回到 0s。
20. console-clean：全程零意外页面 console/Log 错误（故障注入窗口内的预期连接错误与 favicon 404 不计）。

## 脱敏 ID 清单

- 跑批器 stdout 不回显 Tree / Branch / Return / Run ID（只登记状态与计数，与 API 面跑批器同一纪律）；如需逐 ID 对照，可由负责人以同命令在同 SHA 复跑核对。
- 附件 JSON（本目录）中的页面 DOM 摘要已按区域规则脱敏（本地路径占位符化）。

## 注入的故障（如无写"无"）

- 故障类别：模型错误（echo `/fail` 钩子，确定性）／宿主重启（SIGKILL + 同数据目录重启）／缺失 session（移走 `sessions/*.jsonl` 后还原）
- 注入方式：跑批器对 studio 子进程 SIGKILL；数据目录内文件改名移走/还原
- 观察到的行为：见步骤 13–15（全部收敛、呈现与恢复符合 W1/W2 契约）

## 样式 / 布局抽查（真实浏览器计算样式）

| 抽查 | 选择器 / 属性 | 期望 | 实测 |
| --- | --- | --- | --- |
| 窄窗断点 | `matchMedia('(max-width: 719px)')` @480px | 命中 | 命中 |
| 侧栏开关可见性 | `#sidebar-toggle` computed `display` @480px | 非 none | 非 none（宽窗基线为 none） |
| 窄窗信息密度 | `#run-detail` computed `display` @480px | none（隐藏） | none |
| 抽屉滑入方向（窄） | `#source-drawer` `animationName` / `width` | `drawer-up-*` / 全宽 | `drawer-up-in` / 480px |
| 抽屉滑入方向（宽） | `#source-drawer` `width` | 远小于全宽（右侧滑入） | 360px |
| 降级动效 | 任意元素 `animation-duration`/`transition-duration` @reduce | ≤0.01ms | 0.01ms（0.00001s） |
| 朗读语义 | `#error-banner` `role`/`tabIndex` | alert / 0 | alert / 0 |
| 抽屉开关状态 | `#source-drawer-toggle` `aria-expanded` | 开 true / Esc 后立即 false | 如实（本波修复前为陈旧 true，见下） |

## 本波发现（如实记录）

1. **已修复**：Esc 关闭来源抽屉后 `aria-expanded` 陈旧为 true（`closeDrawer` 不经 `renderAll`，开关状态无人对齐）——读屏器持续播报已展开。修复：`closeDrawer` 内补 `renderDrawer()`（`drawerOpen` 已 false，仅更新开关即返回）；`ui-probe` 断言开/关两向立即对齐（提交 `279e86a`）。
2. **待 owner 裁决（W2 相关偏差）**：来源抽屉为 fixed 右侧整幅覆盖层（z-index 20），打开时**同时盖住主线 composer 的 Send 按钮与 Sources 开关自身**——鼠标用户关闭抽屉的唯一路径是 Esc；开关上的「× Close sources」文案对鼠标用户不可达。已记入 `docs/d3/W1-W2-owner-decisions.md` 附录。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout fcfae525cbc091a689c7c9e9a20a609c47a5eb46
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
node scripts/run-d3-browser.mjs   # echo 自检：需本机 Chrome/Chromium（--chrome-executable 可指定）
```
