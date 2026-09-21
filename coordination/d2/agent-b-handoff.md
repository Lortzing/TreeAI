# Agent B Handoff（PiRuntime）

## 状态
PASS

## 完成内容
- `contracts.PiRuntime` 完整实现（`packages/runtime-pi/src/`）：
  - `createSession` / `restoreSession`：经公开
    `Pi.createAgentSessionServices`（provider/扩展发现唯一正确入口，不走
    D1 已证明盲区的裸模型发现）+ `Pi.createAgentSessionFromServices`。
    恢复采用严格存储模型固定（沿分支找最近 `model_change` 显式传入，
    解析失败 → `model-unavailable`），并处理 Pi 的叶移动（branch 回位）。
  - `prompt`：流式事件归一（Pi 事件 → `PiRuntimeEvent`，白名单字段，
    无消息文本/工具参数泄漏）+ settle-once 自有 promise + 最终结果
    归一（message/reference）。
  - `steer`：保持 Pi 0.85.1 同一 agent run 新 turn 语义；`steer.enqueued`
    事件。
  - `abort`：即时 resolve + prompt 以 `user-abort` 收敛 + 非 streaming
    保证；安全计时器兜底（默认 10s，`abortConvergenceMs` 可配）。
  - `navigateTree`：同 session/sessionFile/条目数不变（不变量校验）+
    叶移动 + `tree.navigated` 事件。
  - `subscribe` / 幂等 `dispose`；session 替换后自动重订阅（旧订阅失效、
    新订阅生效、在途 run 以 user-abort 收敛、seq 跨替换连续）。
  - Pi 版本钉扎：构造期 `PiVersionMismatchError`（expected/actual）。
- 错误归一：8 类封闭编码（auth/model-unavailable/user-abort/timeout/
  policy-denied/upstream/session-corrupt/unknown）；`classifyPiFailure`
  分类顺序 timeout > auth > model-unavailable > abort > upstream >
  session-corrupt > unknown；policy 标记（`Symbol.for("treeai.policyDenied")`）
  优先；TreeAIError 结构透传限 8 类编码（Node 系统错误的 `code`
  如 ENOENT/ETIMEDOUT 不误透传）；cause 保留原始错误对象。
- 脱敏：`TreeAIRuntimeError` 构造期对 message/details 脱敏
  （Authorization/Cookie/Bearer/sk-key/凭据字段=值/家目录→~；
  `redactJsonValue` 对凭据字段名的值整体替换）；事件 payload 白名单。
- 端口隔离：`pi-real-port.ts` 是唯一 import Pi 的文件；核心与单测只
  依赖 `pi-sdk-port.ts` 结构类型（结构性测试守住 unit import 图）。
- 测试（Node 内置 runner，无新增依赖）：
  - `tests/unit/`（49 项，fake port，镜像 D1 实测 Pi 语义）：创建/
    恢复（含失败分类 8 形态、中间叶、懒 flush、模型固定）、prompt
    错误映射、steer/abort/dispose（幂等、安全计时器、收敛后可再
    prompt）、navigateTree（同会话不变量、user 目标→父、前置违规）、
    订阅（多监听器/退订/无回放/替换失效与生效/监听器异常隔离）、
    分类与脱敏、版本钉扎。
  - `tests/real-port/`（2 项）：真实 SDK 离线电池在**沙箱子进程**
    （最小 env + 沙箱 HOME + 临时 agentDir/models.json 自定义 provider，
    零网络、不读取测试目录之外用户数据、断言沙箱 HOME 未被写入）；
    unit import 图隔离结构性断言。
- README（API surface 清单 + 设计 + 12 条已知限制）。

## 修改文件
（全部在独占写入范围内；未修改 contracts、根配置/锁文件、其他
package、d1-spikes、tests/、schemas/、scripts/、.github；未 git commit）
- packages/runtime-pi/src/pi-runtime.ts（核心实现）
- packages/runtime-pi/src/pi-sdk-port.ts（结构端口）
- packages/runtime-pi/src/pi-real-port.ts（唯一 Pi import 的真实端口）
- packages/runtime-pi/src/errors.ts、src/redact.ts、src/events.ts、src/index.ts
- packages/runtime-pi/package.json（scripts：typecheck/test）
- packages/runtime-pi/tsconfig.json（Node 24 type-stripping 适配）
- packages/runtime-pi/README.md（API surface + 限制）
- packages/runtime-pi/tests/helpers.ts + tests/unit/*.test.ts（7 文件 49 项）
- packages/runtime-pi/tests/real-port/offline.test.ts + offline-child.ts
- coordination/d2/agent-b-status.md（启动记录 + 验证结果回填）

## 验证命令与退出码
- command: `cd packages/runtime-pi && npm test`
  （= `tsc --noEmit -p tsconfig.json` + `node --test tests/unit/*.test.ts
  tests/real-port/*.test.ts`）
  exit: 0（tests 51 / pass 51 / fail 0：unit 49 + real-port 2）
- command: `npm run typecheck`（仓库根，全部 workspace）
  exit: 0
- command: `cd packages/runtime-pi && npm ls --depth 0`
  exit: 0（`@earendil-works/pi-coding-agent@0.85.1` + `@treeai/contracts@0.1.0`
  仅此两项，无新增依赖）

## 证据
- 版本钉扎：`version.test.ts`（0.99.0/0.85.0 → PiVersionMismatchError，
  message 含双方版本）；真实端口离线电池 `real-version-pinned` /
  `port-version-pinned`（真实加载版本 = 0.85.1）。
- 扩展 provider 加载：`offline-child.ts` 用临时 agentDir/models.json
  注册自定义 provider（baseUrl 指向不可路由端口，全程零网络），
  `createSession` 成功 + `bogus-model-rejected`（model-unavailable）——
  证明走的是 `createAgentSessionServices` 注册表而非裸发现路径。
- 不读取测试目录之外用户数据：真实端口测试全部在子进程，env 仅
  {HOME: 沙箱, PATH, TMPDIR}（不继承任何 API key/凭据）；agentDir/cwd/
  sessionDir 全为临时目录；断言 `sandbox-home-untouched`（沙箱 HOME
  无 .pi、内容不变）。
- 会话替换：`subscribe-events.test.ts`（旧订阅失效、新订阅生效、
  在途 run user-abort 收敛、session.replaced → session.created 顺序、
  seq 连续）。
- tree-navigation 不新建会话：`navigate-tree.test.ts`（sessionId/
  sessionFile/条目数不变、`port.createdSessions.length === 1`）+ 真实
  端口 `tree-navigate-offline`。
- abort/dispose 重复：`steer-abort-dispose.test.ts`（双 abort 单事件、
  双 dispose 幂等、dispose 后方法违规 TypeError、事件停止）。
- Pi 懒 flush 实证：`lazy-file-before-assistant`（真实 SDK：无
  assistant 消息前文件不落盘）+ `file-flushed-after-assistant`；单测
  同步覆盖（fake 已镜像）。

## 已知限制
（完整清单见 packages/runtime-pi/README.md「已知限制」，摘要）
1. 懒 flush：从未完成过一轮 prompt 的持久化会话不可恢复
   （`missing-file`——Pi 真实语义）。
2. `agent_end` 事件丢弃（`agent_settled` 已表达收敛；契约无对应 kind）。
3. 恢复无消息条目的会话会追加条目，运行时 branch 回位保证 entryId
   稳定（仅手写文件场景可达，见 1）。
4. `SessionManager.open()` 对缺失文件不抛错（Pi 会隐式新建）——restore
   前自行 existsSync 预检。
5. navigateTree 的 user 消息目标落在父节点（Pi 语义）；Pi 返回的
   editorText 不进契约面。
6. steer 的消费时机由 Pi 排队语义决定（同 agent run 新 turn），
   `steer.enqueued` 只表示已入队。
7. `message.updated` 只透出文本增量；工具参数增量不透出。
8. abort 时 Pi 以合成 aborted 消息 + errorMessage 结束；运行时把
   abort 判定放在 errorMessage 之前避免误分类。
9. 恢复后的 cwd = 会话文件 header 的 cwd。
10. 内存会话 sessionFile 为 "" 哨兵，不可恢复。
11. dispose 清理尽力而为（后台 abort+dispose，超时兜底，不 reject）。
12. 未识别 Pi 事件以 `raw.<type>` 透传（无内容载荷）。

## 接口偏离
- 无。实现严格按冻结契约（packages/contracts + CONTRACT-FREEZE-1）；
  上述限制均为 Pi 0.85.1 实证语义的如实记录，未改变契约语义。
  （fake 与真实 SDK 的两处测试透明差异见 README「与 fake 的刻意差异」。）

## Pi 改造需求
- 无。公开 API（`createAgentSessionServices` /
  `createAgentSessionFromServices` / `SessionManager.*` / `AgentSession.*`）
  足够完成全部契约义务；无需 PI-CHANGE 提案、无私有路径、未编辑
  node_modules、未直接写 session JSONL。

## 需要 Integrator 处理
- 无跨范围修改需求。
- 备注 1：`package.json` 的 `scripts`（typecheck/test）是本包内新增，
  根 `npm run typecheck` 已自动覆盖本包（已验证 exit 0）。
- 备注 2：若后续真实端口测试需要网络验收（live provider），入口已有
  （沙箱结构可复用），但本次按要求全部离线完成。
