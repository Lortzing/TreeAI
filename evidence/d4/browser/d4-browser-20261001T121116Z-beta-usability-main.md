# TreeAI D4 浏览器证据验收记录【echo driver】（B7 自动部分——合并主 SHA 复跑）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**（B7 自动部分的可用性语义不依赖模型
> 回答）。它是 B7 beta-usability 波的**合并主 SHA 复跑**：分支证据（六场景
> 逐项、三个真缺陷修复披露、探针侧时序坑）见
> [`d4-browser-20261001T115206Z-beta-usability.md`](./d4-browser-20261001T115206Z-beta-usability.md)，
> 本记录只登记主 SHA 全量结果与合并复验。**本记录的 PASS 仅覆盖 B7 的自动
> 部分；Mac 体验签收与 3–5 人独立试用仍是负责人 D4-G3 人工序列，不因本记录
> 代签。**

## 基本信息

- 记录 ID：`d4-browser-20261001T121116Z-beta-usability-main`
  （summary runId `d4-browser-20261001T121116-61286`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T12:11Z 起，12:13:51Z 止）
- 操作人（编号 / 角色）：scheduled-unattended / 协调会话（issue #8 §8
  验收入口——B7 自动部分的合并复验，含术语阅读模式波 `cba9ee8` 与术语评测
  基建波 `9459990` 的前端/测试面）
- commit SHA（运行时工作区 HEAD）：
  `67e4786d82be2b87f8a8e87fd7397d60ebdb6018`（**main 合并提交**——
  `wip/d4-beta-usability`（tip `7c8c857`）并入 `cefe56c` 的 no-ff 合并）。
  在 detached worktree 干净检出运行（`npm ci` + `npm run build:deps
  --workspace @treeai/studio` 后），`gitDirty: false`（summary.json 结构化
  记录）；证据目录经显式 `--artifacts` 运行后拷入提交（`diff -rq` 逐文件
  核对字节一致）。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1/B2/B9/B6 既有分母复跑）
  　☐ 真实 Pi（echo；B7 自动部分不涉模型）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.5.0**
  （`--mode selftest` 全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+
  本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实
  DOM/输入/触摸事件。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：本机 Chrome（`--headless=new`，CDP；127.0.0.1 本地回环，无外网）
- OS：macOS 26.6.2 arm64；CPU 10× Apple M4；总内存 16 GiB
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256`（summary.json 记录
  manifest SHA-256 `dc4a18f5…f2202` 与使用 fixture 清单）

## 结果

**15 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**

其中 `d4-beta-usability`（本波主体，与分支证据同语义全绿）：

- README 记载的启动路径在干净临时数据目录真实启动（spawn argv/entry/flags
  与 README + package.json 逐项对账；首启空状态诚实，建树流程真实可用）；
- 宽 1600px + 窄 390px（mobile×2）两档：侧栏/阅读器/支线面板可用、关键
  控件 elementFromPoint 全命中、无横向溢出、捕获条可达；
- 键盘：Tab 33 步遍历到达新建树/导入/搜索/阅读器正文（焦点轮廓可见），
  Enter+Space 激活，Escape 三层关闭各带焦点还原，方向键滚动阅读器；
- 触屏：5 tap + 1 swipe（滚动 405px）+ 1 手势内拖选（PDF 文本层、
  selectionchange 触路径、零鼠标事件，剪贴板回读字节相等）；
- reduced-motion：matchMedia 生效，View-source 跳转与贴底跟随即时落位
  （无在途帧）；
- 草稿回程：草稿保留 + 焦点还原 #panel-view-source + 面板滚动保留 +
  阅读器经自身保存/恢复路径回到关闭前块。

其余 14 项检查在同 SHA 全绿——含合并后的术语阅读模式前端（`cba9ee8` 的
建议条/模式选择器/抽屉改动）在场时的 B1 全分母（24 ready + 11 负例）、
B2 选区全分母（45 md + 30 pdf）、B3 echo 用户路径、B5 导出恢复组合路径、
B9 导航面（p95 47.9ms、虚拟化 5000 节点 19 DOM 行、重启保持）、B6 规模面
（opens p95 28.4ms、翻页零 longtask、击键 17.9ms）——**术语阅读模式波的
UI 新增未破坏任何既有浏览器面语义**。逐项以 `summary.json` 与各 sidecar
JSON 为准。

## 运行披露

- 首次主 SHA 运行（12:0xZ）在 studio-boot 失败：detached worktree 只做了
  `npm ci` 未构建 workspace 依赖（`@treeai/event-journal/dist` 缺失）——
  环境准备遗漏，非产品失败；补 `build:deps` 后两次全量运行均 15-0-0
  （第一次的临时 artifacts 目录被环境清理未留存，本记录采用第二次
  `--artifacts` 持久化运行，两次结果一致）。

## 合并复验（同 SHA `67e4786`，主检出串行执行）

- `npm run typecheck`：PASS（7 个有源码 workspace）
- `npm test`：**791/791，0 fail**（58+73+58+73+406+112+8+3；相对波前基线
  789 + C 支 2 项新测试）
- `npm run verify:d4`：**19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，exit 3
  （NOT_RUN = b8 负责人目标机门禁；b7-beta-usability 经本证据审计翻 PASS）
- `npm run verify:d4:selftest`：控制组 + 9 项故障注入全部检出
- `npm run verify:d2`：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，exit 3
  （NOT_RUN = D1 live 显式门控）

## 限制与如实声明

- echo 驱动：不构成真实 Pi 行为证据；B7 自动部分语义不依赖模型回答。
- **PASS ≠ B7 全过**：Mac 体验签收与 3–5 人独立试用属负责人 D4-G3 人工
  序列（项目书 §7 顺序），本记录不代签。
- 本地机器工程证据（环境见上），不跨机器宣称。
- 探针侧时序坑（分支记录已披露）：headless Chrome 153 触摸相位与键盘相位
  的调度交互、长按不合成持久选区（以 Selection API 手势内置位——被测的
  selectionchange 武装路径不受影响）。
