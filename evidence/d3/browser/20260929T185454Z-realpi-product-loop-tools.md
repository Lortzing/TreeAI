# TreeAI D3 浏览器 UI 级操作记录【真实 Pi + 工具门 + 模型错误注入阶段 · 浏览器面首个 0 NOT_RUN】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）+ 模型错误注入**
> —— 与 `20260929T182259Z-realpi-product-loop-tools.md`（`699b2d8`，跑批器 v1.2.0）
> 同一主剧本的复跑，外加 v1.3.0 新增的**模型错误注入阶段**首次真实模型
> 浏览器面录制：此前浏览器面唯一的 NOT_RUN（`model-error-convergence`
> 依赖 echo `/fail` 钩子）自此在 real-pi 模式以错误配置 registry 的
> 重启舞步真实执行（镜像 API 跑批器 v1.2.0 在 `4f29e6c` 落地的同手法）。
> 浏览器面自此**全部 30 项注册检查对真实模型真实执行，0 NOT_RUN**。

## 基本信息

- 记录 ID：`d3-browser-20260929T185454Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T18:54:54Z–18:55:59Z，全程 65 秒）
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：`6bddec52f790`（工作区
  **tracked-clean**（`dirty: false`），运行于该 SHA 的 detached worktree
  ——本波代码提交本身；证据记录随后续提交入仓）
- 记录类别：☑ 浏览器 UI 级真实 Pi 操作　☑ 故障注入（模型错误·真实注入）　☐ 幂等测试　☐ API 面　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` **v1.3.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录> --prompt-timeout-ms 480000`，CDP 驱动本机 headless
  Chrome，真实输入事件：鼠标拖选/点击、⌘/Ctrl+Enter、Esc、原生输入管线）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi 0.85.1；Chrome 153.0.8010.37（CDP）
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名）。错配副本仅改 provider `baseUrl`
  为不可路由回环地址（`http://127.0.0.1:9/`）——连接立即被拒，**绝不产生
  真实 provider 请求**；副本位于系统临时目录，运行后按绿色语义清理
- 数据目录：临时（跑批器自建，运行后清理）；截图不入仓（仅归档位置占位），
  脱敏 JSON 快照见同记录 ID 的 sidecar 目录（3 个文件）
- OS / 目标机器：macOS（arm64），本机 trusted-local headless Chromium（**非**
  负责人目标 Mac 人工面）

## 操作步骤（逐条，30 项注册检查）

结果：**30 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0。
浏览器面注册检查自此**全部真实执行**——`model-error-convergence` 的
echo `/fail` 路径逐字节保留（selftest 原位置执行，本轮三连跑自检
24/0/0/6 全绿），real-pi 路径改经错误配置 registry 的重启舞步。

| # | check | 实测 | 备注 |
| --- | --- | --- | --- |
| 1 | chrome-boot | PASS | Chrome 153，CDP 连通 |
| 2 | studio-boot | PASS | driver pi，/api/health ok |
| 3 | page-boot | PASS | 空态可见，初始焦点落「新建」 |
| 4 | tree-create | PASS | 真实点击建树 |
| 5 | trunk-main-line | PASS | 两轮主干 prompt（t2 走 ⌘+Enter），4 turns，页面与 API 一致 |
| 6 | selection-anchoring | PASS | 真实鼠标拖选出原生选区，affordance 切换 |
| 7 | branch-a-create | PASS | 从真实选区建枝 A，面板带锚点摘录 |
| 8 | branch-a-followups | PASS | 两轮追问（a2 走 Ctrl+Enter），面板 4 turns |
| 9 | switch-navigation | PASS | 面板↔主干真实点击切换，互不串扰 |
| 10 | branch-b-create | PASS | 第二个主干答案上的不同锚点建枝 B |
| 11 | branch-b-followups | PASS | 两轮追问，面板 6 turns |
| 12 | no-context-bleed | PASS | 渲染面板无跨枝 codeword；session entry 路径（parentId 链）双向证明 |
| 13 | return-flow | PASS | 草稿预填 → 全选覆写 → 提交；主干 anchored 卡 confirmed；抽屉「未送达」；服务端一致 |
| 14 | return-delivery | PASS | 下一主干 run 采纳；卡徽标 → delivered；deliveredRunId === t3 run（服务端核实） |
| 15 | model-error-convergence | **PASS** | **本波新增（v1.3.0）**：错配 registry 副本（仅改 baseUrl 为不可路由回环）引导同一数据目录 → 全新探针树（真实 #new-tree 点击）经真实 composer 发同一 prompt → 浏览器渲染失败收敛：横幅 role=alert 携错误码 `unknown`、常驻失败面板 `Run run_f7bfdc17… failed — unknown: …`、composer 复位、`#run-status` idle、页 + 服务端零 turns、诊断面 idle / activeRun null → 原 registry 重启 + 整页刷新：真实侧栏点击选中探针树，失败呈现自权威状态重建（同一 run 前缀 + 同一错误码）→ 同树同一 prompt 成功（run 序列 `failed(unknown) → succeeded`）；相末遏制核查：主剧本树 3 枝 / 11 trunk turns 不变，树集合恰增一棵探针树 |
| 16 | server-restart-recovery | PASS | SIGKILL → 下一动作诚实报错横幅；同数据重启 + 重载保全部 turns 与 3 枝，可续 |
| 17 | missing-session-degradation | PASS | session 文件移走 → 横幅 + fail-closed composer + 恢复入口；还原 → 重载全恢复 |
| 18 | response-loss-midstream | PASS | 流中重载收敛到权威态（占位清除、idle、答案在页） |
| 19 | a11y-semantics | PASS | 横幅 role=alert 可 Tab；抽屉 aria-expanded 双向 + Esc；锚点上下文可编程聚焦 |
| 20 | narrow-window-layout | PASS | 480px：toggle 可见、run-detail 隐藏、抽屉全幅 drawer-up-in（宽窗右侧 360px 对照） |
| 21 | reduced-motion | PASS | prefers-reduced-motion 计算样式坍缩 0.01ms，复位 0s |
| 22 | selection-deep-long | PASS | 13997 字符答案尾部选区，精确偏移 13971–13996（深度 0.998，摘录 25 字符 ≪ 答案——无整答案回退）：三面一致 + 揭示精确 + 可续答；布局注记（文档层级滚动，产品发现，待负责人裁决——决策单附-5） |
| 23 | selection-deep-duplicate | PASS | "alpha" **第二处**出现锚定于精确偏移 12853–12858（第一处在 4731——无首次匹配替换）：三面一致 + 揭示精确 + 可续答 |
| 24 | selection-deep-cross-line | PASS | 跨行选区精确偏移 7788–7891（恰含 1 个换行、摘录保留换行；原生多 rect 选区、端点在不同渲染行）：三面一致 + 揭示精确 + 可续答；相末遏制核查：主剧本树 3 枝 / 11 trunk turns 不变 |
| 25 | tool-policy-boot | PASS | 产品 CLI 工具引导：tools=read、1 个 read root；marker 在 roots[0] 内、canary 物理在所有 read root 之外；真实 new-tree 点击开新鲜探针树（干净 session） |
| 26 | tool-policy-allow-read | PASS | 真实 composer 走完放行读取（run `run_c74090dc…`）：答案含 marker、抽屉显示读取活动、marker 内容进入探针 session 文件 |
| 27 | tool-policy-deny-fail-closed | PASS | 越权读**执行前**被拒（run `run_0840c947…` 收敛 failed(policy-denied) fail-closed），页 + 服务端零 turns，composer 复启，持久失败面板 |
| 28 | tool-policy-deny-provenance | PASS | 用户所见来源：抽屉「read denied — outside every configured read root [no rule]」+ journal tool.decision/runtime.error 行；API 交叉核实；无路径/参数/token 泄漏 |
| 29 | tool-policy-canary-never-read | PASS | 16 文件扫描（受控 agent 目录 + 数据目录含 sessions/journal/DB）：canary 内容未出现；渲染页（含开着的抽屉）无 canary token |
| 30 | console-clean | PASS | 全程零非预期页面 console/Log 错误（两次 SIGKILL 重启窗口与错配 prompt 的 502 均在 expectPageErrors 预期窗口内） |

## 本波发现

- **模型错误注入阶段（issue #6 P0-2 清单第 4 项模型错误腿）首次在浏览器面
  真实注入并录制**：错误配置 registry 的重启舞步（受控 agent 目录副本仅改
  provider `baseUrl` → SIGKILL 同数据目录错配引导 → 探针树失败收敛 → 原
  registry 引导恢复）全程经产品 CLI 与真实浏览器 UI 完成。浏览器面呈现的
  失败事实（横幅 role=alert + 错误码、常驻失败面板、composer 复位、零
  turns、run-status idle）与服务端权威状态逐项交叉核对一致；进程重启 +
  整页刷新后失败呈现自权威状态重建（同一 run 前缀 `run_f7bfdc17…` + 同一
  错误码），同树同 prompt 恢复成功（`failed(unknown) → succeeded`）。
  观察到的错误码为 `unknown`——与 API 面记录（`20260929T180220Z`、
  `180929Z`）一致的现行连接错误分类行为；是否需要更细的连接级错误码仍属
  owner 契约问题。
- **浏览器面自此 0 NOT_RUN**：30 项注册检查（含 5 项工具门、响应丢失、
  三深选区、模型错误注入）全部对真实模型真实执行。echo `/fail` 路径逐
  字节保留（selftest 原位置；本轮 v1.3.0 echo 自检三连跑 24/0/0/6 全绿，
  与 v1.2.0 基线一致）。
- 真实模型一次命中（零 escape 轮）：深选区三场景偏移与 `182259Z` 波完全
  一致（13971–13996 / 12853–12858 / 7788–7891，模型逐字复述指令的确定性
  表现）；工具面 allow/overreach 均首试命中。全程 65 秒。
- 无新产品缺陷；附-5（文档层级滚动）布局注记在 selection-deep-long 中
  如实复现，仍待负责人裁决。

## 结论（仅事实，不声明门禁）

- `6bddec5` 上，浏览器面 30/30 项检查 PASS、0 NOT_RUN、退出码 0——issue #6
  P0-2 故障清单（模型错误 / abort / 进程重启 / session 删除及恢复）自此在
  API 面与浏览器面**均**具备同手法的真实注入 + 界面恢复自动化证据（目标
  Mac 人工面仍属负责人侧）。
- 剩余负责人侧事项不变：目标 Mac 逐屏人工对照（含屏幕阅读器与连续录屏）、
  W1 签署与决策单裁决、3–5 人试用。

## 勘误（2026-09-30 追加，不改动上文）

- 上文结论首条称 issue #6 P0-2 故障清单在 API 面与浏览器面「均」具备真实
  注入证据——其中 **abort 在途注入仅为 API 面检查**（本波次 API 面
  check 18；`evidence/d3/real-pi/20260929T104445Z-faults-abort-restart-session.md`
  §A）。浏览器面注册的 30 项检查不含在途 abort 注入（仅断言 abort 入口
  可见性）；浏览器面实际具备注入证据的故障类为模型错误 / SIGKILL 重启 /
  session 删除 / 响应丢失四类。结论相应收窄为如上范围。
