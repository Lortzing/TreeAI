# Agent D Handoff

## 状态
PASS

## 完成内容

`@treeai/tool-policy` 应用层工具策略引擎（默认 deny），全部按任务书
§5 Agent D「必须完成」8 项实现：

1. **默认 deny，只有显式规则 allow**。`ToolPolicyEngine.evaluate()` 对
   未命中显式规则的操作一律 `deny`（`ruleId: null`）；默认配置
   `DEFAULT_TOOL_POLICY_CONFIG`（全空 roots + `allowShell/allowNetwork:
   false`）拒绝一切。类别直接使用 contracts 的封闭联合
   `ToolActionCategory`（read/write/shell/network/other-high-risk），
   风险映射 read=low、其余=high。`readRoots`（含 fixtures 目录）与
   `workspaceRoots` 全部由调用方传入（DECISION-005：不硬编码目录），
   readRoot 内读取 allow，shell/network 默认拒绝、仅显式配置后 allow。
2. **写入约束与授权**。写入目标必须规范化后落在 `workspaceRoots` 内
   （否则 deny），workspace 内无授权 → `require-approval`（不是
   allow）；授权匹配四要素：类别相等 + canonical 路径严格相等 +
   workspace 范围（签发时校验并固化，越界目标签发抛 TypeError）+
   有效期（`now < expiresAt`，到达即失效）。每笔授权必须带显式
   `expiresInMs > 0`（不存在无期限授权）；`singleUse` 默认 true
   （逐次授权，产生一次 allow 即消费，不可复用）；仅 write 与
   other-high-risk 可授权（read 走 readRoots，shell/network 走负责人
   级配置，不开口子）。
3. **不可信路径的可靠处理**。`canonicalizePath` 为物理逐段解析，
   全程不做词法折叠：`..` 弹出当前物理路径的父目录（内核语义），
   符号链接逐段用 `realpathSync.native` 解析；覆盖绝对/相对路径
   （按配置 cwd 解析）、`..` 穿越、符号链接逃逸、大小写差异
   （已存在组件在大小写不敏感 FS 上收敛到盘上真实大小写、大小写
   敏感 FS 上 fail closed）、尚不存在的目标（规范化到最近存在祖先）
   、悬空符号链接（null → 拒绝；`O_CREAT` 会穿透链接目标）、不存在
   后缀中的 `..`（null → 拒绝；OS 打开必然 ENOENT）。任何解析失败
   返回 null，一律当作拒绝（fail closed）。
4. **契约与脱敏**。`evaluate()` 返回冻结的 contracts
   `ToolDecision`（outcome/category/risk/reason/ruleId/scope.roots）。
   审计结构性脱敏：命令/主机只记 `hasCommand`/`hasHost` 存在性标志，
   引擎从不读文件正文，`reason` 全部固定模板（`REASONS`），action
   标签按 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/` 净化。安全表述纪律：
   README、错误消息、reason、审计不宣称安全边界——全部标注「应用层
   策略，不是 OS 沙箱，不构成安全边界」。
5. **授权接口无 UI**。`engine.authorizations`（issue/revoke/consume/
   purgeExpired/listActive/findMatchingGrant）为宿主侧编程接口；审批
   UI/人机交互不在本模块。目录配置 API（`ToolPolicyConfig` +
   `DEFAULT_TOOL_POLICY_CONFIG` + `resolveToolPolicyConfig`，构造期
   规范化 roots、不可解析 root 抛 TypeError）与策略默认值在
   `src/config.ts` 与 README「目录配置 API 与默认值」中明确。
6. **测试**（Node 内置 runner，fixture 全部临时目录 + after() 清理）：
   58 用例覆盖任务书「必须测试」全部 7 项（明细见
   `agent-d-status.md` §2.1 覆盖对照）。
7. **交付文档**：`packages/tool-policy/README.md`（威胁模型、不能防御
   的风险 10 项、应用层非沙箱声明（显著置顶）、使用示例与限制）。

实现过程中的两个关键安全发现（已落实现、测试与文档）：

- **词法 `..` 折叠是逃逸向量**：`path.resolve`/`path.normalize`/Node
  默认 JS realpath 都会先把 `ws/link/../f`（link → 外部）折叠成
  `ws/f`（workspace 内）。实测 Node 24.21.0 / darwin 25：JS realpath
  返回折叠值，`realpathSync.native` 返回真实位置。最终算法对不可信
  输入全程不做词性预处理（测试同样不能以 `path.join` 构造含 `..`
  的输入——join 也先折叠）。
- **`realpathSync.native` 在 macOS 收敛已存在组件的盘上大小写**（与
  JS 实现不同），大小写语义据此按平台如实分支（不敏感 FS：root 部分
  不一致也收敛匹配，OS 确实能解析；敏感 FS：保留输入 → fail closed；
  不存在后缀永远保留输入大小写 → 不存在的新文件之间大小写不同不互
  相匹配授权，严格方向）。

## 修改文件

全部在独占写入范围内（`packages/tool-policy/**`、`coordination/d2/agent-d-*`）：

- `packages/tool-policy/package.json` — 仅新增 `scripts.typecheck` /
  `scripts.test`；version 保持 `0.0.0`、依赖不变（runtime-smoke pin
  `0.0.0`，版本对齐属 Integrator）
- `packages/tool-policy/tsconfig.json` — include 加入 `tests`
- `packages/tool-policy/tsconfig.test.json` — 新建（测试 emit 配置）
- `packages/tool-policy/scripts/run-tests.sh` — 新建（编译 src+tests 到
  `.tmp-test` → `node --test` glob → 事后清理；退出码 0=全过、1=编译
  失败、其余透传 node --test）
- `packages/tool-policy/README.md` — 新建（交付文档）
- `packages/tool-policy/src/paths.ts` — 新建（canonicalizePath /
  isPathWithin，物理逐段解析）
- `packages/tool-policy/src/config.ts` — 新建（配置 API 与默认值）
- `packages/tool-policy/src/decisions.ts` — 新建（类别-风险映射、固定
  reason 模板、makeDecision）
- `packages/tool-policy/src/audit.ts` — 新建（脱敏审计日志）
- `packages/tool-policy/src/authorization.ts` — 新建（授权存储）
- `packages/tool-policy/src/engine.ts` — 新建（ToolPolicyEngine +
  createToolPolicy）
- `packages/tool-policy/src/index.ts` — 新建（公开 API 汇总 + contracts
  类型便捷再导出）
- `packages/tool-policy/tests/paths.test.ts`（15 用例）、
  `tests/policy.test.ts`（29）、`tests/authorization.test.ts`（6）、
  `tests/audit.test.ts`（8）— 新建
- `coordination/d2/agent-d-status.md` — 启动记录 + 实测结果回填
- `coordination/d2/agent-d-handoff.md` — 本文件

未修改任何禁区文件（contracts、根配置/锁、其他 package、顶层
tests/schemas/scripts/.github、d1-spikes）。

## 验证命令与退出码

（2026-09-21 实测；Node v24.21.0 / npm 11.19.0 / TypeScript 5.9.3 / darwin 25.6.0）

- command: `cd packages/tool-policy && npm test`
  exit: 0
  （包级 typecheck 0 → tsc emit 0 → `node --test`：4 个测试文件、
  58 用例全部 PASS、0 失败、0 跳过）
- command: `cd packages/tool-policy && npm run typecheck`
  exit: 0
- command: `npm run typecheck`（仓库根）
  exit: 1
  （编排器检查了 runtime-smoke/contracts/event-journal/persistence/
  tool-policy；**@treeai/tool-policy 零错误**。失败全部来自
  `@treeai/runtime-pi`——其他 Agent 的在制品：`src/events.ts` 5 处
  TS2542（JsonRecord 只读索引签名写入）+ `src/pi-real-port.ts` 1 处
  TS2344（private constructor 不满足 abstract new 约束）。不在 Agent D
  写入范围，未代改，见「需要 Integrator 处理」。）
- command: `./node_modules/.bin/tsc --noEmit -p packages/tool-policy/tsconfig.json`
  exit: 0

## 证据

- 测试运行日志（58/58 PASS）：`/tmp/tp-test.log`（`bash scripts/run-tests.sh` 输出）
- 包级 npm test 日志：`/tmp/tp-npmtest.log`（exit 0）
- 根 typecheck 日志：`/tmp/tp-root-typecheck.log`（exit 1，失败均在 runtime-pi）
- 临时 fixture（`os.tmpdir()` 下 `treeai-tool-policy-*`）由 `after()`
  钩子递归清理；编译产物 `.tmp-test/` 由脚本事后删除；`git status`
  核对工作区无残留（仅本模块文件与既有未跟踪项）

## 已知限制

- **应用层策略，不是 OS 沙箱，不构成安全边界**（README「不能防御的
  风险」完整列出 10 项）：同进程绕过、TOCTOU 竞态、硬链接、挂载点、
  allowShell 后无命令检查、allowNetwork 后无主机过滤、多路径操作需
  宿主逐路径评估、无资源限制、大小写严格方向（不存在的新文件之间
  大小写不同不共享授权）、审计环形截断 + 时钟回拨延长授权。
- 根 `npm test` 仍为 Integrator 的 NOT_IMPLEMENTED 占位（exit 3）；
  本模块测试以包级命令为准。
- 大小写用例按 `existsSync` 探测的文件系统实际行为分支断言
  （darwin/APFS 走「大小写不敏感」分支；Linux 走「敏感」分支），
  无跳过用例。

## 接口偏离

- 无。`evaluate()` 返回冻结契约 `ToolDecision`（contracts
  `tool-decision.ts`）；对 contracts 一律 `import type`（纯类型包）；
  未新增运行时依赖。

## Pi 改造需求

- 无。不 import `@earendil-works/pi-coding-agent`；本模块与 Pi 无耦合
  （宿主把工具调用映射为 `ToolPolicyRequest` 的方向不变）。

## 需要 Integrator 处理

1. **根 `npm test` 接线**：包级 `cd packages/tool-policy && npm test`
   已可用；根入口仍是 gate0 占位 exit 3，请按统一方案接线各包测试。
2. **根 typecheck 的 runtime-pi 失败**（非本模块）：`packages/runtime-pi/
   src/events.ts` 5 处 TS2542、`src/pi-real-port.ts` 1 处 TS2344，
   属 runtime-pi Agent 的在制品，请与其确认状态后汇总。
3. **无依赖申请**：实现仅用 Node 内置模块；未改本包 version（pin
   `0.0.0` 对齐由 Integrator 统一处理）。
