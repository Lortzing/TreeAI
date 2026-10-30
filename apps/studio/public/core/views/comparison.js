/** Fixed, text-only component catalog. Model output never creates DOM attributes or code. */
export function renderComparison({ document, task, onSource, onDraft }) {
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = element("section", undefined, "comparison-result");
  root.dataset.taskId = task.id;
  const artifact = task.artifact;
  if (!artifact) return root;
  if (artifact.schemaVersion !== 1 || artifact.catalogVersion !== "comparison-v1") {
    root.append(element("p", "当前版本无法显示这张卡片，以下为已保存的文本。"), element("pre", artifact.fallbackText));
    return root;
  }
  const doc = artifact.document;
  root.append(element("h4", doc.title));
  const selected = new Set();
  const actions = element("div", undefined, "comparison-actions");
  const draft = element("button", "选取收获后填入 Return 草稿");
  draft.type = "button"; draft.disabled = true;
  draft.addEventListener("click", () => {
    const text = doc.rows.filter(row => selected.has(row.key)).map(row => `• ${row.takeaway}${row.basis === "model-inference" ? "（模型推断）" : ""}`).join("\n");
    onDraft(`对比收获：${doc.title}\n${text}`);
  });
  const frame = element("div", undefined, "comparison-table-frame");
  const table = element("table");
  const head = element("thead");
  const labels = element("tr");
  for (const label of ["比较维度", ...doc.concepts.map(c => c.label)]) {
    const cell = element("th", label); cell.scope = "col"; labels.append(cell);
  }
  head.append(labels); table.append(head);
  const body = element("tbody");
  for (const row of doc.rows) {
    const tr = element("tr");
    const title = element("th"); title.scope = "row";
    title.append(element("span", row.dimension), element("small", row.basis === "model-inference" ? "模型推断 · 待核对" : "附来源 · 请核对"));
    tr.append(title);
    for (const concept of doc.concepts) {
      const cell = row.cells.find(c => c.conceptKey === concept.key);
      const td = element("td"); td.append(element("p", cell.text));
      for (const key of cell.sourceKeys) {
        const button = element("button", `查看来源 ${key}`, "comparison-source-link"); button.type = "button";
        button.addEventListener("click", () => onSource(task, key)); td.append(button);
      }
      tr.append(td);
    }
    body.append(tr);
    const takeawayRow = element("tr"); const takeaway = element("td"); takeaway.colSpan = doc.concepts.length + 1;
    const label = element("label", undefined, "comparison-takeaway");
    const check = element("input"); check.type = "checkbox";
    check.addEventListener("change", () => {
      if (check.checked) selected.add(row.key); else selected.delete(row.key);
      draft.disabled = selected.size === 0;
      draft.textContent = selected.size ? `将 ${selected.size} 条收获填入 Return 草稿` : "选取收获后填入 Return 草稿";
    });
    label.append(check, element("span", row.takeaway)); takeaway.append(label); takeawayRow.append(takeaway); body.append(takeawayRow);
  }
  table.append(body); frame.append(table); root.append(frame);
  actions.append(draft); root.append(actions);
  const textView = element("details"); textView.append(element("summary", "文本视图"), element("pre", artifact.fallbackText)); root.append(textView);
  return root;
}
