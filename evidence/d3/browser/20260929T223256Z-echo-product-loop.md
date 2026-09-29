# TreeAI D3 浏览器 UI 级操作记录【echo 自检 · 视觉重构波（离线回归基线）】

> **驱动类别：echo（离线确定性驱动）——按区域规则醒目标注：本记录永远不是
> 真实 Pi 证据**，只是跑批器 `run-d3-browser.mjs` **v1.3.1**（含 `361f528`
> 落地的拖选安全带裁剪感知修复）在视觉重构波最终 SHA `361f528` 上的离线
> 回归基线，与 `20260929T200642Z-echo-product-loop.md`（`0f9df98`，v1.3.0
> 基线）承接。本波的重构内容（58px 顶栏 + 如实位置路径、Forest/Branches
> 侧栏、≥1180px 并置支线列、限高骨架/内部滚动器）见 `docs/d3/D3-status.md`
> 该波行；真实 Pi 半波（API / SDK / 浏览器 real-Pi + tools + model-error）
> 同波另行记录。

## 基本信息

- 记录 ID：`d3-browser-20260929T223256Z-echo-product-loop`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T22:31–22:33Z）
- 操作人（编号 / 角色）：claude-code-treeai-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `361f528fe67502d5ed6ac74581194e55ad09f2bc`（运行于该 SHA 的隔离
  detached worktree；已跟踪文件零改动，porcelain 干净）
- 记录类别：☐ 真实 Pi　☑ echo 离线自检（回归基线）
- 驱动方式：`node scripts/run-d3-browser.mjs --mode selftest`（真实
  Chromium/CDP + 真实输入事件；echo 驱动的确定性答案）

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome headless（CDP over DevTools WebSocket；127.0.0.1 本地
  回环，无外网）；视口 1280×900——**≥1180px：本波起真实进入并置支线列
  布局**（改版前为右侧覆盖层）
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户
  文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）

## 结果

| 套件 | 三连跑结果 | 退出码 |
| --- | --- | --- |
| 浏览器面 echo 自检 | **24 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN** ×3（v1.3.1 基线；6 NOT_RUN 为 5 项工具门检查 + 1 项流中重载，均为既知模式门控） | 0 / 0 / 0 |
| API 面 echo 自检（同波顺带，非本目录证据面） | 18 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3 | 0 / 0 / 0 |

三份运行 summary 快照见同记录 ID sidecar 目录（`summary-run{1,2,3}.json`，
三次运行的 checks 数组逐项一致、零 page errors）。已知诚实口径（与
`0f9df98` 波同形状）：summary.json 写盘时点早于最后一项 `console-clean`
的登记，故其 checks 数组为 23 PASS + 6 NOT_RUN（少 1 项），**stdout 的
24 PASS 为准**。截图等二进制不入仓，仅留于运行机 artifacts 临时目录。

本波核对点（重构后布局的既知断言面全绿）：窄窗 480px 媒查真实命中、抽屉
自底向上（`drawer-up-in`）vs 宽窗右侧 380px 滑入、reduced-motion 计算样式
坍缩、A2 三深选区（长答案后段 / 重复词第二处 / 跨行）在新布局下经
v1.3.1 安全带精确拖选武装、主线阅读全程不动、相末主树计数不变。

## 本波发现

无新产品缺陷。跑批器 v1.3.1 的安全带裁剪感知修复（详见同波 real-Pi 浏览器
记录的「本波发现」）在 echo 面同样生效——v1.3.0 在本布局下的窗口带误判
首先由真实模型面暴露（跨行深选区 1 项 FAIL），echo 面因答案结构恒定未
触发；修复后两面全绿。
