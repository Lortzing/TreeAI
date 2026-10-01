# TreeAI 术语①②③真实 Pi 浏览器证据验收记录（issue #7 下一步 2——terminology-path 探针）

> **驱动类别：真实 Pi（受控 provider/model）** —— 本记录是真实模型回答下的
> 真实浏览器纵向路径证据（真实 headless Chrome + 真实 Studio 进程 + 真实
> Pi：主干提问 / 术语解释 / 推广首问 / 支线追问全部真实模型回答）。它是
> issue #7 2026-09-30T14:18:27Z 增量验收②③行「真实浏览器+真实Pi」待验项
> 的术语半边证据（材料半边由 B3 real-pi
> `d4-browser-20261001T081056-32568-realpi-b3` 先例覆盖）。

## 基本信息

- 记录 ID：`d4-browser-20261001T144617-20806-realpi-terminology`
  （summary runId `d4-browser-20261001T144617-20806`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T14:46Z 起）
- 操作人（编号 / 角色）：scheduled-unattended / 波次会话（issue #7 下一步 2
  术语半边波次 `wip/term-browser-path`）
- commit SHA（运行时工作区 HEAD）：
  `450b9d725f4b50fcdc7e09cb5df8b2da98a11c48`（分支 tip；`gitDirty: false`
  ——summary.json 结构化记录；证据目录经临时 `--artifacts` 运行后拷入提交，
  `diff -rq` 逐文件核对字节一致）
- 记录类别：☑ 浏览器 UI 级操作　☑ 真实 Pi（术语解释/推广首问/追问为真实
  模型回答）　☐ 人工签收（owner）　☐ 独立试用（owner）
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.6.0**
  （`--mode real-pi --only terminology-path`——boot 检查恒随行；scoped 如实
  入 summary，不冒充全量）。受控配置：凭据经环境注入（值只存在于子进程
  环境；命令/截图/证据零接触——studio.log 仅出现变量名
  `TREEAI_STUDIO_API_KEY` 与模型标识 `deepseek/deepseek-flash`，与 B3
  real-pi 先例同口径）；`--agent-dir` 指向受控注册表 `.pi-d2-live`；
  `--prompt-timeout-ms 240000`。
- 浏览器：HeadlessChrome 153（`--headless=new`，CDP；127.0.0.1 本地回环，
  无外网）；基准视口 1280×900（探针内按场景切换 1600×900 / 390×844）
- OS：macOS 26.6.0 arm64（Apple M4）；Node 24.21.0 / npm 11.19.0

## 结果

**5 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**
（scoped：terminology-path + 4 项 boot 检查；terminology-path 本体
46.2s——13 次真实模型调用：主干两问、term/range 两次解释、两次推广首问、
四次支线追问、重启续走追问、另开首问。）

### 逐项（真实模型回答下的断言）

- **① 阅读模式**：抽屉三选一真实切换（PUT 载荷传输层观测 + 服务端回读 +
  pressed 迁移）；gate 未过如实旁注在场；manual-only 与 minimal-hints
  回答（真实模型，202 units 锚点答案）后**零自动派发**（服务端任务 0 /
  usage requests 0 / 建议集 0 / 建议条不渲染 / 隔离执行器 sessions 零文件）。
- **② term 纵向**：真实鼠标连续拖选真实模型答案中的「Lasso」（[55,60)）→
  工具条武装（term 模式）→ 解释卡：**真实模型解释 581 units，非空且含
  原词** → 保存批注（活覆盖）→ 推广建枝（双击提交**恰一次派发**，busy 锁 +
  服务端幂等键；恰 1 条首问 user turn + 真实模型 assistant 回答 + 批注推广
  绑定）→ ≥2 轮真实模型追问 → Return 回主线（术语来源卡：
  `anchored on "Lasso" from Trunk` + `saved <时间>` + 来源分支；服务端
  fromBranchId 对账）。
- **② range 纵向**：真实连续拖选「回归是其中一种，采用参数绝对值之和
  （L1 范数）作为」（[61,87)，与 term 相邻不重叠——中文重回答下锚定词
  路径缺席、走 term 后空白窗口兜底（本波探针整改，见下））→ 解释卡：
  **真实模型解释 325 units 非空**（选区无 ≥3 字符英文词——「含原文词」
  断言如实降级为非空 + sidecar 记录 n/a）→ 保存批注（双覆盖并存）→
  ③草稿/焦点回程（renderAll 后草稿保值 + 焦点还原）→ **响应丢失**：
  CDP Fetch Response 阶段丢弃 promote 响应（恰 1 次；服务端已完整落地）→
  卡面如实冲突 + 对账揭示既有推广 → **恢复**（恰 1 条首问 user turn、
  分支恰 +1、恢复后不变）→ ≥2 轮真实模型追问 → Return（划线摘录来源卡）。
- **② SIGTERM 重启**：停进程 → 同数据目录新进程（bootStudioOn 新端口；
  口径披露：探针专用目录语义——重启断言全部服务端持久事实，不依赖浏览
  器 localStorage）→ 批注覆盖（双 mark）/ 抽屉批注列表（promoted-to 注记）/
  Return 卡 / 支线历史可读 → 续走追问（真实模型）落地。
- **② 已有探索恢复**：重选「Lasso」→「✓ Follow-up exists」→ 已存批注卡
  →「Open the follow-up branch」→ 同一分支重入（分支数不变、全历史在场）。
- **② 显式另开**：同选区通用建枝入口 → 新分支（与两条推广分支互异、同
  锚点同选区）→ 首问（真实模型）落地；批注推广指向不变。
- **③ 前端不变量**：选择期间不重绘（武装选区跨真实 renderAll——turn 元素
  与正文文本节点身份保持）；复制不变（浏览器 copy 命令 + 剪贴板回读与
  turn 原文**字节相等**）；宽 1600/窄 390 两档 elementFromPoint 命中
  （工具条/解释卡/抽屉三选一），窄档无横向溢出；草稿/焦点回程；Esc 关卡
  焦点回 composer；滚动（issue #3 不变量：重渲不强制滚底）。

## 真实模型非确定性的如实处理（本波 4 次真实运行）

1. 第 1 次（14:32Z）：**全绿**（runId `d4-browser-20261001T143214-17149`，
   term=「regularization」英文重回答——锚定词路径；gitDirty true——当时
   .md 未入提交，按纪律废弃重跑）。
2. 第 2 次（14:35Z）：**FAIL @ 双覆盖断言**——真实模型给出中文重回答
   （仅「Lasso」一个 ≥3 字符英文词），探针 pickRange 的「全文首个空白
   窗口」兜底产出与 term 重叠的 range [50,67) vs [49,54)——正文区间覆盖
   按产品语义跳过重叠批注（不双重下划线，by design），探针「双覆盖并存」
   断言违反自身不重叠前提。**探针侧缺陷**（非产品缺陷）：兜底改为 term
   之后的空白窗口（结构上不重叠；提交 `450b9d7`）。
3. 第 3 次（14:40Z）：诊断运行（sidecar 记录服务端批注 + DOM marks +
   计划选区）确认上述根因。
4. 第 4 次（14:46Z，本记录）：**全绿**——中文重回答（「Lasso」+ 空白窗口
   兜底 range）全程通过；解释断言含如实降级口径（选区无英文词时非空 +
   n/a 记录）。

## 如实限制

- scoped 运行（--only terminology-path）：未重跑 D4 材料半边的 real-pi
  路径（B3 先例证据在案；全量 selftest 16-0-0 见
  `d4-browser-20261001T142535-15614-terminology-path`）。
- 解释「含原文词」断言在选区无 ≥3 字符英文词时降级为非空（真实模型
  中文回答的可能形态；sidecar 记录 n/a）。
- 建议 chip 预填/确认路径不可行使（gate 生产恒关；探针不得改 gate）。
- 精确滚动位置恢复不断言（瞬态内容状态下的滚动事件时序；见 echo 记录
  的披露与 reconcileTopLevel 整改）。
- 合成键盘加速键不触发平台复制（浏览器 copy 命令替代 + 披露）。
- 重启为新端口（探针专用数据目录语义）。
- 单机本地证据（环境入 sidecar；不跨机器宣称；Mac 签收/独立试用属 owner
  序列，本记录不构成人工验收）。
