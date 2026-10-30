/** policy ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 探针标记（确定性、唯一；不与其他探针的标记交叉）                       */
/* ------------------------------------------------------------------ */

export const TERM_MARKERS = {
  q1: "TreeAI-术语探针-主干一-q1a2b3",
  q2: "TreeAI-术语探针-主干二-c4d5e6",
  termQ1: "TreeAI-术语探针-TERM首问-f7g8h9",
  termF1: "TreeAI-术语探针-TERM追问一-j0k1l2",
  termF2: "TreeAI-术语探针-TERM追问二-m3n4o5",
  termRet: "TreeAI-术语探针-TERM收获-p6q7r8",
  rangeQ1: "TreeAI-术语探针-RANGE首问-s9t0u1",
  rangeF1: "TreeAI-术语探针-RANGE追问一-v2w3x4",
  rangeF2: "TreeAI-术语探针-RANGE追问二-y5z6a7",
  rangeRet: "TreeAI-术语探针-RANGE收获-b8c9d0",
  restartF: "TreeAI-术语探针-重启续走-e1f2g3",
  openF: "TreeAI-术语探针-另开首问-h4i5j6",
};

/** 主干提问（Q2 的回答是术语锚点答案；英文词让 term/range 选区在 echo 与
 *  真实模型回答里都确定可挑）。 */
export const TRUNK_Q1 = `请用两三句话说明你会如何回答问题。（${TERM_MARKERS.q1}）`;


export const TRUNK_Q2 =
  `请用大约150字介绍机器学习中 regularization 与 lasso 回归的作用，并顺带解释 overfitting 一词的含义。（${TERM_MARKERS.q2}）`;

/** term 选区的候选词（按优先序；大小写不敏感匹配，选区取原文精确子串）。 */
export const TERM_CANDIDATES = ["regularization", "lasso", "overfitting"];

/* 视口档（③ 宽窄两档；收尾还原 runner 缺省视口）。 */
export const WIDE_VIEWPORT = { width: 1600, height: 900 };


export const NARROW_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };


export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };


export const OVERFLOW_X_TOLERANCE_PX = 1;


export const SCROLL_TOLERANCE_PX = 2;

/* 抽屉内三选一按钮的稳定序（renderDrawer 固定顺序：manual-only(1) /
   minimal-hints(2) / assisted-reading(3)）。 */
export const MODE_BUTTON_INDEX = { "manual-only": 1, "minimal-hints": 2, "assisted-reading": 3 };


export const GATE_NOTE_SNIPPET = "自动提示暂未开放，你仍可选中文字进行解释";
