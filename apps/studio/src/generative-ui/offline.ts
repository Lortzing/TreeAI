/** Explicitly labelled offline fixture, only used by the Echo driver. */
export function offlineComparisonAnswer(): string {
  return JSON.stringify({ kind: "comparison", title: "离线示例：概念对比", concepts: [
    { key: "a", label: "概念 A（示例）" }, { key: "b", label: "概念 B（示例）" },
  ], rows: [{ key: "r1", dimension: "适用条件", cells: [
    { conceptKey: "a", text: "这里展示第一种概念的适用条件。离线模式不分析资料。", sourceKeys: [] },
    { conceptKey: "b", text: "这里展示第二种概念的适用条件。请切换模型以生成实际对比。", sourceKeys: [] },
  ], takeaway: "比较两个概念时，需要同时关注条件与适用范围。（离线示例）", basis: "model-inference" }] });
}
