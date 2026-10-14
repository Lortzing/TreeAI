/**
 * MaterialBranchingService — D4-3「原文探索闭环」后端（issue #8 charter
 * §3.3 / ADR-004）。
 *
 * 定位：把「从原回答选区建枝」的 Branch/Origin/Run/Return 服务底层延伸到
 * 用户材料（charter §3.3 规则一：材料选文、术语入口和原回答选区最终使用
 * **同一** Branch/Origin/Run/Return 服务底层；仅来源解析与初始上下文构造
 * 不同）。来源解析复用 D4-2 的区间解析层产物（规范 MaterialSelection，经
 * MaterialRepository.getMaterialSelection 再校验切片/块/sourceHash 纪律）；
 * 建枝/首问/续聊/Return 全部复用 TreeStudioService 既有机制（Episode/Run/
 * Turn、#resolveContinuation、prompt 的 composedPrefix/turnPrefix、
 * submitReturn 的保存先于导航与采用尝试记录）。
 *
 * 显式运行起点（charter §3.3 规则二 / ADR-004 决策一）：材料没有天然 Pi
 * 分叉点——材料 Branch 的首个 Run 在**独立 session** 上开始，组合上下文
 * （材料标题/版本 + 选区摘录 + 有界邻近块）与用户问题一起作为**真实输入**
 * 送入首问；绝不制造假的历史回答，也绝不复用树内任何既有运行/会话
 * （复用必然把未请求的历史带入上下文或伪造延续性）。「同来源恢复已有
 * 探索」= 打开该来源已存在的 Branch 并续用其 session（决策二 a）；
 * 「显式另开」= 新 Branch + 新 session（决策二 b）；session 丢失后的
 * 「显式新探索」走 W1 §3.4 既有语义，材料上下文随行（决策二 c）。
 *
 * 上下文边界（charter §3.3 规则三 / ADR-003 §4）：组合上下文有确定上限
 * MATERIAL_CONTEXT_LIMIT_UNITS（24,000 UTF-16 单元，ADR-003 冻结值），
 * 超限在组合文本内**显式截断标记**（UI 在提交前从 create 响应读到完全
 * 相同的组合文本——范围 {window, contextBlocks, excerpt} 全部由不可变的
 * 版本 canonicalText/块图/选区决定，确定性成立）；选区自身超
 * MATERIAL_MAX_SELECTION_UNITS 直接拒绝（单次建枝容不下，零派发）。
 *
 * 首问提交意图身份（charter §3.3 规则四 / ADR-004 决策三）：
 * - 建枝 + 意图绑定原子落库（MaterialRepository.createMaterialBranch 单
 *   事务）：PRIMARY KEY(tree_id, intent_key)——双击、响应丢失重试、进程
 *   重启重放同一键 → 同一 Branch，不重复建枝；同键不同 selection → 409；
 * - 首问派发至多一次：结果判定**先对账后行动**（0009 派发账本纪律的
 *   服务层实现——见 ADR-004 决策四的 schema 边界记录）：已落库首问
 *   turn（显式前缀 + 问题原文全等）→ 幂等重放，不重发；分支存在非终态
 *   Run（在途/未收敛）→ 结果未知，**不盲发**（dispatch "unknown"）；
 *   无落库 turn 且全部 Run 终态 → 从未送达或明确失败，可（重）派发
 *   （失败重试是显式允许的新尝试）；首问已用**不同内容**送达 → 409
 *   （同分支首问不可变——改问是普通续聊，不是首问重试）；
 * - 浏览/搜索不创建 Turn（建枝调用只落 Branch/来源/绑定，零 Run/Turn）；
 *   保存批注（术语面）不自动建枝（本服务只被显式建枝入口调用）。
 *
 * Return（charter §3.3 规则七）：材料 Branch 的 Return 落所属 Tree 主线，
 * 完全复用 submitReturn 的保存先于导航（导航失败不回滚、结果分离呈现）与
 * return_adoption_attempts 采用尝试记录；targetAnchor 为 null（没有主线
 * 对话锚点，绝不伪造主线位置），卡片数据（材料标题/版本/块·页/摘录/确认
 * 时间/采用记录 + 原文跳转 sourceJump）从不可变材料来源 + return turn
 * 派生，主线按确认时间放置。
 */

/** Stable public material branching entrypoint. */
export {
  MATERIAL_CONTEXT_LIMIT_UNITS,
  MATERIAL_MAX_SELECTION_UNITS,
  MATERIAL_CONTEXT_TITLE_UNITS,
} from "./branching/policy.ts";
export {
  materialExplorationTurnPrefix,
  composeMaterialContext,
} from "./branching/context.ts";
export type {
  MaterialContextBlockRange,
  MaterialContextView,
  MaterialBranchingServiceOptions,
  MaterialBranchCreation,
  MaterialDispatchOutcome,
  MaterialFirstQuestionResult,
  MaterialRestoreResult,
  MaterialReturnCard,
  MaterialReturnSubmission,
} from "./branching/model.ts";
export {
  sameMaterialSelectionIdentity,
} from "./branching/identity.ts";
export {
  MaterialBranchConflictError,
  MaterialFirstQuestionConflictError,
} from "./branching/errors.ts";
export {
  MaterialBranchingService,
} from "./branching/service.ts";
