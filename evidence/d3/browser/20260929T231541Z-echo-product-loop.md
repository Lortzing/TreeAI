# TreeAI D3 浏览器 UI 级操作记录【echo 自检 · 维护波合并验证（离线回归基线）】

> **驱动类别：echo（离线确定性驱动）——按区域规则醒目标注：本记录永远不是
> 真实 Pi 证据**，只是跑批器 `run-d3-browser.mjs` **v1.3.2** 在维护波合并
> 终点 SHA `1380a39`（`1380a3967f7630763a2caf9f2f2ac935a83e08f4`）上的离线
> 回归基线，与 `20260929T230615Z-echo-product-loop.md`（`ae5912b`，修复
> 波独立验证）承接。本波为四条并行工作流的合并验证波：tool-policy 包入口
> 关闭（`526cfcd` 合入的 `7e8dcdd`——studio 的 `#tool-policy` 编译副本
> 改为直接工作区导入）、跑批器加固（`ae5912b`）、W1 §6-3/§6-7 用例补齐
> （`1fcc27b` 合入的 `81f7d5a`）与文档勘误——本记录证明**合并后的组合**
> 在真实浏览器全编排下成立（此前各分支只各自隔离验证，未经历浏览器面
> 组合验证；`7e8dcdd` 改写 studio 导入图后尤其需要）。

## 基本信息

- 记录 ID：`d3-browser-20260929T231541Z-echo-product-loop`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:15–23:17Z，三连跑）
- 操作人（编号 / 角色）：claude-code-treeai-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `1380a3967f7630763a2caf9f2f2ac935a83e08f4`（运行于该 SHA 的隔离
  detached worktree；三份 summary 的 git 读数 dirty 均为 false——porcelain
  干净）
- 记录类别：☐ 真实 Pi　☑ echo 离线自检（回归基线）
- 驱动方式：`node scripts/run-d3-browser.mjs --mode selftest`（真实
  Chromium/CDP + 真实输入事件；echo 驱动的确定性答案）

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）；`npm ci` 后执行
  `npm run --workspace @treeai/event-journal build:test`（studio 服务进程
  经 `@treeai/event-journal` 的编译入口 `dist/src/index.js` 消费——跑批器
  绝不静默代为构建，见本波发现；该前置已随本波补入区域 README）
- 浏览器：Chrome headless（CDP over DevTools WebSocket；127.0.0.1 本地
  回环，无外网）；视口 1280×900——≥1180px：全程真实运行于并置支线列布局
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户
  文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）

## 结果

| 套件 | 三连跑结果 | 退出码 |
| --- | --- | --- |
| 浏览器面 echo 自检 | **24 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN** ×3（6 NOT_RUN 为 5 项工具门检查 + 1 项流中重载，均为既知模式门控） | 0 / 0 / 0 |

三份运行 summary 快照见同记录 ID sidecar 目录（`summary-run{1,2,3}.json`）。
summary.json 的 checks 数组与 stdout 全量一致：各 30 行（24 PASS +
6 NOT_RUN）、末行 `console-clean: PASS`、三次运行 checks 数组逐项全等
（程序化比对通过）——`ae5912b`（v1.3.2）的 summary 修复口径在本 SHA
复验成立。截图等二进制不入仓，仅留于运行机 artifacts 临时目录。

本波核对点（与 `ae5912b` 基线同断言面全绿）：窄窗 480px 媒查真实命中、
抽屉自底向上 vs 宽窗右侧滑入、reduced-motion 计算样式坍缩、A2 三深选区
（长答案后段 / 重复词第二处 / 跨行）经 v1.3.1 安全带精确拖选武装、主线
阅读全程不动、相末主树计数不变——studio 导入图改写（`#tool-policy` 编译
副本 → `@treeai/tool-policy` 直接工作区导入）后服务进程引导、SSE、全部
编排检查照常。

## 本波发现

**环境前置缺口（非产品缺陷，如实记录）**：隔离 worktree 只跑 `npm ci`
时，studio 引导以 `ERR_MODULE_NOT_FOUND` 失败——`@treeai/event-journal`
的包入口指向编译产物 `dist/src/index.js`，需 `npm run --workspace
@treeai/event-journal build:test` 前置（studio 的 `build:deps` 亦含此步，
既往录制 worktree 因先跑过测试套件而隐式满足；区域 README 此前未记载该
前置，本波补入）。跑批器按设计如实报 `studio-boot` 失败（1 PASS / 1
FAIL / 28 NOT_RUN ×3，artifacts 留档于运行机临时目录、未入库）而绝不
静默代为构建；补前置后三连跑全绿。产品代码零缺陷：三次失败与三次成功
之间的唯一差异即该编译前置。
