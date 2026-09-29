# TreeAI D3 浏览器 UI 级操作记录【echo driver】（runner v1.1.0 工具缝波）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器 UI 录制，**不是真实 Pi 证据**；真实 Pi 的浏览器录制见
> `20260929T144350Z-realpi-product-loop.md`（`fcfae52`）。本波为
> `218f9ca` 收尾波：附-4 关闭按钮 + A5 浏览器面工具缝能力落地后的
> echo 自检三连跑。

## 基本信息

- 记录 ID：`d3-browser-20260929T154300Z-echo-product-loop`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`218f9ca41b1d67358e54f5cfb72a4d8f58a42a84`。`gitDirty: true` 的构成如实说明：已跟踪文件改动至多 `docs/d3/D3-status.md` 一份文档（本波状态记录与三次运行的并行撰写，时点或有先后；**非运行时代码**——studio / app.js / style.css / 跑批器本体与该 SHA 逐字节一致），其余为未跟踪的历史运行产物目录与本机配置。运行时代码与 SHA 一致。
- 记录类别：☑ 浏览器 UI 级操作　☑ 故障注入　☑ 幂等测试　☐ 真实 Pi（本记录为 echo）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` **v1.1.0**（`--mode selftest`）spawn 真实 Studio CLI（`--driver echo`）+ 本机 Chrome headless（CDP over DevTools WebSocket），以**真实输入事件**（鼠标点击 / 拖选、键盘提交、原生输入管线文本注入）驱动真实 UI

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome 153.0.8010.37（headless=new，CDP 通道；127.0.0.1 本地回环，无外网）
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）
- 视口：1280×900（宽窗断言）与 480×800（窄窗断言，`max-width: 719px` 媒体查询实测命中）

## 操作步骤（逐条）

前提：临时数据目录全新。跑批器对 27 项检查逐项登记，本记录按其 stdout 事实誊录（状态词沿用 D2 约定）。结果：**21 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN**，退出码 0；同 SHA 连续 3 次运行结果一致（run 1 的脱敏 JSON 摘要入本目录 sidecar；截图等二进制不入仓，仅留于运行机 artifacts）。

1. chrome-boot / studio-boot / page-boot：Chrome CDP 通道建立；echo studio `/api/health` ok；页面渲染——空态可见、零树、启动焦点落在「新建」（new-tree）。
2. tree-create：真实点击「＋ New Tree」→ 树视图打开、分支页签仅 Trunk。
3. trunk-main-line：两轮主干 prompt（第 2 轮经 **⌘+Enter 键盘路径**提交）→ 4 turns 渲染；API `/state` 同为 4 turns。
4. selection-anchoring：在第 1 轮答案上**真实鼠标拖选**（字符区间 24–52）→ 原生 Selection 产生、`.has-selection` 状态就位、按钮切换为「⑃ Branch from selection」。
5. branch-a-create / branch-a-followups：支线 A 建立（局部面板、锚点上下文携带所选摘录）；面板内两轮追问（第 2 轮经 **Ctrl+Enter**）→ 面板 4 turns。
6. switch-navigation：面板收起 → 主线回合不受支线影响 → 经页签切回支线 A → 面板内容完整、主线无支线内容泄漏。
7. branch-b-create / branch-b-followups：从第 2 轮答案的**不同子区间**（30–61）拖选建支线 B；两轮追问 → 面板 4 turns。
8. no-context-bleed：渲染面上的跨支线探针——B 面板只见 birch + 主干可见词（maple），绝无 cedar；A 面板只见 cedar + maple，绝无 birch（echo 语义下机械可证）。
9. return-flow：支线 A 面板 Return 草稿（按 W1 预填上一答案 → **全选覆盖**输入）→ 显式提交 → 面板收起、主干出现 anchored Return 卡（待送达态）；来源抽屉 Returns 区显示「not yet delivered」；服务端 1 条 return、`deliveredRunId: null`。阅读后**经抽屉头部新关闭按钮 `#drawer-close` 真实点击收起**（本波附-4 option B 方向落地；`click()` 助手的 elementFromPoint 覆盖防护证明该按钮在覆盖层打开时真实可点——Esc 路径的覆盖保持在 a11y-semantics 与 narrow-window-layout）。
10. return-delivery：主干第 3 轮 prompt → 卡片徽标翻转为 delivered；服务端核对 `deliveredRunId` === 该轮 run。
11. model-error-convergence（echo 专属确定性注入）：`/fail` 前缀 prompt → 错误横幅（`role="alert"`）+ 常驻失败面板 + composer 解锁；随后正常 prompt 成功；服务端存在 failed run（code `upstream`）。
12. server-restart-recovery：studio 子进程 **SIGKILL** → 页面在下一动作呈现诚实错误横幅；同数据目录重启 + 整页刷新 → 树 / 分支（trunk+A+B 共 3）/ 回合 / cursor 完整；主干续聊可用。
13. missing-session-degradation：移走 `sessions/*.jsonl` → 会话横幅、**fail-closed**（composer 禁用）、恢复动作如实呈现；还原文件 → 刷新即完全恢复。
14. NOT_RUN ×6（预期，模式/工具门控如实登记）：response-loss-midstream（echo ~1ms 轮次无确定性在途窗口；「杀进程」半面已由 server-restart-recovery 覆盖）+ **本波新增的 5 项工具面检查**（tool-policy-boot / -allow-read / -deny-fail-closed / -deny-provenance / -canary-never-read）——echo 驱动无工具执行器且 echo 模式下 `--pi-tools` 被 studio CLI 拒绝；离线锁定在 `apps/studio/tests/events.test.ts` + `cli.test.ts`，产品面真实模型录制在 `evidence/d3/real-pi/20260929T124851Z-product-loop-tools.md`。这 5 项在 `--mode real-pi --pi-tools read` 下运行（v1.1.0 新增 `--pi-tools` / `--policy-read-roots` 原样转发 + 两段式工具引导），**本记录环境无 `TREEAI_STUDIO_API_KEY`，真实模型浏览器录制待负责人凭据后补**。
15. a11y-semantics：错误横幅 `role="alert"` + `tabIndex 0`；抽屉开合 `aria-expanded` 双向 + **Esc 关闭**（焦点还原给开关）；`#panel-anchor-context` `tabindex="-1"` 可编程聚焦。
16. narrow-window-layout：480px 视口——侧栏开关可见、`#run-detail` 隐藏；来源抽屉**自底部上滑**（`drawer-up-in`、全宽 480px），宽窗对照为右侧滑入 360px；抽屉经 Esc 关闭。
17. reduced-motion：`prefers-reduced-motion: reduce` 仿真 → 计算样式 `animation-duration` / `transition-duration` 折叠为 0.01ms；复位正常。
18. console-clean：全程零意外页面 console/Log 错误（故障注入窗口内的预期连接错误与 favicon 404 不计）。

## 脱敏 ID 清单

- 跑批器 stdout 不回显 Tree / Branch / Return / Run ID（只登记状态与计数）；如需逐 ID 对照，可由负责人以同命令在同 SHA 复跑核对。
- 附件 JSON（本目录）中的页面 DOM 摘要已按区域规则脱敏（本地路径占位符化，跑批器写盘前统一处理）。

## 注入的故障（如无写"无"）

- 故障类别：模型错误（echo `/fail` 钩子，确定性）／宿主重启（SIGKILL + 同数据目录重启）／缺失 session（移走 `sessions/*.jsonl` 后还原）
- 注入方式：跑批器对 studio 子进程 SIGKILL；数据目录内文件改名移走/还原
- 观察到的行为：见步骤 11–13（全部收敛、呈现与恢复符合 W1/W2 契约）

## 样式 / 布局抽查（真实浏览器计算样式）

| 抽查 | 选择器 / 属性 | 期望 | 实测 |
| --- | --- | --- | --- |
| 窄窗断点 | `matchMedia('(max-width: 719px)')` @480px | 命中 | 命中 |
| 侧栏开关可见性 | `#sidebar-toggle` computed `display` @480px | 非 none | 非 none |
| 窄窗信息密度 | `#run-detail` computed `display` @480px | none | none |
| 抽屉滑入方向（窄） | `#source-drawer` `animationName` / `width` | `drawer-up-*` / 全宽 | `drawer-up-in` / 480px |
| 抽屉滑入方向（宽） | `#source-drawer` `width` | 远小于全宽（右侧滑入） | 360px |
| 降级动效 | 任意元素 `animation-duration`/`transition-duration` @reduce | ≤0.01ms | 0.01ms（0.00001s） |
| 朗读语义 | `#error-banner` `role`/`tabIndex` | alert / 0 | alert / 0 |
| 抽屉开关状态 | `#source-drawer-toggle` `aria-expanded` | 开 true / 关后立即 false | 如实 |
| **附-4 关闭按钮可点性** | `#drawer-close`（elementFromPoint 覆盖防护） | 覆盖层打开时真实可点 | 如实（return-flow 经按钮收起，PASS） |

## 本波发现（如实记录）

1. **附-4 已按 option B 方向实现（`7fb0861`，待 owner 复核）**：来源抽屉头部新增可见关闭按钮 `#drawer-close`（真按钮、「× Close」、抽屉内首个可交互元素），点击复用 `closeDrawer()`——焦点还原 / 开关 aria 对齐与 Esc 同一语义。浏览器面 `return-flow` 经真实点击收起（elementFromPoint 防护证明可点）；ui-probe 同步锁定渲染契约与 Esc 路径不回归。裁决栏仍空（`docs/d3/W1-W2-owner-decisions.md` 附-4 行）。
2. **A5 浏览器面工具缝能力落地（`218f9ca`）但本记录未能录制真实模型相**：跑批器 v1.1.0 已支持 `--pi-tools` / `--policy-read-roots`（real-pi 专属）与五项工具面检查（两段式工具引导 + 横幅透传证明 + marker/canary realpath 包含性证明 + 真实 composer 驱动 allow/overreach + 渲染抽屉 provenance + canary/渲染页泄露扫描）；本记录环境无 `TREEAI_STUDIO_API_KEY`，5 项检查按工具门如实 NOT_RUN。同 SHA 的真实模型浏览器录制（`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read`）待负责人凭据后追加新记录。
3. 跑批器 `summary.json` 附件自 v1.0.0 起在 console-clean 检查体内写盘（该检查自身的登记行因此不入 summary.json）——stdout 计数（27 项）为权威口径，summary.json 为 26 行诊断件；既有行为，非本波引入，未改动。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout 218f9ca41b1d67358e54f5cfb72a4d8f58a42a84
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
npm test                          # 全链（studio 套件 90/90：service 15 / ui-probe 21 / ui-regressions 9 / api / cli / events）
node scripts/run-d3-browser.mjs   # echo 自检：需本机 Chrome/Chromium；期望 21 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN
```
