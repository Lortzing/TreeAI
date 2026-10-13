/**
 * 术语三部分（issue #7 C）——① 独立轻量无工具辅助执行器 + ② 保存/推广
 * 的服务装配。
 *
 * ① TerminologyExecutor（执行器）：
 *   - **隔离**：自带 PiRuntime 实例（独立的 provider/model 选择与非推理
 *     thinkingLevel 装配由宿主完成——见 index.ts 的术语运行时装配）、
 *     独立 sessionDir、独立 cwd。绝不触碰主 Pi 会话/游标/pending
 *     Return——解释与提取是瞬态任务，不是树的产品事实（「关闭 10 次零
 *     正式事实/主会话副作用」由构造保证：explain/extract 路径零树写入，
 *     唯一的持久化面是执行器自身的用量记账与偏好 kv）；
 *   - **任务**：queued → running → succeeded/failed/cancelled；取消后
 *     到达的结果**迟到丢弃**（请求已发生，用量照记——诚实成本口径）；
 *   - **三模式**：term（点词）/ range（任意划线）/ auto（整段候选提取
 *     ——任务面能力；**自动保存不开**：质量门禁未过前 auto 结果不落
 *     批注，issue #7 C ① 的冻结纪律）；
 *   - **缓存语境**（issue #7 P0 整改，2026-09-30 验收）：缓存键 =
 *     来源身份（锚点 turn）+ 选区 start/end + 上下文指纹（选区周围
 *     文本窗口）+ 全文指纹 + 模型/prompt/偏好版本——同文同词不同语义
 *     位置必是不同键（各自调用），同锚点同选区才复用；
 *   - **预算预留**（issue #7 P1 整改）：派发前保守预留输入+输出上限
 *     （原文内嵌有上限——超限 explain 取窗口、extract 零派发拒绝）；
 *     额度不足零派发（budget-exceeded）；完成后按**真实 usage 结算**；
 *     取消/超时（user-abort/timeout）的已发请求保留预留、按未知成本
 *     记账（requests ≥ 1，绝不归零）；日/月/用途与未知成本分开记账；
 *     记账落盘失败不静默清账（fail-closed：重启后 dirty 标记拦截新
 *     派发，直至账目可信）；
 *   - **提取的机械校验**（auto）：模型返回 JSON 候选后逐一验证
 *     （term 必须与 source[start,end) 切片全等；偏移为 UTF-16 码元、
 *     界内有序）；去重（同 term 至多一条）、密度上限（默认 8/答案）、
 *     代码/URL 排除（候选区间与反引号围栏或 URL 形态重叠即剔除）。
 *   - **阅读模式**（issue #7 术语①，2026-10-01）：每树 manual-only
 *     （默认）| minimal-hints | assisted-reading（terminology_state kv
 *     持久化，零新迁移）；触发范围 = 仅 assistant 回答完成（订阅
 *     run-terminal succeeded——浏览/搜索/打开树零派发）；密度上限
 *     每段/每回答（工程占位数值）；质量门禁 TERMINOLOGY_AUTO_QUALITY_GATE
 *     = false（未过 → 零自动派发，readModel 如实暴露原因；true 仅测试
 *     强开）；四状态 no-suggestions / partial / budget-paused /
 *     source-invalid（+pending/ready/failed 如实终态）；建议**只展示**——
 *     不自动建枝、不自动解释、不自动保存批注。
 *
 * ② TerminologyService（保存/推广）：
 *   - explain：瞬态任务（去重命中已保存批注时直接返回，零模型调用）；
 *   - saveAnnotation：显式保存（落库为产品事实；同选区至多一条）；
 *   - promote：**幂等推广**（issue #7 P0 整改）——单事务原子落库
 *     Branch/Origin + 绑定 + 首问派发意图（派发账本，migration 0009）；
 *     键冲突（同树同键异批注）→ 409 且**零新增行**（无孤儿分支）；
 *     首问身份不可变（payload hash 落账本：同键异问 → 409）；重放判定
 *     只走账本，绝不信「分支上有无 Turn」；结果未知（dispatched）先对
 *     账（Turn/Run 证据）再决定是否重发，对账不决不盲发（surface
 *     reconcile 状态）；明确失败（failed/pending）可重试（新尝试，不
 *     重建枝）。
 */

/** Stable public entrypoint; implementations are owned by the terminology modules. */
export {
  EXPLAIN_SOURCE_LIMIT_CHARS,
  EXPLAIN_CONTEXT_CONTEXT_CHARS,
  MAX_EXPLAIN_SELECTION_CHARS,
  EXTRACT_SOURCE_LIMIT_CHARS,
  TERMINOLOGY_V2_INPUT_TOKEN_LIMIT,
  TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT,
  TERMINOLOGY_V2_MAX_CANDIDATES,
  TERMINOLOGY_LIMITS_VERSION,
  MAX_EXPLAIN_COMPLETION_CHARS,
  MAX_EXTRACT_COMPLETION_CHARS,
  EXPLAIN_PROMPT_VERSION,
  EXTRACT_PROMPT_VERSION,
  TERMINOLOGY_CACHE_FORMAT_VERSION,
  TERMINOLOGY_READING_MODES,
  isTerminologyReadingMode,
  TERMINOLOGY_AUTO_QUALITY_GATE,
  READING_MODE_DENSITY_LIMITS,
} from "./terminology/policy.ts";
export type {
  TerminologyReadingMode,
  ReadingModeDensityLimits,
  TerminologySuggestion,
  TerminologySuggestionSetStatus,
  TerminologySuggestionSet,
  TerminologyAutoSuggestionsState,
  TerminologyTaskKind,
  TerminologyCandidate,
  TerminologyTaskState,
  TerminologyTask,
  TerminologyExecutorOptions,
  TerminologyUsageBucket,
  TerminologyExecutorUsage,
  TerminologyUsageReport,
  PreparedExplainPassage,
  TerminologyServiceOptions,
  ExplainOutcome,
  SaveAnnotationOutcome,
  TerminologyDispatchOutcome,
  PromotionOutcome,
  TerminologyReadModel,
} from "./terminology/model.ts";
export { projectSuggestionSet } from "./terminology/suggestion-projection.ts";
export { normalizeExecutorUsage, USAGE_ACCOUNTING_UNAVAILABLE } from "./terminology/usage.ts";
export {
  buildExplainPrompt,
  prepareExplainPassage,
  buildExtractPrompt,
  TERMINOLOGY_PROMOTION_TURN_PREFIX,
  hashSourceText,
  buildFirstQuestionPayload,
  hashFirstQuestionPayload,
} from "./terminology/prompts.ts";
export { parseCandidates, excludedSpans, validateCandidates } from "./terminology/candidates.ts";
export { TerminologyExecutor } from "./terminology/executor.ts";
export { TerminologyPromotionConflictError } from "./terminology/errors.ts";
export { TerminologyService } from "./terminology/service.ts";
export { applySuggestionDensity, paragraphRangesOf } from "./terminology/suggestion-density.ts";
