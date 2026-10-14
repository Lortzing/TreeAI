/**
 * TreeStudioService — D3 Core MVP 产品服务（studio app 的领域核心）。
 *
 * 职责：把 D2 包（contracts / runtime-pi / persistence）组装成产品行为——
 *   - 创建/打开 Tree（Trunk = 根分支）；
 *   - 在 Trunk/Branch 上对话（Episode + Run + Turn 三层落库）；
 *   - 从“锚定的答案选区”创建 Branch：Pi 会话树内在锚点条目处分叉
 *     （navigateTree，不新建 session 文件——D2 已验证的分叉方式）；
 *   - 继续分支、切回 Trunk（同一 session 文件内移动叶指针）；
 *   - 编辑并显式提交 Return：记录在 Trunk 上（含出处分支与提交时的
 *     分叉锚点快照 targetAnchor）。保存先于导航（已签署 W1 v3.0 §3.5）：
 *     校验与持久化完成后才尝试回程导航，导航失败（session 缺失/运行期
 *     错误）不回滚已保存的 Return，结果以 ReturnSubmission.navigation
 *     分离呈现（navigated / no-session / failed）；重放路径同样尝试
 *     导航（同键重试即重新导航，不产生重复）；
 *   - Return 采用语义（signed v3 §3.2）：保存 ≠ 采用。每次组装该
 *     Return 的主干 Run 记一条采用尝试关联（return_adoption_attempts，
 *     Run 结果 succeeded/failed/aborted 由 runs 行携带，读取面以
 *     BranchView.returnAttempts 安全投影）；deliveredRunId 只标记
 *     **首次成功采用**的 Run（markReturnDelivered 条件 UPDATE，至多
 *     一次），失败/中止后 Return 保持 pending 并在下一次主干 prompt
 *     再次组装（pending 重注入）；
 *   - Return 幂等（响应丢失/双击/并发同键安全）：提交方提供稳定
 *     idempotencyKey。同键同内容重试零写入返回既有 Return
 *     （created === false）；同键不同内容（fromBranchId/text）以
 *     ReturnConflictError 拒绝；并发同键由树内唯一索引
 *     UNIQUE(tree_id, idempotency_key)（signed v3 §3.4：Tree 内命名
 *     空间，跨 Tree 同键各自有效）裁决，判负事务整体回滚（无悬挂
 *     episode）后重读对齐。Return 状态词汇：draft（客户端草稿，
 *     未持久化、非模型上下文）/ saved（已落库，deliveredRunId ===
 *     null 且尚无采用尝试）/ adoption attempted（已有 Run 组装过，
 *     含失败/中止；仍 pending）/ successfully adopted
 *     （deliveredRunId !== null——首次成功采用）——持久态由
 *     deliveredRunId + 采用尝试关联派生，无独立状态列；
 *   - 全部产品状态即时写入 TreeAI DB（事实源）；重启后由 DB 重建。
 *
 * 会话连续性模型（全部可从 DB 重建，cursor 只是缓存）：
 *   分支的“续聊点” =
 *     该分支最新 Run 的 SessionReference（Run 落库时更新到该 Run 完成后的叶）；
 *     无 Run 但有 BranchOrigin → 锚点 Run 的引用三元组 + anchorEntryId；
 *     Trunk 且无 Run → 首次 prompt 时新建 session。
 *   进程内活动会话 cursor 与续聊点不一致时：
 *     同 session 文件 → navigateTree（D2 回归能力，同 session 不换文件）；
 *     不同文件/无活动会话 → restoreSession。
 *   「以保存内容开始新的探索」（signed v3 §4.4）：整树/分支 session 丢失后，
 *     用户显式确认的换轨入口（promptNewExploration）——仅在续聊点 session
 *     当前不可用时成立；创建全新 session，锚点摘录 + 分支已保存历史作为
 *     首问上下文带入并声明旧上下文未恢复（用户 turn 携带显式标记，不冒充
 *     旧会话恢复）；成功后该分支续聊点 = 新 session，旧历史保持可读，
 *     来源关系（origin）不动。绝不在普通续聊路径静默重建 session
 *     （fail-closed 纪律不变：session 不可用的普通 prompt 照常拒绝）。
 *
 * 材料 Branch（D4-3，ADR-004，本文件只做最小接线——材料建枝编排在
 *   apps/studio/src/materials/branching.ts）：
 *   - 续聊点：材料分支无 Turn 来源也无 run 时为 new-session（材料没有天然
 *     Pi 分叉点——首问以显式材料上下文开独立 session，不伪造历史）；
 *   - Return：材料分支的 targetAnchor 为 null（没有主线对话锚点，绝不
 *     伪造；卡片数据由材料建枝服务读面派生），保存/导航解耦与采用语义
 *     与 Turn 来源 Return 完全共用；
 *   - 新探索：PromptOptions.newExplorationMaterialContext 把材料来源上下文
 *     块带入 #newExplorationContext（材料分支无锚点摘录时的真实输入）。
 *
 * 诊断面（A5，最小诚实）：getTreeDiagnostics 提供安全投影——运行面状态
 *   （idle/streaming/aborting）、在途 run 定位、DB 全量 run 行
 *   （runId/branchId/episodeId/state/failure code+message/createdAt/
 *   terminalAt）。session 引用（sessionFile/sessionId/entryId/piVersion/
 *   availability）、failure.details、原始 cause、命令、主机与目标路径
 *   一律不外泄。策略决策如实报告：默认装配（prompt 以空工具 allowlist
 *   运行）从未观测 → observed=false；runtime 注入请求时策略门
 *   （issue #5 P0）后观测到的决定以脱敏投影列出（工具名/outcome/
 *   reason/ruleId），绝不伪造 policy 判定，也绝不隐瞒已发生的拒绝。
 *   abort(treeId, runId) 只接受该树当前在途的 run（否则按操作冲突拒绝），
 *   调用 runtime.abort()，由 prompt 的收敛路径把 run 落库为 aborted
 *   （user-abort 绝不改写为 failed）。
 *
 * 事件面（P1）：subscribeStudioEvents 暴露安全 UI 事件
 *   （run-started / message-delta / abort-requested / run-terminal /
 *   tool-activity；SSE 端点见 server.ts）。message-delta 只携带文本增量；
 *   tool-activity 只投影工具名与阶段（never 参数/路径/命令——诊断面
 *   no-leak 纪律同样约束事件面）。事件是瞬态推送；/state 与诊断面仍是
 *   权威读模型（UI 在 run-terminal 后整树刷新）。
 *
 * Journal 面（P1）：可选注入 EventJournal（宿主负责 open/close/重启
 *   恢复之外的写入均由本服务承担；本服务在构造时自动执行 host-crash
 *   恢复，见 journalRecovery）。注入后记录 run 生命周期事件：会话对准
 *   阶段的 session.* / tree.navigated 事件缓冲后归属该 prompt 创建的
 *   run（域归属由消费方补齐——契约语义），运行期事件实时归属在途 run，
 *   外加服务侧的 queued→running 显式迁移与 abort 请求记录。eventId 由
 *   journal 生成（evt-<uuid>）而非沿用 Pi 的 per-instance
 *   pi-runtime-<seq>——单一 journal 文件跨进程重启复用，per-instance
 *   序号会撞 journal 全局 eventId 唯一性（D2 runtime-smoke 已知发现的
 *   规避）；原始事件 id 经 evidence（source "pi-runtime"）保留审计链。
 *   terminal 状态不做服务侧显式迁移（agent.settled / runtime.error 的
 *   派生迁移已与 DB 收敛一致；事后补显式迁移只会产生 out-of-sync
 *   投影异常）。journal 写失败不阻断产品路径（DB 是事实源），静默
 *   丢弃并继续。getTreeJournal 提供按树过滤的保守投影
 *   （{eventId, runId, seq, occurredAt, type, summary}，summary 为
 *   白名单字段构造的人类可读串，绝不透出原始 payload）。
 *   A4 缺失 session 降级：BranchView.sessionAvailability 以续聊点引用
 *   做实时文件存在性探针（只探存在、绝不读内容）修正 DB 缓存评估后
 *   给出——missing-file 且文件已恢复 → available；DB 因其他原因降级
 *   （version-mismatch/corrupt）→ 维持 unavailable；树始终可读（DB 是
 *   事实源），续聊 fail-closed。
 *
 * 已知范围（诚实声明）：并发 prompt 以冲突拒绝不排队（TypeError → 409，
 *   单用户语义）；默认 Studio 装配（空工具 allowlist、无策略注入）无
 *   工具执行，tool-activity / tool.decision 仅在 runtime 配置了工具与
 *   请求时策略门后出现（离线驱动可用 toolCalls 测试钩触发）；非 prompt
 *   期间的运行时事件（如 switchBranch 的导航）无 run 可归属，不进
 *   journal（策略决策观测例外：观测环形独立于 run 归属，越权决定的
 *   provenance 不因事件缓冲而丢失）。
 */

/** Stable public entrypoint; implementations are owned by the Studio modules. */
export type { BranchView, ReturnAttemptView, SessionCursorInfo, TreeState, PromptOutcome, PromptOptions, BranchCreation, AnchorStatus, AnchorNavigationOutcome, AnchorLocation, StudioRuntimeState, ActiveRunInfo, RunDiagnostics, PolicyDecisionView, PolicyDiagnostics, TreeDiagnostics, StudioEvent, StudioEventListener, JournalEventView, ReturnNavigationOutcome, ReturnSubmission, TreeStudioServiceOptions } from "./studio/model.ts";
export { NO_POLICY_DECISIONS_REASON, NEW_EXPLORATION_TURN_PREFIX } from "./studio/policy.ts";
export { RunNotActiveError, ReturnConflictError, NewExplorationConflictError } from "./studio/errors.ts";
export { TreeStudioService } from "./studio/tree-studio-service.ts";
export { summarizeJournalEvent } from "./studio/event-summary.ts";
export { composePromptText } from "./studio/prompt-text.ts";
