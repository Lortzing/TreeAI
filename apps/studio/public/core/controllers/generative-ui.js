import { renderComparison } from "../views/comparison.js";

/** One controller per Studio instance. Generation is always an explicit action. */
export function createGenerativeUiController(deps) {
  const cards = new Map();
  const requestFetch = deps.fetch; // Native fetch requires its original receiver.
  let disposed = false;
  const element = (tag, text, className) => {
    const node = deps.document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const active = c => !disposed && c.node.open && c.node.isConnected && deps.state.currentTreeId === c.treeId && deps.state.panelBranchId === c.branchId;
  const pending = task => task && ["queued", "running"].includes(task.state);
  function storage(c, value) {
    c.intent = value;
    try {
      if (value) deps.window.localStorage.setItem(c.storageKey, JSON.stringify(value));
      else deps.window.localStorage.removeItem(c.storageKey);
    } catch { /* Session intent still prevents repeated dispatch in this view. */ }
  }
  async function request(c, suffix = "", method = "GET", body) {
    const controller = new AbortController(); c.requests.add(controller);
    try {
      const response = await requestFetch(c.url + suffix, { method, signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-treeai-generative-ui": "1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.error?.message || "对比卡请求失败。"); error.status = response.status; throw error; }
      return data;
    } finally { c.requests.delete(controller); }
  }
  function schedule(c) {
    deps.window.clearTimeout(c.timer); c.timer = null;
    if (active(c) && c.tasks.some(pending)) c.timer = deps.window.setTimeout(() => { c.timer = null; void refresh(c); }, 1000);
  }
  function sources(c, context, task = null) {
    const target = task ? c.sourceBody : c.previewBody;
    target.replaceChildren();
    if (task) c.sourceDetails.hidden = false;
    for (const source of context?.sources || []) {
      const section = element("section"); section.dataset.sourceKey = source.key;
      section.append(element("strong", `${source.key} · ${source.title}`), element("pre", source.kind === "turn" ? source.text : source.selection.excerpt));
      if (task) {
        const locate = element("button", "定位原文"); locate.type = "button";
        locate.addEventListener("click", async () => {
          locate.disabled = true;
          try {
            const { source: verified } = await request(c, `/${encodeURIComponent(task.id)}/sources/${encodeURIComponent(source.key)}`);
            if (active(c)) await deps.locateSource(c.branchId, c.turnId, verified);
          } catch (err) { if (active(c)) c.message.textContent = err.message; }
          finally { locate.disabled = false; }
        });
        section.append(locate);
      }
      target.append(section);
    }
  }
  function closeReading(c) { if (c.dialog.open) c.dialog.close(); }
  function showTask(c, id) {
    const task = c.tasks.find(t => t.id === id && t.artifact);
    if (!task || c.selectedId === id) return;
    c.selectedId = id; c.revisions.value = id; c.zoom.hidden = false;
    c.result.replaceChildren(renderComparison({ document: deps.document, task,
      onSource: (t, key) => {
        closeReading(c);
        sources(c, t.context, t); c.sourceDetails.open = true;
        for (const section of c.sourceBody.children) if (section.dataset.sourceKey === key) section.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      },
      onDraft: text => {
        if (!active(c)) return;
        if (deps.state.busy) { c.message.textContent = "请等待当前操作完成后再填入草稿。"; return; }
        closeReading(c);
        deps.appendDraft(c.branchId, text); c.message.textContent = "已追加到 Return 草稿，可以编辑后再确认回收。";
      },
    }));
    sources(c, task.context, task);
  }
  function update(c) {
    const inFlight = c.tasks.find(pending);
    const latest = c.tasks[0];
    c.generate.disabled = c.submitting || !!inFlight || !c.context;
    c.input.disabled = c.submitting || !!inFlight || !!c.intent;
    c.generate.textContent = c.intent ? "重试本次请求" : c.tasks.length ? "生成新版本" : "生成对比卡";
    c.cancel.hidden = !inFlight;
    c.status.textContent = inFlight ? (inFlight.state === "queued" ? "已排队…" : "正在生成…") : latest ?
      (latest.state === "succeeded" ? `版本 ${latest.revision} 已保存` : latest.error || latest.state) : "手动生成 · 阅读与勾选不调用模型";
    if (latest?.costUnknown) c.status.textContent += " · 费用未确认，已保守计入额度";
    const successful = c.tasks.filter(t => t.artifact);
    const sig = successful.map(t => t.id).join(",");
    if (sig !== c.revisionSignature) {
      c.revisionSignature = sig;
      c.revisions.replaceChildren(...successful.map(t => { const option = element("option", `版本 ${t.revision} · ${t.createdAt.slice(0, 16).replace("T", " ")}`); option.value = t.id; return option; }));
      c.revisions.hidden = successful.length < 2;
      if (!c.selectedId && successful[0]) showTask(c, successful[0].id);
      if (c.selectedId) c.revisions.value = c.selectedId;
    }
  }
  async function refresh(c) {
    if (!active(c)) return;
    if (c.loading) { c.needsRefresh = true; return; }
    c.loading = true;
    try {
      const data = await request(c, `?branchId=${encodeURIComponent(c.branchId)}&turnId=${encodeURIComponent(c.turnId)}`);
      if (!active(c)) return;
      c.tasks = data.tasks; c.context = data.context;
      if (c.intent && c.tasks.some(t => t.intentId === c.intent.intentId)) storage(c, null);
      c.budget.textContent = `${data.usage.offline ? "离线示例，不代表模型分析质量。 " : ""}今日生成额度 ${data.usage.usedChars.toLocaleString()} / ${data.usage.dailyBudgetChars.toLocaleString()} 字符（UTC 日；非账单金额）。`;
      c.message.textContent = data.contextError || "";
      sources(c, c.context);
      update(c);
    } catch (err) { if (active(c)) c.message.textContent = `${err.message} 折叠后重新展开可刷新。`; }
    finally { c.loading = false; if (c.needsRefresh && active(c)) { c.needsRefresh = false; void refresh(c); } else schedule(c); }
  }
  async function generate(c) {
    if (!active(c) || c.submitting || c.tasks.some(pending) || !c.context) return;
    if (!c.intent) storage(c, { intentId: deps.crypto.randomUUID(), instruction: c.input.value });
    c.submitting = true; update(c); c.message.textContent = "";
    try {
      const { task } = await request(c, "", "POST", { branchId: c.branchId, anchorTurnId: c.turnId, ...c.intent });
      storage(c, null);
      if (!active(c)) return;
      c.tasks = [task, ...c.tasks.filter(t => t.id !== task.id)];
    } catch (err) {
      if (err.status >= 400 && err.status < 500) storage(c, null);
      if (active(c)) c.message.textContent = `${err.message} ${c.intent ? "重试会沿用本次请求，不会重复生成。" : ""}`;
    } finally { c.submitting = false; if (active(c)) { update(c); schedule(c); } }
  }
  function card(turn, branchId) {
    if (!deps.state.currentTreeId || branchId === deps.state.treeState?.trunkBranchId || !turn.text.trim()) return null;
    const treeId = deps.state.currentTreeId;
    const key = `${treeId}:${turn.id}`;
    if (cards.has(key)) {
      const existing = cards.get(key);
      if (existing.node.open && !existing.timer && !existing.loading) existing.timer = deps.window.setTimeout(() => { existing.timer = null; void refresh(existing); }, 0);
      return existing.node;
    }
    const node = element("details", undefined, "comparison-card");
    const c = { node, treeId, branchId, turnId: turn.id, tasks: [], requests: new Set(), timer: null, loading: false, submitting: false,
      selectedId: null, revisionSignature: null, context: null, intent: null, storageKey: `treeai-comparison-intent:${key}`,
      url: `/api/trees/${encodeURIComponent(treeId)}/generative-ui` };
    try { const value = JSON.parse(deps.window.localStorage.getItem(c.storageKey)); if (typeof value?.intentId === "string" && typeof value?.instruction === "string") c.intent = value; } catch {}
    node.append(element("summary", "对比一下 · 将回答整理成概念对比卡"));
    const content = element("div", undefined, "comparison-content");
    c.status = element("p", "展开后查看来源，手动生成。", "comparison-status"); c.status.setAttribute("role", "status");
    const label = element("label", "想比较什么？（可选）");
    c.input = element("input"); c.input.type = "text"; c.input.maxLength = 400; c.input.placeholder = "例如：比较适用条件与常见误区"; c.input.value = c.intent?.instruction || ""; label.append(c.input);
    c.previewDetails = element("details"); c.previewDetails.append(element("summary", "本次生成来源 · 仅发送这些资料与比较要求")); c.previewBody = element("div", undefined, "comparison-sources"); c.previewDetails.append(c.previewBody);
    c.sourceDetails = element("details"); c.sourceDetails.hidden = true; c.sourceDetails.append(element("summary", "已保存版本的来源摘录")); c.sourceBody = element("div", undefined, "comparison-sources"); c.sourceDetails.append(c.sourceBody);
    c.generate = element("button", "生成对比卡"); c.generate.type = "button"; c.generate.disabled = true; c.generate.addEventListener("click", () => void generate(c));
    c.cancel = element("button", "取消生成"); c.cancel.type = "button"; c.cancel.hidden = true;
    c.cancel.addEventListener("click", async () => {
      const task = c.tasks.find(pending); if (!task) return;
      c.cancel.disabled = true;
      try { await request(c, `/${encodeURIComponent(task.id)}/cancel`, "POST", {}); await refresh(c); }
      catch (err) { if (active(c)) c.message.textContent = err.message; }
      finally { c.cancel.disabled = false; }
    });
    const actions = element("div", undefined, "comparison-actions"); actions.append(c.generate, c.cancel);
    c.budget = element("small"); c.message = element("p", "", "comparison-message"); c.message.setAttribute("role", "status");
    c.revisions = element("select"); c.revisions.hidden = true; c.revisions.setAttribute("aria-label", "选择已保存的对比版本"); c.revisions.addEventListener("change", () => showTask(c, c.revisions.value));
    c.zoom = element("button", "放大阅读"); c.zoom.type = "button"; c.zoom.hidden = true;
    c.dialog = element("dialog", undefined, "comparison-dialog"); c.dialog.setAttribute("aria-label", "对比卡放大阅读");
    const readingHeader = element("div", undefined, "comparison-reading-header");
    const close = element("button", "关闭放大阅读"); close.type = "button"; close.addEventListener("click", () => closeReading(c));
    readingHeader.append(element("strong", "概念对比 · 放大阅读"), close);
    c.enlarged = element("div"); c.dialog.append(readingHeader, c.enlarged);
    // Keep modal keys local; native Escape closes only the reading dialog.
    c.dialog.addEventListener("keydown", event => event.stopPropagation());
    c.dialog.addEventListener("close", () => { c.result.append(...c.enlarged.children); });
    c.zoom.addEventListener("click", () => { c.enlarged.append(...c.result.children); c.dialog.showModal(); });
    c.result = element("div"); content.append(c.status, label, c.previewDetails, actions, c.budget, c.message, c.revisions, c.zoom, c.result, c.sourceDetails); node.append(content, c.dialog);
    node.addEventListener("toggle", () => {
      if (node.open) void refresh(c);
      else { deps.window.clearTimeout(c.timer); c.timer = null; for (const r of c.requests) r.abort(); }
    });
    cards.set(key, c); return node;
  }
  function dispose() {
    disposed = true;
    for (const c of cards.values()) { closeReading(c); deps.window.clearTimeout(c.timer); for (const r of c.requests) r.abort(); }
    cards.clear();
  }
  return { card, dispose };
}
