# TreeAI D3 真实 Pi 操作记录

## 基本信息

- 记录 ID：`d3-real-pi-20260929T104445Z-faults-model-error`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`4a925cd0d8fd7e5a17ec3c009b6d15a4c62ba8b9`（运行代码与该 SHA 一致；工作区另有未提交的 docs/ 文档改动，不影响运行代码）
- 记录类别：☑ 真实 Pi 操作　☑ 故障注入　☐ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：24.19.0（低于仓库锁基线 24.21.0；CI 在干净检出用锁基线验证）
- npm：11.9.0（低于锁基线 11.19.0，同上）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1
- OS / 目标机器：macOS，本机 trusted-local
- Studio 启动参数：`--driver pi --provider deepseek --model deepseek-flash --port <local> --data <临时数据目录> --agent-dir <受控目录>`；未读取 `~/.pi`
- 凭据说明：已通过 `TREEAI_STUDIO_API_KEY` 注入；值未写入记录、日志、数据库或 evidence
- 操作方式：脚本经 Studio HTTP API 驱动（非浏览器 UI）

## 操作步骤（逐条）

1. 准备受控 agent 目录副本，仅将 provider `baseUrl` 改为不可路由地址（`http://127.0.0.1:9`），其余 registry 字段不变；以该目录启动 Studio（独立端口与数据目录）。
2. 建树并在 trunk 发送 prompt（错误配置一次）→ prompt POST 以 **502** 返回，错误消息为连接错误；`GET /diagnostics` 显示该 Run 终态 `failed`（failure code `unknown`——现行分类器将连接错误如实归为 unknown，未伪装成功）；`runtimeState` 回 `idle`。
3. 停止服务器，将 agent 目录换回正常受控目录（真实 API 端点），同一数据目录重启。
4. 同一树的 trunk 再次 prompt → **200，Run `succeeded`**；诊断面 Run 序列呈现 `failed(unknown) → succeeded`，树继续可用（错误恢复）。

## 脱敏 ID 清单

- Tree：`tree_36822e28`
- Branch（trunk）：`branch_ac41ba12`
- Run：错误 Run 与恢复 Run 见诊断序列（failed(unknown) → succeeded）

## 注入的故障（如无写"无"）

- 故障类别：模型错误（错误配置一次）
- 注入方式：受控 agent 目录内 provider baseUrl 指向不可路由地址（一次）；修复 = 换回正常受控目录并重启。不涉及凭据（API key 全程经环境变量注入且未变）。
- 观察到的行为：502 + Run failed（code unknown）+ runtimeState 回 idle；修复后同树继续成功。

## 结果

- 结论：PASS
- 与预期的偏差：连接错误未被分类为专用模型错误码（记为 `unknown`）——如实记录现行分类行为；是否需要更细的连接级错误码属 owner 契约决定（W1 §6 开放项口径）。

## 证据附件

- 录屏 / 截图归档位置：不适用（API 驱动）
- 相关自动化日志：本记录步骤与状态码为驱动脚本控制台输出（ID 与状态，不含模型内容）；无独立 transcript 文件。

## 复测

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用
