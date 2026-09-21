# Gate 0 Integrator 脚手架验证记录（手写记录，非 verify-d2 运行产物）

- 记录者：Integrator
- 执行时间：2026-09-21T08:15–08:25Z（本机 UTC；命令逐条实际执行，退出码为真实捕获值）
- 验证对象：D2 Gate 0 Integrator 交付的 npm workspace 脚手架
- 环境：macOS (darwin 25.6.0)、Node `v24.21.0`、npm `11.19.0`（与 DECISION-003 基线一致）
- 说明：本文件是 Integrator 的手写验证记录，不是 Agent F `scripts/verify-d2` 的运行产物（该验收器尚未实现）。Gate 0 的正式签署以 `coordination/d2/CONTRACT-FREEZE-1.md` 上的 Integrator "通过"记录为准，本记录不构成 Gate 0 通过声明。
- 时间边界：验证期间 Agent A 正在并行交付 `packages/contracts`（验证快照时点已含 9 个 src 文件、无 index.ts/tests）；`npm run typecheck` 对 contracts 的通过仅代表该时点状态。

## 命令与真实退出码

| # | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `npm install`（首次，生成锁文件） | 0 | 生成 `package-lock.json`（lockfileVersion 3）。首次尝试因 `workspace:*` 协议报 `EUNSUPPORTEDPROTOCOL`，改为 npm 原生的精确版本匹配（`@treeai/contracts@0.0.0`）后成功；后续 Agent A 将 contracts 升至 `0.1.0`，Integrator 对齐各依赖方后重新生成锁文件，再次 exit 0 |
| 2 | `npm ci` | 0 | 从锁文件干净安装（两次执行均 exit 0：版本对齐前后各一次） |
| 3 | `npm run typecheck` | 0 | 真实运行 `tsc 5.9.3`。checked：`@treeai/runtime-smoke`（骨架标记文件）、`@treeai/contracts`（Agent A 交付中，该时点编译通过）；skipped（显式报告、不计入已检查）：`runtime-pi`、`persistence`、`tool-policy`、`event-journal`（尚无 src 源码，等待模块负责人） |
| 4 | `npm test` | 3 | `NOT_IMPLEMENTED`（Gate 0 占位；测试运行器未接入） |
| 5 | `npm run test:integration` | 3 | `NOT_IMPLEMENTED`（Wave 2 / Gate 2 项） |
| 6 | `npm run verify:d2` | 3 | `NOT_IMPLEMENTED`（Agent F 交付 `scripts/verify-d2` 前的占位） |
| 7 | `npm run verify:d2:live` | 3 | `NOT_IMPLEMENTED`（受控凭据环境，Gate 2 / 负责人门） |
| 8 | `npm ls @earendil-works/pi-coding-agent` | 0 | 唯一依赖方 `@treeai/runtime-pi`，解析为精确 `0.85.1` |

## 版本锁定核验（package-lock.json）

- `node_modules/@earendil-works/pi-coding-agent` → `0.85.1`（精确，无 `^`/`~`/范围）
- `node_modules/typescript` → `5.9.3`（精确）
- `node_modules/@types/node` → `24.13.5`（精确）
- 根 `engines`：`node 24.21.0`、`npm 11.19.0`；`packageManager: npm@11.19.0`
- 六个 workspace 全部以 symlink 链接（`node_modules/@treeai/*` → `packages/*`、`apps/runtime-smoke`）

## Pi 类型隔离核验

- `@earendil-works/pi-coding-agent` 作为依赖只出现在 `packages/runtime-pi/package.json`；
- 对 `packages/`、`apps/`、`scripts/` 的源码 grep：无任何 Pi import（文档中的政策性提及除外）；
- `npm ls --all` 确认依赖树中 Pi 仅挂载于 `@treeai/runtime-pi` 之下。

## d1-spikes 只读核验

- `git status --short -- d1-spikes/` 无任何修改；未移动、未改写任何 D1 证据。

## 已知事项（非阻塞）

1. npm 11 的 install-scripts 提示：Pi 的传递依赖 `esbuild@0.28.1`（postinstall）、`protobufjs@7.6.5`（postinstall）、`@google/genai@1.52.0`（preinstall，no-op）的安装脚本未获 allowScripts 批准、未执行。Gate 0 仅做类型检查、无运行时使用，不受影响；Agent B 进入 PiRuntime 实测前需评估是否 `npm install-scripts approve`（届时按 dependency request 流程记录）。
2. 内部 workspace 依赖采用精确版本匹配（无 `workspace:*`——npm 不支持；无 `*`/范围——任务书禁止）。contracts 版本升级需 Integrator 同步更新四个依赖方与 runtime-smoke 的声明并刷新锁文件（本次 0.0.0→0.1.0 对齐即为一次执行）。
3. 占位命令的退出码 3 沿用任务书 §5 验收器约定（无 FAIL 但存在 NOT_RUN）；这些命令在任何报告中不得记为 PASS。

## 追加：最终快照（2026-09-21T08:25Z 左右）

验证期间 Agent A 持续并行交付 contracts（src 增至含 `index.ts` 在内的 10 个文件，并新增 `tests/`）。最终复验快照：

| 命令 | 退出码 | 说明 |
|---|---|---|
| `npm run typecheck` | **1** | `packages/contracts/tests/type-tests.ts(194,47): error TS1128`——Agent A 写入中间态的语法错误（其独占范围内的在制品，Integrator 未改动）。`@treeai/runtime-smoke` 通过；编排器如实报告 `@treeai/contracts` FAIL |
| `npm test` | 3 | 占位行为不变 |
| `npm ci` | 0 | 锁文件安装不受 TS 源码影响 |

结论修正：上表 #3 的 typecheck exit 0 仅代表 08:20Z 时点；当前时点 exit 1（Agent A 在制品）。Gate 0 验收项 "`npm run typecheck` 成功" 以 Agent A 交付完成后的复验为准，本记录不将其记为已达成。
