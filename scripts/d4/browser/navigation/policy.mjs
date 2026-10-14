/** policy ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */

/* charter B9 冻结目标（不得为通过而调整）。 */
export const NAV_P95_LIMIT_MS = 300;


export const BIG_FIRST_OPEN_LIMIT_MS = 2000;


/** 虚拟化 DOM 行数上限（视口 ~900px/34px 行高 + 双侧 overscan 10 的工程余量）。 */
export const VIRTUALIZED_DOM_ROW_LIMIT = 80;


/** p95 落入限额 80% 带内 → 整序列复测一次（并发机器上的诚实复测策略）。 */
export const RERUN_BAND_RATIO = 0.8;


export const ROW_HEIGHT = 34;

/** 探针期前端现象记录（frontendBugs 汇总入 sidecar）。 */
export const NAV_FRONTEND_FINDINGS = { selectedRowOutsideWindow: false };
