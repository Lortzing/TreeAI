# evidence/d3/real-pi/ — 真实 Pi Studio 操作证据

- 定位：负责人（或授权操作者）在**目标机器（目标 Mac）**上记录的真实
  Pi Studio 操作——issue #2 Go 条件的核心证据。覆盖真实任务下的
  A1（主线 + 两条支线，无上下文串扰）、A2（锚点与导航完整操作）、
  A3（Return 语义）、A4（恢复与故障）、A5（Run 与权限）的真实 Pi 验证，
  以及**故障注入与幂等序列**。
- 每次操作一条记录：复制 `evidence/d3/templates/run-record.md` 为
  `real-pi/<UTC-run-id>.md` 填写；不得事后改写，需要补充就追加新记录。

## 必填环境（每条记录）

- Node / npm 版本（锁基线 Node 24.21.0 / npm 11.19.0）；
- Pi 版本（`@earendil-works/pi-coding-agent` 实装版本，锁 0.85.1）；
- OS 与目标机器说明（目标 Mac；不含用户名 / 序列号）；
- Studio 启动参数（driver / provider / model）；API key 只经
  `TREEAI_STUDIO_API_KEY` 注入——记录中**最多出现变量名，绝不出现值**。

## 必测内容（按 issue #2 与 W1 测试义务表）

- **真实任务操作**：A1 场景（两条不同锚点支线、各 ≥2 轮追问）；
- **故障注入**（逐类记录）：响应丢失（断网 / 杀进程）、缺失 session
  （移走 session 文件后浏览与恢复）、宿主重启（kill 后重启收敛）、
  中止（真实 Pi 在途停止）、模型错误（错误配置一次）；
- **幂等序列**：双击提交、同键重试（200 重放）、同键不同内容
  （409 return-conflict）、响应丢失后按 `idempotencyKey` 对账；
- **设计对照录屏**（W2 §5）：逐屏对照含窄窗、键盘焦点、
  `prefers-reduced-motion` 的录屏。

## 规则

1. 只追加；绑定 commit SHA；写盘前后 secret scan（区域规则见
   `evidence/d3/README.md`）。
2. ID 脱敏；录屏 / 截图等二进制**不入仓**，记录内只留归档链接占位。
3. Echo / D2-live 结果**不得写入本目录**冒充真实 Pi 证据。
4. 结论用 PASS / FAIL / BLOCKED / NOT_RUN 如实记录；不声明门禁结论。
