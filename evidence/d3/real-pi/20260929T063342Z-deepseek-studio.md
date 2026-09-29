# TreeAI D3 真实 Pi 操作记录

## 基本信息

- 记录 ID：`d3-real-pi-20260929T063342Z-deepseek-studio`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：owner-run / integrator
- commit SHA（运行时工作区 HEAD）：`6ff7146f700d6b8496699061dfb080b72a87b180`
- 记录类别：☑ 真实 Pi 操作　☐ 故障注入　☐ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：24.21.0
- npm：11.19.0
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1
- OS / 目标机器：macOS，本机 trusted-local
- Studio 启动参数：`--driver pi --provider deepseek --model deepseek-flash`
- Pi agent 目录：数据目录内受控 `pi-agent/`；未读取 `~/.pi`
- 凭据说明：已通过 `TREEAI_STUDIO_API_KEY` 注入；值未写入记录、日志、数据库或 evidence

## 操作步骤（逐条）

1. 在受控 agent 目录放入非秘密的 DeepSeek provider/model registry 定义。
2. 启动 Studio Pi driver，确认启动 banner 只显示受控目录和环境变量名。
3. 创建 Tree，保持 Trunk，发送：`Explain the core idea of diffusion policy in two concise paragraphs.`
4. Studio 返回真实模型回答，Run 进入 `succeeded`，页面诊断状态回到 `idle`。
5. 在同一 Tree 的 Trunk 发送：`What is one practical risk when deploying diffusion policies, and how can it be mitigated?`
6. Studio 返回真实模型回答，Run 再次进入 `succeeded`；诊断 API 可查询两条成功 Run。

## 脱敏 ID 清单

- Tree：`tree_b55e6610`
- Branch：`branch_b8cf226a`
- Run：`run_f047900c`
- Return：无

## 注入的故障（如无写“无”）

- 故障类别：无（正常真实 Pi 冒烟）
- 注入方式：无
- 观察到的行为：两次真实 prompt 均成功；页面未显示错误；诊断投影仅含 Run/Branch/状态/时间，不含 session 引用或凭据

## 结果

- 结论：PASS
- 与预期的偏差：真实 Pi 单 Tree/Trunk 两轮冒烟通过；本记录不覆盖两条 Branch、Return、重启、A1–A7 全矩阵或 Gate 2 签署

## 证据附件

- 录屏 / 截图归档位置：本地 Browser preview 操作记录（未将含模型内容的截图上传到仓库）
- 相关自动化日志：`evidence/d3/real-pi/`；Studio journal 保存在本次临时数据目录，不进入仓库

## 复测

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用；仍需完成真实 Pi 两条支线、Return、重启和 3–5 人试用
