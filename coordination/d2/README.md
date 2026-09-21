# coordination/d2/ — D2 协作区

- 区域维护：Integrator（本 README 与模板）；各状态/交接文件由对应 Agent 独占维护。
- 依据：`TreeAI_D2_Agent执行任务书.md` v1.0 §2（所有权）、§2.2（工作区纪律）、§9（交接格式）、§12（启动指令）。

## 文件约定

| 文件 | 写入者 | 说明 |
|---|---|---|
| `agent-a-status.md` … `agent-f-status.md` | 各 Agent 本人 | 启动记录与进行中状态。**只允许对应 Agent 创建和写入**；Integrator 不代写。 |
| `agent-<id>-handoff.md` | 各 Agent 本人 | 阶段交付交接，格式见任务书 §9（状态 / 完成内容 / 修改文件 / 验证命令与退出码 / 证据 / 已知限制 / 接口偏离 / Pi 改造需求 / 需要 Integrator 处理）。 |
| `agent-<id>-dependency-request.md` | 各 Agent 本人 | 新依赖申请，从 `dependency-request-template.md` 复制填写。 |
| `integrator-status.md` | Integrator | Integrator 启动记录、验证结果、收口状态。 |
| `CONTRACT-FREEZE-1.md` | Agent A 起草，Integrator 签署"通过" | Gate 0 契约冻结记录。 |
| `CONTRACT-CHANGE-xxx.md` | Agent A 起草，Integrator 批准 | 冻结后的破坏性契约修改。 |

## 启动要求（任务书 §12）

任何 Agent 在修改生产代码前，必须先在自己的状态文件写入：已读材料、理解的边界、计划修改目录、预计验证命令和任何阻塞。没有启动记录的 Agent 不得修改生产代码。Gate 0 通过前，除 Agent A 与 Integrator 外只能阅读材料、编写本角色设计说明。

## 状态值定义（任务书 §9）

- `PASS`：全部执行并满足断言。
- `FAIL`：已执行，结果不满足断言。
- `BLOCKED`：已尝试但被凭据、环境或负责人决定阻塞。
- `NOT_RUN`：未执行；必须写明原因，不能伪装为 PASS。

## 统一命令退出码（任务书 §5，Agent F 验收器；Gate 0 占位命令同样遵守）

| 退出码 | 含义 |
|---|---|
| 0 | 全部请求的检查 PASS |
| 1 | 验收器自身错误 |
| 2 | 至少一项 FAIL |
| 3 | 无 FAIL，但存在 BLOCKED 或 NOT_RUN |

Gate 0 期间 `npm test` / `npm run test:integration` / `npm run verify:d2` / `npm run verify:d2:live` 由 `scripts/gate0-status.js` 占位，输出 `NOT_IMPLEMENTED` 并退出 3。Agent F 交付 `scripts/verify-d2*` 后，由 Integrator 切换根 `package.json` 的 script 指向；根 `package.json`、`package-lock.json`、`tsconfig.base.json` 只由 Integrator 修改。

## 新依赖流程（任务书 §2.2）

1. Agent 复制 `dependency-request-template.md` 为 `agent-<id>-dependency-request.md` 并填写。
2. Integrator 审核用途、版本、替代方案与风险后统一安装（更新根/对应 workspace 的 package.json 与锁文件）。
3. 未经申请与批准，Agent 不得自行改锁文件或根配置。
4. 已锁基线：Node `24.21.0`、npm `11.19.0`、TypeScript `5.9.3`、`@types/node` `24.13.5`、Pi `@earendil-works/pi-coding-agent` `0.85.1`（仅 `packages/runtime-pi`）。禁止 `latest`、`*`、范围版本、未固定 commit 的 Git 依赖。

## 秘密纪律

任何写入仓库的内容（代码、fixture、日志、证据）不得包含真实凭据；`.gitignore` 只是第一道防线，正式门禁是 Agent F 的 secret scan。Pi 凭据（`auth.json`/环境变量）归 Pi 管理，TreeAI 不复制、不代理存储（ADR-001 §4.6）。
