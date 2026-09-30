/**
 * D4-8 大规模树导航 —— HTTP 接线服务层（issue #8 D4-8 接线增量）。
 *
 * 职责（nav-engine 查询内核 + 展开状态持久化 的组合面）：
 *  - 持有每服务器一个 TreeNavEngine（每树惰性读索引 + 显式失效）；
 *  - 展开状态整组读写：TreeRepository.saveNavExpandState / findNavExpandState
 *    （migration 0010 nav_tree_expand_state——重启后展开状态与阅读位置不丢）；
 *  - 树写入后由宿主（index.ts / 测试）调用 invalidate(treeId) 显式失效
 *    该树读索引——引擎索引不是事实源，过期游标按稳定原因码报错。
 *
 * 产品树 ≠ 运行 session 树（charter §5）：本服务全部查询只读产品事实
 * （trees/branches/turns/origins），从不读 run/session 可用性——session
 * 全部消失时导航结果逐字节不变（结构性保证，verify-d4 b9 行实测）。
 *
 * 诚实边界：虚拟化/键盘/DOM 计数属前端增量；本服务无任何 UI 状态推断
 * （展开状态只存取调用方提交的显式快照）。
 */

import type { BranchId, NavTreeExpandState, TreeId } from "@treeai/contracts";
import type { MaterialRepository, TreeRepository } from "@treeai/persistence";
import { TreeNavEngine } from "./nav-engine.ts";

export interface NavServiceOptions {
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
}

export class NavService {
  readonly engine: TreeNavEngine;
  readonly #repository: TreeRepository;

  constructor(options: NavServiceOptions) {
    this.engine = new TreeNavEngine({
      repository: options.repository,
      materialRepository: options.materialRepository,
    });
    this.#repository = options.repository;
  }

  /** 某树被写入后显式失效其读索引（宿主接线；游标随版本过期）。 */
  invalidate(treeId: string): void {
    this.engine.invalidate(treeId);
  }

  /** 读取某树的展开状态（无则 null——诚实空态，不伪造默认展开）。 */
  getExpandState(treeId: TreeId): NavTreeExpandState | null {
    return this.#repository.findNavExpandState(treeId);
  }

  /** 整组写入某树的展开状态（校验与去重在仓储层；返回落库快照）。 */
  saveExpandState(input: {
    readonly treeId: TreeId;
    readonly expandedBranchIds: readonly BranchId[];
    readonly selectedBranchId: BranchId | null;
  }): NavTreeExpandState {
    return this.#repository.saveNavExpandState(input);
  }
}
