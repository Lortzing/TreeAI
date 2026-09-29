# TreeAI D3 浏览器 UI 级操作记录【echo 自检 · 跑批器加固波（离线回归基线）】

> **驱动类别：echo（离线确定性驱动）——按区域规则醒目标注：本记录永远不是
> 真实 Pi 证据**，只是跑批器 `run-d3-browser.mjs` **v1.3.2**（含 `ae5912b`
> 落地的 summary 写盘 off-by-one 修复）在跑批器加固波修复 SHA `ae5912b`
> 上的离线回归基线，与 `20260929T223256Z-echo-product-loop.md`（`361f528`，
> v1.3.1 基线）承接。本波为跑批器工具面加固波（SDK 级驱动 `--agent-dir`
> 旗标 + 浏览器面 summary 修复，见 `docs/d3/D3-status.md` 该波行）；产品
> 代码零改动（相对 `361f528` 仅 `scripts/` 下两文件）。

## 基本信息

- 记录 ID：`d3-browser-20260929T230615Z-echo-product-loop`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:04–23:06Z，三连跑）
- 操作人（编号 / 角色）：claude-code-treeai-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `ae5912b6ef071fcbd2afe0ab9fa303e4126b8d95`（运行于该 SHA 的隔离
  worktree；三份 summary 的 git 读数 dirty 均为 false——porcelain 干净）
- 记录类别：☐ 真实 Pi　☑ echo 离线自检（回归基线）
- 驱动方式：`node scripts/run-d3-browser.mjs --mode selftest`（真实
  Chromium/CDP + 真实输入事件；echo 驱动的确定性答案）

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome headless（CDP over DevTools WebSocket；127.0.0.1 本地
  回环，无外网；Chromium 153.0.8010.37）；视口 1280×900——≥1180px：
  全程真实运行于并置支线列布局
- Studio：`--driver echo`（零凭据、零外网；echo 答案 = 当前分支可见用户
  文本的精确回声）
- OS：macOS（本机 trusted-local；**非目标 Mac 逐屏录屏口径**）

## 结果

| 套件 | 三连跑结果 | 退出码 |
| --- | --- | --- |
| 浏览器面 echo 自检 | **24 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN** ×3（v1.3.2 基线；6 NOT_RUN 为 5 项工具门检查 + 1 项流中重载，均为既知模式门控） | 0 / 0 / 0 |

三份运行 summary 快照见同记录 ID sidecar 目录（`summary-run{1,2,3}.json`）。
**本波起 summary.json 的 checks 数组与 stdout 全量一致**：各 30 行
（24 PASS + 6 NOT_RUN）、末行 `console-clean: PASS`、三次运行逐项一致、
零 page errors——`ae5912b`（跑批器 v1.3.2）把 summary 写盘移出
`console-clean` 检查体、置于全部检查登记之后的统一收尾（失败路径同样
尽力写盘且绝不掩盖原始错误），既往各浏览器记录「summary.json 写盘时点
早于 `console-clean` 登记、checks 数组少 1 项（stdout 为准）」的既知诚实
口径**就此关闭**（旧记录文本按只追加纪律不改写，本记录自起按新口径；
此前最近一次以旧口径披露的是 `20260929T223539Z-realpi-product-loop-tools.md`）。
截图等二进制不入仓，仅留于运行机 artifacts 临时目录。

本波核对点（与 v1.3.1 基线同断言面全绿）：窄窗 480px 媒查真实命中、抽屉
自底向上（`drawer-up-in`）vs 宽窗右侧 380px 滑入、reduced-motion 计算样式
坍缩、A2 三深选区（长答案后段 / 重复词第二处 / 跨行）在新布局下经
v1.3.1 安全带精确拖选武装、主线阅读全程不动、相末主树计数不变。

## 本波发现

无新产品缺陷（产品代码零改动）。跑批器 v1.3.2 的 summary 修复即本波
内容：summary.json 此前在 `console-clean` 检查体内、早于该行登记写盘，
checks 数组恒比 stdout 少 1 行（stdout 30 PASS、sidecar 29 行）；修复后
写盘移至 main() 全部检查登记后的统一收尾，本波三连跑的 sidecar 与
stdout 逐项全等（各 30 行、含 `console-clean` 行）即为关闭证明。
