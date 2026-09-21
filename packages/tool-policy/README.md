# @treeai/tool-policy

TreeAI 的应用层工具策略引擎：默认拒绝（deny by default）的工具操作
授权、路径权限校验与脱敏审计。返回冻结契约 `@treeai/contracts` 的
`ToolDecision`（allow / deny / require-approval + reason / ruleId /
scope / risk）。

> **这不是 OS 沙箱，不构成安全边界。**
>
> 本模块是**应用层策略**：它约束的是「宿主在执行工具操作前先询问
> 本引擎」这一调用纪律下的决策。任何不经 `evaluate()` 的代码路径、
> 与本引擎同进程的任意代码、以及 OS 层面的绕过手段（竞态、硬链接、
> 挂载点）都不受约束。详见下文「威胁模型」与「不能防御的风险」。
> README、错误消息与 reason 文案中任何表述都不得宣称安全边界。

## 目录

- [快速开始](#快速开始)
- [决策矩阵](#决策矩阵)
- [目录配置 API 与默认值](#目录配置-api-与默认值)
- [授权流程（require-approval → issue → 再评估）](#授权流程)
- [路径规范化](#路径规范化)
- [审计](#审计)
- [威胁模型](#威胁模型)
- [不能防御的风险](#不能防御的风险)
- [限制与集成注意](#限制与集成注意)

## 快速开始

```ts
import { createToolPolicy } from "@treeai/tool-policy";

const policy = createToolPolicy({
  // 读取范围：fixtures 目录 + 负责人明确授权的目录（全部由调用方传入，
  // 本模块不硬编码任何目录；不传 = 拒绝一切）。
  readRoots: ["/path/to/fixtures", "/path/to/owner-approved-dir"],
  // 批准的写入 workspace（写入还必须逐次/限时授权，见下文）。
  workspaceRoots: ["/path/to/workspace"],
  // 相对 targetPath 的解析基准（默认 process.cwd()）。
  cwd: "/path/to/workspace",
  // shell 与 network 默认拒绝；只有显式配置才允许（负责人级决定）。
  allowShell: false,
  allowNetwork: false,
});

const decision = policy.evaluate({
  category: "read",
  targetPath: "fixtures/../workspace/secret.txt", // `..`、符号链接、
});                                             // 相对路径都会被规范化
// decision.outcome === "deny"（穿越出 read root）
```

`evaluate()` 对请求的**语义内容**永不抛异常：缺路径、不可解析（悬空
符号链接等）一律产出 `deny`（fail closed）。只有结构性垃圾（非对象、
`category` 不在封闭枚举、字段类型错误）抛 `TypeError`——那是宿主映射
层的编程错误，不是策略决定。

## 决策矩阵

| 类别 | 条件 | 结果 |
|---|---|---|
| `read` | 无 targetPath / 不可规范化 | `deny`（fail closed） |
| `read` | 规范化后位于某 `readRoots` 内 | `allow`（ruleId `allow-read-configured-roots`，risk low） |
| `read` | 其余 | `deny`（ruleId null） |
| `write` | 无 targetPath / 不可规范化 / workspace 之外 | `deny` |
| `write` | workspace 内、无匹配授权 | `require-approval`（不是 allow） |
| `write` | workspace 内、匹配授权 | `allow`（ruleId `authorization-grant:<grantId>`） |
| `shell` | `allowShell !== true` | `deny` |
| `shell` | `allowShell === true` | `allow`（risk high；不检查命令内容） |
| `network` | `allowNetwork !== true` | `deny` |
| `network` | `allowNetwork === true` | `allow`（risk high；不检查主机） |
| `other-high-risk` | 无 targetPath | `deny`（无法限定范围） |
| `other-high-risk` | 其余 | 同 `write` |

默认拒绝的 `ruleId` 恒为 `null`（无规则命中）；`allow` 只能来自显式
规则（配置规则或匹配授权）。`require-approval` **不是** allow——宿主
必须阻塞等待授权结果，不得放行。

## 目录配置 API 与默认值

```ts
import {
  createToolPolicy,
  DEFAULT_TOOL_POLICY_CONFIG,
  resolveToolPolicyConfig,
  type ToolPolicyConfig,
} from "@treeai/tool-policy";

// 默认值：全空 roots + 双 false → 拒绝一切（默认 deny 的具体化）。
// DEFAULT_TOOL_POLICY_CONFIG === { readRoots: [], workspaceRoots: [],
//                                  allowShell: false, allowNetwork: false }
const lockedDown = createToolPolicy(); // 等价于传默认配置

// roots 在构造期规范化一次（符号链接、`..`、大小写在此收敛）；
// 不可解析的 root（如悬空符号链接）抛 TypeError，拒绝启动。
// 运行期用 engine.resolvedConfig 读取规范化后的只读快照。
const resolved = resolveToolPolicyConfig({ readRoots: ["./fixtures"] });
```

设计边界（D1 DECISION-005 关闭记录）：

- 本模块**不硬编码任何目录**。fixtures 路径与负责人授权的目录全部由
  调用方经 `readRoots` 传入；产品目录清单由宿主（D2 各模块）落定。
- `readRoots` 空 = 所有读取拒绝；`workspaceRoots` 空 = 所有写入拒绝。
- `allowShell`/`allowNetwork` 是负责人层面的显式开关，开启后**不检查
  命令内容/目标主机**（见「不能防御的风险」）。

## 授权流程

授权是宿主侧编程接口（`engine.authorizations`）；**本模块不实现审批
UI**——把 `require-approval` 呈现给人、收集决定、调用 `issue()` 都是
宿主的职责。

```ts
const policy = createToolPolicy({ workspaceRoots: ["/ws"] });

// 1) 写入请求 → require-approval（不是 allow，必须阻塞）
const d1 = policy.evaluate({ category: "write", targetPath: "/ws/out.txt" });
// d1.outcome === "require-approval"

// 2) 审批通过后签发授权。每笔授权必须带显式有效期（expiresInMs > 0）；
//    默认 singleUse: true = 逐次授权（产生一次 allow 即消费）。
const grant = policy.authorizations.issue({
  category: "write",
  targetPath: "/ws/out.txt",   // 签发时规范化并固化
  expiresInMs: 5 * 60_000,     // 没有无期限授权
  singleUse: true,             // 默认值；false 为限时多次授权
  grantedBy: "owner-session-1",
});

// 3) 再评估 → allow；单次授权随即被消费
const d2 = policy.evaluate({ category: "write", targetPath: "/ws/out.txt" });
// d2.outcome === "allow"、d2.ruleId === `authorization-grant:${grant.grantId}`

// 4) 同一目标再评估 → require-approval（单次授权不可复用）
const d3 = policy.evaluate({ category: "write", targetPath: "/ws/out.txt" });

// 管理接口：随时撤销 / 清理过期 / 列出有效授权
policy.authorizations.revoke(grant.grantId);
policy.authorizations.purgeExpired();
policy.authorizations.listActive();
```

授权匹配的**四要素**（全部一致才产生 allow，不可复用到其他目标）：

1. 目标 action（`category` 严格相等——`write` 授权不覆盖
   `other-high-risk`）；
2. 规范化目标路径（canonical 字符串严格相等——不可复用到其他路径）；
3. workspace/目录范围（签发时校验目标必须在 `workspaceRoots` 内并
   固化，越界目标签发即抛 `TypeError`）；
4. 有效期（`now < expiresAt`；到达 `expiresAt` 即失效；不存在无期限
   授权；单次授权还要未消费）。

仅 `write` 与 `other-high-risk` 可授权：`read` 由 `readRoots` 决定，
`shell`/`network` 由 `allowShell`/`allowNetwork` 负责人级配置决定——
不通过逐次授权给它们开口子。签发参数非法（类别不支持、目标越界或
不可解析、`expiresInMs` 缺失或 ≤ 0）抛 `TypeError`（编程错误）。

## 路径规范化

`canonicalizePath`（`src/paths.ts`，导出供宿主复用）处理不可信路径
输入：`..`、绝对/相对路径、符号链接逃逸、大小写差异、重复/尾部斜杠、
尚不存在的目标（写入前的常见形态）。

算法是**物理逐段解析，全程不做词法折叠**。这是两个实测发现（Node
24.21.0 / darwin 25）的直接后果：

1. **词法 `..` 折叠是逃逸向量**。`path.resolve`、`path.normalize` 与
   Node 默认的 JS `realpath` 都会先把 `ws/link/../f`（`link →` 外部
   目录）词法折叠成 `ws/f`（workspace 之内），而 OS 实际解析到外部
   位置。本模块因此对不可信输入**绝不**先做词性预处理；`..` 弹出的
   是「当前物理路径」的父目录（与内核语义一致），符号链接用
   `realpathSync.native`（libuv/OS POSIX 语义）逐段解析。
2. **`realpathSync.native` 在 macOS 上把已存在组件收敛到盘上真实
   大小写**（输入 `.../CASEPROBE` 返回 `.../CaseProbe`）。因此在
   大小写不敏感的文件系统上，root 部分大小写不一致的请求会收敛并
   与配置 root 匹配——OS 也确实能解析到该目录，allow 是如实的；
   在大小写敏感的文件系统上（Linux 默认），不一致的 root 部分是
   不存在后缀，保留输入大小写 → 前缀不匹配 → 拒绝（fail closed）。

额外的 fail closed 规则：

- **不存在后缀中的 `..`** 一律返回 null：OS 打开 `<存在>/<不存在>/../f`
  必然 ENOENT（内核不做词法折叠），词法折叠会预测一个 OS 根本不会
  访问的位置。
- **悬空符号链接**（最终或中间组件）返回 null：写入目标是悬空符号
  链接时，`O_CREAT` 会穿透到链接目标位置创建文件。
- 任何解析失败（权限错误、竞态删除等）返回 null，调用方一律当作拒绝。

包含性检查 `isPathWithin(canonicalTarget, canonicalRoot)` 按精确字符串
前缀比较（`/a/bc` 不在 `/a/b` 内）。

## 审计

`engine.audit` 是追加式、脱敏的审计日志（默认容量 10000 条，环形
截断并计数 `droppedCount`）：

```ts
for (const record of policy.audit.records) {
  // record.kind: "decision" | "grant-issued" | "grant-revoked"
  //            | "grant-consumed" | "grant-purged"
  // record: { at, kind, category, outcome, risk, ruleId, reason,
  //           scopeRoots, targetPath(规范的或 null), grantId,
  //           hasCommand, hasHost, actionLabel }
}
const snapshot = policy.audit.toJSON(); // JSON 字符串（同样脱敏）
```

脱敏是**结构性**的（排除而非事后过滤）：

- shell 命令与网络主机**只记录存在性标志**（`hasCommand`/`hasHost`），
  原值从不落账；
- 引擎从不读取目标文件内容，文件正文无从进入审计；
- `reason` 是固定模板（见 `REASONS`），不拼接任何用户可控内容；
- `other-high-risk` 的 `action` 标签按 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`
  净化后记录（`actionLabel`），不匹配即丢弃（null）；
- `targetPath` 记录规范化路径（路径不是文件正文；宿主仍应注意路径
  命名本身可能敏感）。

## 威胁模型

- **受信任**：宿主进程与其代码（负责构造 `ToolPolicyConfig` 并遵守
  「先 evaluate 再执行」的纪律）；负责人经配置表达的目录授权
  （`readRoots`/`workspaceRoots`/`allowShell`/`allowNetwork`）。
- **不受信任**：工具层产生的 `ToolPolicyRequest`——`targetPath`、
  `command`、`host`、`action` 全部按敌意输入处理（穿越、符号链接、
  词法折叠欺骗、大小写混淆、授权复用尝试）。
- **攻击者的目标**：让本该 deny/require-approval 的操作拿到 allow。
- **本模块的防御**：默认 deny；物理规范化（穿越与符号链接在判定前
  收敛到真实位置）；一切解析失败 fail closed；授权四要素精确匹配；
  审计结构性脱敏。
- **明确的非目标**：OS 级隔离。本模块不提供也不宣称沙箱、容器、
  chroot、seatbelt 等任何 OS 机制能给的保证。

## 不能防御的风险

以下是**已知且有意不在范围内**的绕过手段（应用层策略的本质限制；
需要 OS 级隔离才能防御）：

1. **同进程绕过**：与本引擎同进程的任何代码（包括经 `allowShell`
   放行的命令、被攻破的依赖）可直接调用 `node:fs`/`node:net`，
   不经过 `evaluate()`。策略只约束「先问再动」的调用纪律。
2. **TOCTOU 竞态**：`evaluate()` 与实际执行之间不是原子的。攻击者
   可在检查后把已批准目录里的子目录换成指向外部的符号链接、或创建
   检查时还不存在的中间目录。窗口极小但存在；不是安全边界。
3. **硬链接**：在 read root/workspace 内创建指向外部敏感文件的硬
   链接，随后的读/写经链接命中外部文件内容——路径完全在范围内，
   策略层无从分辨。
4. **挂载点 / bind mount**：workspace 内的挂载点可引入其他文件系统。
5. **`allowShell: true` 后无命令检查**：shell 可以做任何事（读写任意
   文件、联网、提权尝试）。开启该开关等于承认「经 shell 的操作不受
   路径策略实际约束」。同理 `allowNetwork: true` 后不检查主机、协议、
   端口。
6. **多路径操作**：本引擎一次只评估一个目标。`copy src dst`、目录
   递归等操作多个路径的工具，宿主必须对每个路径分别 evaluate。
7. **资源限制**：不限制 CPU、内存、磁盘配额、打开文件数、连接数。
8. **大小写的严格方向**：不存在的新文件之间，大小写不同的目标不
   互相匹配授权（没有盘上形态可对齐）——在大小写不敏感的文件系统
   上比 OS 语义更严格（fail closed 方向，不是漏洞，但行为更紧）。
9. **审计是环形缓冲**：到达容量上限丢弃最旧记录（`droppedCount`
   计数），不构成完整证据链。
10. **时钟依赖**：授权有效期依赖注入的时钟（默认 `Date.now`）；系统
    时钟回拨会延长已签发授权的有效期。

## 限制与集成注意

- **依赖**：仅 `@treeai/contracts`（纯类型包，一律 `import type`）与
  Node 内置模块（`node:fs`/`node:path`/`node:crypto`）。无新第三方
  依赖。
- **契约**：`evaluate()` 返回冻结的 `ToolDecision`（contracts
  `tool-decision.ts`）；`require-approval` 不是 allow，宿主必须阻塞
  等待授权，不得静默放行或自动重试刷授权。
- **event-journal 集成**：`tool.decision` 事件的 payload 脱敏义务在
  event-journal。本模块的审计记录/决定已经不含命令/主机原值与文件
  正文；宿主转发时**不得**把请求原值（command/host）拼进事件 payload，
  否则破坏单一脱敏边界（结构化定位信息只应使用 `scope.roots`、
  `ruleId` 与审计记录的 `targetPath`/存在性标志字段）。
- **每次工具调用前评估**：决策不可缓存复用（授权可能已消费/过期/被
  撤销；文件系统可能已变化）。
- **测试**：`cd packages/tool-policy && npm test`（typecheck + tsc
  编译到 `.tmp-test` + `node --test` + 清理；Node 内置 runner，无测试
  框架依赖；fixture 全部用临时目录并由 `after()` 清理）。
