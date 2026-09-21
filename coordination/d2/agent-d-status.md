# Agent D 状态文件（D2 Wave 1：ToolPolicy）

- Agent：D（ToolPolicy、路径权限与高风险操作授权）
- 启动时间：2026-09-21
- 本文件仅由 Agent D 维护；Integrator 汇总时只读引用。

## 1. 启动记录（按任务书 §12 要求）

### 1.1 已读材料

1. `/Users/tal/Downloads/TreeAI_D2_Agent执行任务书.md` v1.0（2026-09-21）——D2 唯一执行入口。重点节：§1.1 已批准决策（第 8 条：默认最小权限——shell 与网络拒绝、写入和其他高风险操作逐次授权）、§2.1 独占写入范围（Agent D：`packages/tool-policy/**`、`coordination/d2/agent-d-*`）、§3.3 冻结契约第 7 项 `ToolDecision`、§5 Wave 1 Agent D 节（必须完成 8 项 / 安全表述 / 必须测试 7 项 / 交付 4 项）、§9 交接格式、§12 启动指令。
2. `d1-spikes/research/adr-001-draft.md`——顶部负责人批准记录（2026-09-20：候选 1 TypeScript/Node.js + Pi SDK 进程内嵌入、Pi 0.85.1、同进程风险仅受信任本地模式接受、**不构成沙箱或安全边界**）与 §4 数据边界硬约束（TreeAI 自有数据库是产品事实源；Pi session 仅作引用；凭据不复制不代理）。
3. `d1-spikes/reports/blockers.md`——D1 关闭记录（DECISION-001~009 全部关闭）与 D2 授权记录。对本模块最直接的是 **DECISION-005 关闭记录**：「实施最小权限策略：工具仅可读 fixtures 与负责人明确授权的目录；shell 与网络默认拒绝；写入和其他高风险操作逐次授权。正式产品目录清单由 D2 按该边界落定，不由 D1 推测扩大。」
4. `d1-spikes/reports/d1-verification.md`——最终验收 `verify-20260920T124525829Z.json` 30/30 PASS、exit 0；§13 负责人批准与 D2 授权记录；D1 验收器在退出码、脱敏、失败路径自证上的既有纪律（作为本模块测试设计的参照）。
5. `packages/contracts/src/`（全部 9 个源文件）——冻结契约。对本模块的关键约束：`tool-decision.ts` 的 `ToolDecision`/`ToolActionCategory`/`ToolRiskLevel`/`ToolDecisionScope` 形状与不变量（默认拒绝 ruleId=null；allow 只能来自显式规则；require-approval 不是 allow；reason 必须脱敏）；`errors.ts` 的 `TreeAIError`（`policy-denied` 分类）；`events.ts`（`tool.decision` 事件类型；payload 脱敏义务在 event-journal）；`json.ts`（JsonRecord）。
6. `docs/d2/contracts-README.md`——依赖方向（tool-policy 只依赖 contracts）、消费方式（一律 `import type`，contracts 无运行时导出）、§5 关键设计决定。
7. `coordination/d2/CONTRACT-FREEZE-1.md`——**状态：PASS（Gate 0 通过，Integrator 已签署）**。Wave 1 并行开发已解锁。根 workspace 就位：TypeScript 5.9.3、NodeNext、`scripts/typecheck.js` 编排逐包 `tsc -p`。
8. 附加核对：根 `package.json`/`tsconfig.base.json`/`scripts/typecheck.js`/`scripts/gate0-status.js`、`coordination/d2/README.md`（状态文件与依赖申请流程）、`coordination/d2/integrator-status.md`（根 npm test 仍为 NOT_IMPLEMENTED 占位 exit 3，模块测试套件由 Integrator 在 Wave 1 接线；勿自行改根配置）、`apps/runtime-smoke/package.json`（pin `@treeai/tool-policy` `0.0.0`——**据此我不改本包版本号**，版本对齐属 Integrator 接线职责）。

### 1.2 理解的边界

- **独占写入范围**：`packages/tool-policy/**`、`coordination/d2/agent-d-status.md`、`coordination/d2/agent-d-handoff.md`（及如需的 `agent-d-dependency-request.md`）。本模块的 package 内 `scripts/`、`tests/` 属包内文件，在独占范围内（先例：contracts 包内 `scripts/`）。
- **禁止修改**：`packages/contracts/**`（只读消费）、根 `package.json`/`package-lock.json`/`tsconfig.base.json`/`.gitignore`/根 `scripts/`、其他 package（runtime-pi/persistence/event-journal/runtime-smoke）、顶层 `tests/`、`schemas/`、`.github/`、`d1-spikes/**`（只读证据区）。需要跨范围时只写请求，不代改。
- **版本纪律**：不引入任何新依赖（实现只用 Node 内置模块 `node:fs`/`node:path`/`node:crypto`/`node:test`）；不改动 `@treeai/contracts` 依赖声明；不改本包 version（runtime-smoke pin `0.0.0`）。无 dependency request 需要。
- **Pi 类型隔离**：不 import `@earendil-works/pi-coding-agent`；对 contracts 一律 `import type`（contracts 是纯类型包，无运行时导出——运行时 import 会失败）。
- **安全表述（不可弱化）**：ToolPolicy 是**应用层策略，不是 OS 沙箱，不构成安全边界**（ADR-001 批准记录、任务书 §5 Agent D「安全表述」节、contracts `tool-decision.ts` 头注释三处一致）。README、错误消息、reason 字符串、审计记录不得宣称安全边界。
- **目录配置来自调用方**：本模块不硬编码任何 fixtures/产品目录；read roots、workspace roots 全部由调用方传入（DECISION-005：负责人明确授权的目录）。默认策略 = 全部拒绝。
- **授权接口无 UI**：只提供授权（issue/revoke/过期/单次消费）的编程接口；审批 UI/人机交互不在本模块。
- **审计脱敏**：不记录文件正文、token、cookie、Authorization 或秘密；shell command / network host 只记录存在性标志，不记录原值；reason 用固定模板（不含用户可控内容）。
- **不 git commit / push**；不执行破坏性 git 命令。

### 1.3 计划（对应任务书 §5 Agent D「必须完成」8 项）

设计决定（详见实现内注释与 README）：

1. **默认 deny**：`ToolPolicyEngine` 对未命中任何显式规则的操作一律 `deny`（`ruleId: null`）。默认配置 `DEFAULT_TOOL_POLICY_CONFIG` 为全空 roots + shell/network 关闭 → 拒绝一切。
2. **类别**：直接使用 contracts 的 `ToolActionCategory`（read/write/shell/network/other-high-risk）与 `CATEGORY_RISK` 映射（read=low，其余=high）。
3. **读取**：`readRoots`（调用方传入，含 fixtures 目录）内的规范化路径 → allow；其余 deny。
4. **shell/network**：默认 deny；仅当调用方显式配置 `allowShell`/`allowNetwork: true`（对应负责人批准的显式规则）才 allow（risk=high）。不对命令内容/主机做任何检查（D2 无命令白名单/主机过滤——记入「不能防御的风险」）。
5. **写入与 other-high-risk**：目标必须规范化后落在 `workspaceRoots` 内（否则 deny）；在 workspace 内且无授权 → `require-approval`；有匹配授权 → allow。
6. **授权**：`AuthorizationStore`。每笔授权必须带**显式 expiry**（`expiresInMs > 0`）；默认 `singleUse: true`（逐次授权，产生一次 allow 即消费）；多用途授权必须限时。授权签发时校验目标规范化后必须在 workspace 内；匹配时要求**类别相等 + 规范化目标路径严格相等 + 未过期 + （单次授权）未消费**——不可复用到其他目标/类别。签发/撤销/消费/清理均写审计记录。
7. **路径规范化**（`canonicalizePath`）：**物理逐段解析，全程不做词法折叠**——绝对禁止先把输入交给 `path.resolve`/`path.normalize`/Node 默认 JS realpath（三者都先做词法 `..` 折叠，会把 `ws/link/../f`（link → 外部）错折成 `ws/f`，实测逃逸向量）。实际算法：从物理根（"/" 或已解析的 cwd）出发逐段处理；`..` 弹出**当前物理路径**的父目录（与 OS 语义一致）；普通段先 `lstat` 确认存在、再 `realpathSync.native` 解析到物理位置（解析符号链接、收敛已存在组件的盘上大小写）；`lstat` ENOENT/ENOTDIR 进入「不存在后缀」模式（后缀父目录不存在故不可能含符号链接），**后缀中再出现 `..` 一律返回 null**（OS 打开这种形态必然 ENOENT，词法折叠会预测 OS 不会访问的位置）；`lstat` 成功但 realpath 失败（dangling symlink 等）返回 null。任何解析失败 → null → **fail closed 拒绝**。大小写语义：已存在组件经 OS realpath 收敛到盘上真实大小写（大小写不敏感 FS 上 root 部分大小写不一致也会收敛并匹配——OS 确实能解析到该目录，allow 是如实的）；不存在后缀保留输入大小写（大小写敏感 FS 上 root 不一致 → fail closed；不存在的新文件之间大小写不同不互相匹配授权）。包含性检查 `isPathWithin` 用 canonical 精确字符串前缀比较。
8. **审计**：`ToolPolicyAuditLog` 追加式记录每次评估与每笔授权事件；记录只含结构化字段（decision 摘要 + canonical 目标路径 + 存在性标志），不含命令/主机原值、不含文件内容（引擎从不读取目标文件内容）。

### 1.4 计划修改目录

```text
packages/tool-policy/
├── package.json            # 编辑：仅新增 scripts（typecheck/test）；不改 version、不加依赖
├── tsconfig.json           # 编辑：include 加入 tests
├── tsconfig.test.json      # 新建：测试 emit 配置（覆盖 noEmit）
├── scripts/run-tests.sh    # 新建：编译 src+tests 到 .tmp-test 并 node --test，事后清理
├── README.md               # 新建：威胁模型 / 不能防御的风险 / 非沙箱声明 / 用法与限制
├── src/
│   ├── index.ts            # 公开 API 汇总
│   ├── paths.ts            # canonicalizePath / isPathWithin（安全校验核心）
│   ├── config.ts           # ToolPolicyConfig / 默认值 / 解析（roots 规范化）
│   ├── decisions.ts        # 类别-风险映射 / 决定构造器 / 固定 reason 模板
│   ├── audit.ts            # 追加式脱敏审计记录
│   ├── authorization.ts    # 授权签发/匹配/消费/撤销/过期
│   └── engine.ts           # ToolPolicyEngine.evaluate（默认 deny 决策核心）
└── tests/                  # node:test（Node 内置 runner），fixture 全部用临时目录并清理
    ├── paths.test.ts
    ├── policy.test.ts
    ├── authorization.test.ts
    └── audit.test.ts
coordination/d2/agent-d-status.md    # 本文件
coordination/d2/agent-d-handoff.md   # 交付时新建（任务书 §9 格式）
```

### 1.5 预计验证命令（真实结果在 §2 回填）

```bash
npm run typecheck                                   # 根编排（应含 @treeai/tool-policy 被检查）
cd packages/tool-policy && npm test                 # 包级：typecheck + 编译 + node --test
./node_modules/.bin/tsc --noEmit -p packages/tool-policy/tsconfig.json   # 单步等价
```

退出码语义遵循任务书 §5 / coordination README：0 全部通过；2 至少一项 FAIL；3 无 FAIL 但有 BLOCKED/NOT_RUN。

### 1.6 阻塞

- 无阻塞。Gate 0 已通过（CONTRACT-FREEZE-1 由 Integrator 签署 PASS），Wave 1 开发已解锁。
- 已知非阻塞注意项：
  - 根 `npm test` 仍是 Integrator 的 NOT_IMPLEMENTED 占位（exit 3）；本模块单测以包级 `cd packages/tool-policy && npm test` 为准，根入口接线由 Integrator 统一处理（将在 handoff「需要 Integrator 处理」中列出）。
  - Node 内置 test runner（`node --test`）配合 tsc 编译产物运行（Node 24.21.0）；不引入任何测试框架依赖。

## 2. 执行结果（工作完成后回填）

见 §2.1。

### 2.1 验证命令与退出码（2026-09-21 实测，最终态）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `npm run typecheck`（仓库根） | 1 | 编排器实测检查 `@treeai/runtime-smoke`、`@treeai/contracts`、`@treeai/event-journal`、`@treeai/persistence`、`@treeai/tool-policy`。**本包零错误**（被检查且通过）；失败全部来自 `@treeai/runtime-pi`（其他 Agent 的在制品：`events.ts` 5 处 TS2542 + `pi-real-port.ts` 1 处 TS2344），不在 Agent D 写入范围内，不代改——详见 handoff「需要 Integrator 处理」 |
| `cd packages/tool-policy && npm test` | 0 | 包级 typecheck exit 0 → tsc emit exit 0 → `node --test`：4 个测试文件、**58 个用例全部通过，0 跳过** |
| `./node_modules/.bin/tsc --noEmit -p packages/tool-policy/tsconfig.json` | 0 | 单步等价命令 |

测试明细（`node --test`，58/58 PASS）：`paths.test.ts` 15 用例、`policy.test.ts` 29 用例、`authorization.test.ts` 6 用例、`audit.test.ts` 8 用例。大小写用例**不跳过**：用 `existsSync` 探测文件系统是否区分大小写后分支断言（不区分 → 已存在组件收敛、root 部分大小写不一致也 allow（OS 确实解析到该目录）；区分 → 保留输入大小写、fail closed 拒绝），darwin/APFS 上实际执行「不区分」分支，Linux 上会执行「区分」分支。临时 fixture 目录（`os.tmpdir()` 下 `treeai-tool-policy-*`）由 `after()` 钩子递归清理；编译产物 `.tmp-test/` 由测试脚本事后删除，工作区无残留（`git status` 核对）。

实现过程中的两个关键安全发现（均已落测试与文档）：

1. **词法 `..` 折叠是逃逸向量**：`path.resolve`/`path.normalize`/Node 默认 JS realpath 都会先把 `ws/link/../f`（link → 外部目录）词法折叠成 `ws/f`（workspace 之内），而 OS 实际解析到外部位置（实测 Node 24.21.0 / darwin 25：JS 实现返回 `ws2/f.txt`，`realpathSync.native` 返回真实位置）。最终实现为物理逐段解析（`lstat` + `realpathSync.native` 逐段），输入全程不经任何词性折叠；测试同样不能用 `path.join` 构造含 `..` 的输入（join 也先折叠）。
2. **`realpathSync.native` 在 macOS 上把已存在组件收敛到盘上真实大小写**（输入 `.../CASEPROBE` 返回 `.../CaseProbe`），与 JS 实现保留输入大小写不同。据此大小写语义按平台如实处理（见 §1.3 第 7 项）；不存在后缀仍保留输入大小写——不存在的新文件之间，大小写不同的目标不互相匹配授权（fail closed 的严格方向）。

覆盖对照（任务书「必须测试」7 项 → 用例）：

1. 未配置操作全部拒绝 → `policy.test.ts`「默认配置下全部类别拒绝（DEFAULT_TOOL_POLICY_CONFIG）」。
2. fixtures 读取允许 → 「fixtures 目录内读取允许」（临时 fixture 目录作 readRoot；另有「readRoots 为空时 fixtures 式目录也拒绝」证明目录必须显式传入）。
3. 未授权目录 / 目录穿越 / 符号链接逃逸拒绝 → 「授权目录之外的读取拒绝」「`..` 穿越出 read root 拒绝」「符号链接逃逸拒绝」；`paths.test.ts` 的「dot-dot after a symlink follows OS semantics」「不存在后缀中的 `..` 不可解析（fail closed）」「dangling symlink（最终/中间组件）」「symlink escape」单测佐证。
4. shell/network 默认拒绝 → 「shell 默认拒绝」「network 默认拒绝」（另有显式 allowShell/allowNetwork 配置后允许的正例）。
5. workspace 外写入拒绝 → 「workspace 外写入拒绝」（workspace 内为 require-approval，非 allow）。
6. 授权只对目标操作、目标路径和有效期生效 → `authorization.test.ts` 全部 6 用例 + `policy.test.ts`「单次授权：产生一次 allow 后即消费」「限时多次授权：过期后失效」「授权路径精确匹配」「授权类别精确匹配」「等价路径形式的授权匹配」「大小写差异（不存在后缀精确匹配）」。
7. 日志中不包含秘密或文件正文 → `audit.test.ts`「审计不含命令/主机原值与秘密形态」「审计从不包含文件正文」「reason 为固定模板，不含用户可控内容」「action 标签按安全模式净化」。

## 3. 交付状态

- 状态：`PASS`（本模块范围内全部执行并满足断言；详见 `agent-d-handoff.md`）。
- 未做 git commit（按纪律交由 Integrator）。
