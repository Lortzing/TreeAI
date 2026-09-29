# TreeAI D3 浏览器 UI 级操作记录【echo 自检 · 维护波后基线面重录（离线回归基线）】

> **驱动类别：echo（离线确定性驱动）——按区域规则醒目标注：本记录永远不是
> 真实 Pi 证据**，只是跑批器 `run-d3-browser.mjs` **v1.3.2** 在证据区当前
> 终点 SHA `a88ace5`（`a88ace54c8e5a0895a78a755d16ce3563cd1516f`）上的离线
> 回归基线，与 `20260929T231541Z-echo-product-loop.md`（`1380a39`，维护波
> 合并验证）承接。背景：维护波改写 studio 产品导入图（`#tool-policy` 编译
> 副本 → `@treeai/tool-policy` 包源码直接工作区导入，`1380a39`）后，该波
> 只重录了浏览器 echo 与 SDK 面，offline manifest 与 API echo 面仍停在
> 更早的 SHA；`a88ace5` = `1380a39` + 证据文档提交（产品代码与 `1380a39`
> 全同，`git diff 1380a39..a88ace5` 仅证据区 8 个文件）。本波把 offline +
> echo 基线面全部重录到 `a88ace5`，使整个证据面重新绑定同一 SHA——本记录
> 即浏览器面与 API 面的 echo 重录，同波 offline manifest 见
> `evidence/d3/offline/20260929T235025011Z-evidence-manifest/`。

## 基本信息

- 记录 ID：`d3-browser-20260929T234839Z-echo-product-loop`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:48–23:51Z：浏览器三连跑
  23:48–23:49、API 三连跑 23:50:00–23:50:02（每次约 1.3s）、offline
  manifest 自 23:50:25 起）
- 操作人（编号 / 角色）：claude-code-treeai-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `a88ace54c8e5a0895a78a755d16ce3563cd1516f`（运行于该 SHA 的隔离
  worktree；三份 summary 的 git 读数 head 均为该 SHA、dirty 均为
  false——录制期间 porcelain 干净，artifacts 写在仓外临时目录）
- 记录类别：☐ 真实 Pi　☑ echo 离线自检（回归基线）
- 驱动方式：`node scripts/run-d3-browser.mjs --mode selftest`（真实
  Chromium/CDP + 真实输入事件；echo 驱动的确定性答案）

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）；`npm ci` 后执行
  `npm run --workspace @treeai/event-journal build:test`（studio 服务进程
  经 `@treeai/event-journal` 的编译入口 `dist/src/index.js` 消费——跑批器
  绝不静默代为构建，该前置见区域 README 运行前置；
  `20260929T231541Z` 本波发现首次显式记录）
- 浏览器：Chrome headless（CDP over DevTools WebSocket；Chromium
  Chrome/153.0.8010.37；127.0.0.1 本地回环，无外网）；视口 1280×900
  ——≥1180px：全程真实运行于并置支线列布局
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户
  文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）

## 结果

| 套件 | 三连跑结果 | 退出码 |
| --- | --- | --- |
| 浏览器面 echo 自检 | **24 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN** ×3（6 NOT_RUN 为 5 项工具门检查 + 1 项流中重载，均为既知模式门控） | 0 / 0 / 0 |
| API 面 echo 自检（`run-d3-real-pi.mjs` v1.2.0，同波顺带，非本目录证据面） | 18 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3（6 NOT_RUN 为 1 项流中中止 + 5 项 A5 工具门，均为既知模式门控） | 0 / 0 / 0 |

三份运行 summary 快照见同记录 ID sidecar 目录（`summary-run{1,2,3}.json`；
run/turn 等脱敏 ID 以其 `pageFinalState` 逐只可对照）。summary.json 的
checks 数组与 stdout 全量一致：各 30 行（24 PASS + 6 NOT_RUN）、末行
`console-clean: PASS`、三次运行 checks 数组逐项全等（程序化比对通过；
三次运行均零 page errors、git 读数 head 一致且 dirty=false）——`ae5912b`
（v1.3.2）的 summary 修复口径在 `a88ace5` 复验成立。截图等二进制不入仓，
仅留于运行机 artifacts 临时目录。

本波核对点（与 `1380a39` 基线同断言面全绿）：窄窗 480px 媒查真实命中、
抽屉自底向上 vs 宽窗右侧滑入、reduced-motion 计算样式坍缩、A2 三深选区
（长答案后段 / 重复词第二处 / 跨行）经安全带精确拖选武装、主线阅读全程
不动、相末主树计数不变——导入图改写后的服务进程引导、SSE、全部编排检查
在 `a88ace5`（产品代码与 `1380a39` 全同）照常。

## 同波 offline manifest（`evidence/d3/offline/20260929T235025011Z-evidence-manifest/`）

`npm run record:d3` 在同一 worktree、同一 SHA 上生成（recordedAt
2026-09-29T23:50:25.012Z；生成脚本退出 0）：

- `npm run typecheck` 退出 0；`npm test --workspace @treeai/studio` 退出 0
  （97 tests / 97 pass / 0 fail）；`npm test`（全仓）退出 0——manifest 的
  40 行输出尾只保留末三个工作区块（75+8+3 pass），426/426 的全量计数经
  同 SHA 复跑 `npm test` 逐工作区加总核实（58+54+58+73+97+75+8+3 =
  426 pass / 0 fail，退出 0）；
- `npm run verify:d2` 退出 3：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**
  （`d1-repro` 授权门控 NOT_RUN——离线 PR 不强推真实模型调用）——退出 3
  为既知基线，按 manifest notes 如实登记且不计入生成脚本判据（CI 由
  d2-offline workflow 单独把关）；
- manifest 的 gitDirty 读数为 **true**：读数时点在全部命令跑完之后，当时
  唯一的未提交内容即 verify:d2 自己刚写下的未跟踪 run 目录与 manifest
  自身目录——与 `20260929T200314517Z-evidence-manifest` 同一既知机制；
  录制开始前 worktree porcelain 干净（浏览器 / API 三连跑的 git 读数
  dirty=false 亦旁证）；
- 命令事实（脱敏输出尾、耗时）与产物 SHA-256 见该目录 manifest.json /
  result.md（facts only，不含门禁结论）。

## 本波发现

无新产品缺陷。offline + echo 三个面（浏览器 echo / API echo / offline
manifest）在 `a88ace5` 一次全绿；唯一需要披露的是上节 gitDirty 的既知
机制（自动化读数时序，非产品缺陷，manifest notes 已如实登记）。
