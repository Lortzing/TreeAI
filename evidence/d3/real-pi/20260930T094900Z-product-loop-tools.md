# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.3.0 · issue #7 W1 整改 + 术语波重绑（API 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 本轮把 API 面证据绑定到 issue #7 工程波终点 SHA `92a2e3a`
> （`92a2e3a…`；相对上一记录基线 `a88ace5` 新增：W1 P0/P1 整改
> （`32f4778`——来源定位/续聊分离、显式新探索、降级 Return 卡、文档
> 同步）、术语 ①② 核心 + 冻结质量集（`cd0784c`）、提取提示词紧化
> （`433f448`）、两份术语试标记录（`c6d0fc2`/`3831c9f`），以及**跑批器
> v1.3.0 的 `new-exploration` 相**（`92a2e3a`——issue #7 下一步 3 的
> 新负面路径，不只旧 24 项））。

## 基本信息

- 记录 ID：`d3-realpi-20260930T0949Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 约 2026-09-30T09:49Z，全程约 40 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定，跑批器 stdout 为准）：`92a2e3a`（主 checkout，
  tracked 文件 porcelain 干净；`gitDirty: true` 仅为未跟踪工具产物——
  与既有 manifest 同机制如实披露）
- 记录类别：☑ API 面真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☑ **v3 §4.4
  新探索负面路径**　☐ 浏览器 UI 级（见同波浏览器面记录）　☐ 独立试用
- 驱动方式：入仓 API 面跑批器 `scripts/run-d3-real-pi.mjs` **v1.3.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录>`）spawn 真实 Studio CLI（两段式引导 + 模型错误
  注入引导），HTTP API 驱动 + SSE / journal / diagnostics 断言

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi 0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入
  记录、日志、数据库或 evidence（跑批器只检查变量名）
- 数据目录：跑批器自建临时目录，运行后清理
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标
  Mac 人工面）

## 结果

**25 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0
（零 escape 轮）。

| # | check | 实测 |
| --- | --- | --- |
| 1–10 | 主剧本（boot / 建树 / 主线两轮 / 双支线各两轮 / 交叉切换 / 无串线 / 锚点揭示——**v3 §1.2 分离语义下的 available + navigated**） | 全 PASS |
| 11–13 | Return 生命周期（201 / 200 重放 / 409 冲突 / `deliveredRunId` 恰一次） | 全 PASS |
| 14–16 | SSE / 诊断 / journal 面 | 全 PASS |
| 17 | SIGKILL 重启收敛 | PASS |
| **18** | **`new-exploration`（v3 §4.4，v1.3.0 新相——独立探针树）**：session 文件删除（整进程重启后）→ 普通续聊 **502 fail-closed** → 显式新探索 **200**（首问 succeeded、user turn 携带 `[new exploration from saved content…]` 诚实标记、旧历史 2 回合原样可读、`sessionAvailability` 恢复 available）→ session 已可用再换轨 **409 new-exploration-conflict** → 普通续聊恢复 200；相末主树 containment（分支集与回合数不变） | **PASS** |
| 19 | 在途 abort | PASS |
| 20 | 模型错误注入（不可路由 baseUrl）→ 原配置重启恢复 | PASS |
| 21–25 | A5 工具门（伞项 + 两段式引导 / marker 读入端到端 / 越权读执行前拒绝 fail-closed / 决策来源 / canary 扫描） | 全 PASS |

## 本波发现

无新产品缺陷、无 escape 轮。新相 `new-exploration` 在真实模型上一次
通过（首问成功、标记回合与旧历史并存、409 前置条件如实）——issue #7
P0-2 的「不能以可创建但首问失败交差」在 API 真实面成立。
