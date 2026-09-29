# TreeAI D3 真实 Pi 操作记录

## 基本信息

- 记录 ID：`d3-real-pi-20260929T104445Z-faults-abort-restart-session`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`4a925cd0d8fd7e5a17ec3c009b6d15a4c62ba8b9`（运行代码与该 SHA 一致；工作区另有未提交的 docs/ 文档改动，不影响运行代码）
- 记录类别：☑ 真实 Pi 操作　☑ 故障注入　☐ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：24.19.0（低于仓库锁基线 24.21.0；CI 在干净检出用锁基线验证）
- npm：11.9.0（低于锁基线 11.19.0，同上）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1
- OS / 目标机器：macOS，本机 trusted-local
- Studio 启动参数：`--driver pi --provider deepseek --model deepseek-flash --port <local> --data <临时数据目录> --agent-dir <仓库本地受控目录>`；未读取 `~/.pi`
- 凭据说明：已通过 `TREEAI_STUDIO_API_KEY` 注入；值未写入记录、日志、数据库或 evidence
- 操作方式：脚本经 Studio HTTP API 驱动（非浏览器 UI）

## 操作步骤（逐条）

### A. 中止（abort）

1. 新树上发送长文 prompt（真实模型流式中）；不等待 POST 返回，轮询 `/diagnostics` 观察到 `runtimeState=streaming` 与活动 Run。
2. `POST /runs/:runId/abort` → 200 `{"ok":true}`。
3. 等待中的 prompt POST 以 **409 `{"code":"user-abort","message":"prompt was aborted"}`** 收敛；Run 终态 `aborted`（terminalAt 已写）；`runtimeState` 回 `idle`。
4. 同分支再次 prompt → Run `succeeded`（中止后恢复）。

### B. 宿主重启收敛（kill -9 后重启）

5. kill -9 Studio 进程；同一数据目录重启。
6. `GET /api/trees` 断言树仍在；`GET /state` 断言分支与 turns 完整；启动日志显示 journal 加载 15383 事件；`GET /journal` 可读（本树 50 事件）。诊断面 Run 状态跨重启保持。

### C. 缺失 session（移走 session 文件）

7. 新树：trunk prompt（真实模型）→ 从答案建支线 → 支线 prompt 成功（该支线续聊点引用树内会话文件）。
8. 将该会话文件移出（文件名不入记录）；`GET /state` 断言相关分支 `sessionAvailability=unavailable`（如实投影，不伪装）。
9. 重启后（B 步骤同一重启）prompt 该分支 → **502 `{"code":"session-corrupt","message":"session file does not exist"}`**（fail-closed；无伪造成功）。
10. 恢复动作：从主干最近 assistant 答案 `POST /branches` 建新支线 → 201；对该新支线 prompt → **同样 502 session-corrupt**（见「与预期的偏差」）。

## 脱敏 ID 清单

- abort 树：`tree_1308ddc5`（aborted Run `run_c933be1e`；后续成功 Run 略）
- 重启/缺失 session 树：`tree_a886bb62`（trunk `branch_29f17ae1`、受损支线 `branch_b5c44079`、恢复支线 `branch_e2ad944d`）
- 移出文件数：1（文件名与路径不入记录）

## 注入的故障（如无写"无"）

- 故障类别：中止（真实 Pi 在途停止）＋ 宿主重启（kill -9 后重启收敛）＋ 缺失 session（移走 session 文件后浏览与恢复）
- 注入方式：abort 端点；kill -9 进程后同数据目录重启；文件系统 rename 移走会话文件。均不涉及凭据。
- 观察到的行为：见步骤 3/6/8/9/10——全部如实（409 user-abort / 数据完整收敛 / unavailable 投影 / 502 session-corrupt fail-closed）。

## 结果

- 结论：PASS（中止、重启收敛、缺失 session fail-closed 三项均按契约行为验证）
- 与预期的偏差：**恢复支线的首次 prompt 在整树会话全损模式下同样 502 fail-closed**（步骤 10）。运行时观察：当前 Pi 会话文件为**每树单一谱系**（支线续聊在锚点会话文件上原地追加），文件级缺失使整棵树的续聊点同时不可用；恢复动作可建支线（201，锚点为 DB 内 turn），但新支线的首问仍需锚点会话——因此「从最近可用回答建支线」的完整恢复路径在离线 UI 测试（脚本化按分支可用性）中覆盖，真实 Pi 的整树会话全损下如实 fail-closed。该架构观察建议 owner 在 W1 §6 项下裁定（是否引入按分支独立会话谱系或会话重建）。

## 证据附件

- 录屏 / 截图归档位置：不适用（API 驱动）
- 相关自动化日志：`evidence/d3/real-pi/20260929T104445Z-closed-loop/transcript-faults-2-phase1.json`、`.../transcript-faults-2-phase2.json`（phase2 以 FAIL 记录恢复支线 prompt 断言，步骤数据如实保留）

## 复测

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用；A4 剩余项：响应丢失（断网/杀进程）中 UI 对账的真实 Pi 录屏、目标设备复测——owner 侧。
