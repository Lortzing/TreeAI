/** policy ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 探针标记（确定性、唯一；不与搜索探针的零结果查询或其他标记交叉）         */
/* ------------------------------------------------------------------ */

export const B3_MARKERS = {
  mdQ1: "TreeAI-B3-探针-MD-首问-6f2c",
  mdF1: "TreeAI-B3-探针-MD-追问一-a03e",
  mdF2: "TreeAI-B3-探针-MD-追问二-b7d1",
  pdfQ1: "TreeAI-B3-探针-PDF-首问-9e54",
  pdfF1: "TreeAI-B3-探针-PDF-追问一-77c2",
  pdfF2: "TreeAI-B3-探针-PDF-追问二-31b8",
  restartF: "TreeAI-B3-探针-重启续走-5c8a",
  mdRet: "TreeAI-B3-探针-MD-RETURN-2d61",
  pdfRet: "TreeAI-B3-探针-PDF-RETURN-84f0",
};

/** PDF fixture（B1 冻结集文字层 PDF；探针在场景树导入自己的副本）。 */
export const B3_PDF_FIXTURE_ID = "pdf-01";

/** 面板打开等待（真实 tab 点击 → openBranchPanel → /switch 对齐 → 渲染）。
 *
 * 已发现的前端缺陷（报告不修，elementFromPoint 证据入 sidecar）：
 * #branch-section 是侧栏唯一的 flex:1 区块且 min-height:0——其余区块
 * （Forest/Navigate/Materials/Search，各自 flex-shrink:0）合计高度逼近/超过
 * 视口时，#branch-section 被压到 **height 0**（实测 top 212 / h 0，而
 * #branch-tabs h 96）：分支 tab 全部被裁剪，elementFromPoint 命中
 * ASIDE#sidebar——真实用户无法点击任何分支 tab。1b48ef0 修的是
 * tree-list/material-list 的内部滚动，#branch-section 这个压力阀没有下限。
 * 探针以 DOM click 兜底继续行使面板路径（数据路径完好），缺陷如实上报。 */
export const B3_FRONTEND_BUGS = [];
