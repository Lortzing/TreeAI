# TreeAI D3 浏览器 UI 级操作记录【真实 Pi + 工具门 · 视觉重构波（浏览器面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools
> read`）+ 模型错误注入引导** —— 跑批器 `run-d3-browser.mjs` **v1.3.1** 在
> 视觉重构波最终 SHA `361f528` 上的全检查录制：重构后的 UI（58px 顶栏 +
> 如实位置路径、Forest/Branches 侧栏、**≥1180px 并置支线列**、限高骨架/
> `#conversation` 内部滚动器）首次对真实模型完成全剧本 + A2 三深选区 +
> 模型错误注入 + 工具门。本记录含**一次如实登记的失败尝试与本波修复**
> （见「本波发现」）。

## 基本信息

- 记录 ID：`d3-browser-20260929T223539Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T22:34:20–22:35:39Z，全程约 80 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `361f528fe67502d5ed6ac74581194e55ad09f2bc`（运行于该 SHA 的隔离
  detached worktree；porcelain 干净）
- 记录类别：☑ 浏览器 UI 级真实 Pi 操作　☑ 故障注入　☑ 权限拒绝路径　☐ 独立试用
- 驱动方式：`node scripts/run-d3-browser.mjs --mode real-pi --provider
  deepseek --model deepseek-flash --pi-tools read --agent-dir <受控目录>
  --prompt-timeout-ms 480000`（真实 Chromium/CDP + 真实输入事件：拖选、
  ⌘/Ctrl+Enter、Esc 分层、原生输入管线；两段式引导 + 模型错误注入引导）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Chrome headless（CDP，本地回环）
- 视口 1280×900——**≥1180px：全程真实运行于并置支线列布局**（支线面板
  打开恰好覆盖常驻列、主干阅读宽度不随开合变化；`#conversation` 为真实
  内部滚动器——附-5 选项 A 骨架）；窄窗检查项以 480px 媒查真实命中
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未入记录/
  日志/evidence（跑批器只检查变量名）
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标 Mac
  人工逐屏录屏口径）

## 结果

**30 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**（退出码 0；零 escape 轮、
零重试）。逐面事实：

| 面 | 实测 |
| --- | --- |
| 主剧本（boot / 建树 / 主线两轮 / 双支线各两轮 / 交叉切换 / 无串线（含 session entry parentId 路径证明）/ Return 草稿→确认→`deliveredRunId` 送达反查） | 全 PASS（主线阅读全程不动——并置列下开合期间语义保持） |
| 故障注入（SIGKILL 重启收敛 / 缺失 session 降级+恢复 / 真实模型流中整页重载响应丢失 / 错误配置 registry 模型错误引导 → 502 `unknown` → 原配置重启恢复 `failed(unknown) → succeeded`） | 全 PASS |
| a11y / 窄窗 480px（媒查真实命中、抽屉自底向上 `drawer-up-in`、`#run-detail` 收起）/ reduced-motion 计算样式坍缩 | 全 PASS |
| A2 三深选区（真实拖选，动态期望） | 长答案后段 **13971–13996**（深度 0.998，25 字符摘录 ≪ 答案）；重复词**第二处** **12853–12858**（首处 4731）；跨行 **7788–7891**（恰一个换行、原生多 rect、两端不同渲染行）——三面全等（浏览器 === 面板摘录 === 服务器 `origin.selection`）、揭示切片恰切、锚定支线可续聊、相末主树计数不变（3 分支 / 11 干线回合） |
| A5 工具门（两段式引导 / marker 读入端到端（run `run_11bda403…`，答案携带 marker、抽屉呈现读活动、marker 内容到达探针 session 文件）/ 越权读**执行前拒绝** fail-closed（run `run_12f42382…`，零回合落库、页面与服务一致）/ 拒绝来源三面呈现（抽屉 + journal + `/diagnostics`，无路径/参数外泄）/ canary 16 文件扫描不出现） | 全 PASS |

summary 快照见同记录 ID sidecar 目录 `summary.json`（已知诚实口径：写盘
时点早于最后一项 `console-clean` 登记，checks 数组 29 PASS，stdout 30 为准）。
截图等二进制不入仓。

## 本波发现（如实登记：一次失败尝试 → 定位 → 修复 → 复绿）

- **失败尝试（`21b38f6`，UTC 约 22:14–22:16Z，未入仓为记录、仅本节披露）**：
  同剧本以跑批器 v1.3.0 首录，**29 PASS / 1 FAIL**——唯 `selection-deep-cross-line`
  失败：`offsets: null`、答案 turn 未武装。事实链：该轮真实模型把跨行 marker
  段复述在答案**前部**（动态期望落位早期、合法）；跑批器安全带按**窗口高度**
  `[80, 820]` 判定拖选落点「已入带」而未滚动；限高骨架下 `#conversation`
  的可视带实为 `[58, ~660]`（上沿顶栏、下沿 composer）——落点 y≈723/775
  实际在**容器裁剪沿之下、composer 之上**，原生选区逃出答案 turn，武装
  失败。产品代码全程行为正确（选区不在 turn 内 → 如实不武装）。
- **定位**：以 echo 驱动 + 独立 CDP 复现脚本对失败几何（目标窗口位于容器
  裁剪沿之下）逐项复现，实测 `#conversation` 可视带 `[58, 660]`、composer
  `[660, 813]`，确认按压/释放落点命中 composer。
- **修复（`361f528`，跑批器 v1.3.1）**：`dragSelect` 安全带改为「窗口带与
  最近滚动容器可视矩形的交集」（容器带 24px 边距）；目标在裁剪沿之下时
  如常触发滚动轮，滚入容器安全带后再拖选。修复以独立复现（自「窗口远在
  裁剪沿之下」的滚动状态起，修复后逻辑滚入并武装出精确跨行选区）+ echo
  自检 24/0/0/6 ×3 + 本记录的真实模型全绿共同验证。
- **本轮（`361f528`）**：三深选区偏移与 `0f9df98`/`699b2d8`/`6bddec5` 三波
  **逐字节一致**（13971–13996 / 12853–12858 / 7788–7891）——跨行窗口回到
  marker 的设计位（`insertAfter20`，约 55% 深度），v1.3.1 下拖选一次武装，
  零 escape 轮。
