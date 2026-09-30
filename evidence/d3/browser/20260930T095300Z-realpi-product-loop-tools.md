# TreeAI D3 真实 Pi 浏览器面操作记录【浏览器跑批器 v1.4.0 · issue #7 W1 整改 + 术语波重绑（浏览器面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 真实 Chromium（CDP）
> + 工具策略门（`--pi-tools read`）** —— 本轮把浏览器面证据绑定到
> issue #7 工程波终点 SHA `92a2e3a`，与同波 API 面
> （`../real-pi/20260930T094900Z-product-loop-tools.md`）、离线 manifest
> （`../offline/20260930T095344950Z-evidence-manifest/`）汇合。跑批器
> **v1.4.0** 新增 `new-exploration-flow` 相：经 CDP 驱动**真实
> `window.confirm` 对话框**的取消/确认两路——issue #7 下一步 3 的
> session 重建浏览器面。

## 基本信息

- 记录 ID：`d3-browser-20260930T0953Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 约 2026-09-30T09:53Z，全程约 100 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定）：`92a2e3a`（tracked 干净；`gitDirty: true`
  仅为未跟踪工具产物，同机制披露）
- 记录类别：☑ 浏览器 UI 级真实 Pi　☑ 故障注入　☑ 幂等测试　☑ **v3 §4.4
  新探索浏览器面（真实 confirm 对话框）**
- 驱动方式：入仓浏览器跑批器 `scripts/run-d3-browser.mjs` **v1.4.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录>`），真实输入事件（拖选、Cmd/Ctrl+Enter、Esc、
  原生输入管线打字、CDP 对话框应答）驱动真实 Studio UI

## 环境

- Node 24.21.0 / npm 11.19.0；Pi 0.85.1；本机 Chrome（受控 headless，
  CDP over WebSocket）
- 凭据说明：同 API 面（仅 `TREEAI_STUDIO_API_KEY` 环境注入，值绝不入
  记录/日志）
- artifacts：截图不入仓（evidence 规则）；summary.json 逐项 31 检查

## 结果

**31 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0
（零 escape 轮）。相对上一基线（`a88ace5`，30 项）新增 1 项：

| # | check | 实测 |
| --- | --- | --- |
| 1–17 | 主剧本（A1 双支线 / A3 Return 生命周期——**含 v3 §3.2 新词汇「saved — pending adoption」断言（3ca832a 词汇变更后的修复）** / 模型错误 / SIGKILL 重启 / 响应丢失 / 无障碍 / 窄窗 / reduced-motion） | 全 PASS |
| 18 | missing-session-degradation（**v3 §4.4 断言面**：输入保持可输入、发送 fail-closed、「⑃ Start new exploration」入口出现且可用） | PASS |
| **19** | **`new-exploration-flow`（v1.4.0 新相）**：session 文件移走 → 刷新降级 → 输入首问 → 点换轨 → **真实 confirm 取消**（对话框文案含「NOT restored」如实告知；**零 POST**、横幅仍在）→ 再点 → **confirm 确认** → POST `/new-exploration` → 横幅下线、发送解锁、输入清空、`[new exploration from saved content…]` 标记回合渲染（页面 + 服务器双侧核对：user turn 落库携带标记、trunk 恰 +2 回合、`sessionAvailability` 恢复）；相末 containment（分支集不变） | **PASS** |
| 20–31 | A2 深选区三相（长文后段 / 重复词第二处 / 跨行——浏览器选区 === 面板摘录 === 服务端 origin.selection）+ A5 工具门五项（两段式引导 / marker 读入 / 越权拒绝 / 决策来源 / canary 扫描 17 文件）+ console-clean | 全 PASS |

## 本波发现

无新产品缺陷。对话框工程注记（跑批器内已定型）：CDP 对话框处理采用
**单例一次性监听**（累积监听会在第二个对话框上竞争应答），且期望
**先于点击注册**（对话框可能在 click 的 ACK 之前打开）；未应答的对话
框会阻塞页面——意外对话框一律 accept 解锁。新相在真实模型上一次通过。
