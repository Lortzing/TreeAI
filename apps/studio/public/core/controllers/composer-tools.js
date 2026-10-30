import { controlIcon } from "../dom.js";
/** Decode only the server's local attachment header; arbitrary user text remains literal. */
export function attachedQuestion(text = "") {
  const separator = text.indexOf("\n\n");
  if (!text.startsWith("附件：") || separator < 0) return { text, files: [] };
  const header = text.slice(3, separator);
  const pattern = /\[([^\]\n]+)\]\((\/api\/trees\/([^/()]+)\/materials\/([^/()]+)\/versions\/([^/()]+)\/file)\)（([^）]+)）/g;
  const matches = [...header.matchAll(pattern)];
  if (!matches.length || matches.map(match => match[0]).join("、") !== header) return { text, files: [] };
  try { return { text: text.slice(separator + 2), files: matches.map(match => ({ title: match[1], url: match[2], treeId: decodeURIComponent(match[3]), materialId: decodeURIComponent(match[4]), versionId: decodeURIComponent(match[5]), scope: match[6] })) }; } catch { return { text, files: [] }; }
}
const attachmentViews = new WeakMap();
export function clearComposerAttachments(input, sent) {
  const current = input.dataset.attachments ? JSON.parse(input.dataset.attachments) : [];
  input.dataset.attachments = JSON.stringify(current.filter(item => !sent.some(saved => saved.versionId === item.versionId && saved.treeId === item.treeId && saved.branchId === item.branchId)));
  attachmentViews.get(input)?.();
}
/** Shared question tools. Recognition only inserts a draft; it never sends it. */
export function createComposerTools(document, input, options = {}) {
  const win = document.defaultView;
  const row = document.createElement("div"); row.className = "question-tools";
  const status = document.createElement("span"); status.className = "question-tool-status"; status.setAttribute("role", "status");
  const button = (text, label, action) => {
    const node = document.createElement("button"); node.type = "button"; node.className = "question-tool";
    node.textContent = text; node.title = label; node.setAttribute("aria-label", label); node.addEventListener("click", action); return node;
  };
  const chips = document.createElement("div"); chips.className = "composer-attachments";
  const renderAttachments = () => {
    chips.replaceChildren();
    const attachments = input.dataset.attachments ? JSON.parse(input.dataset.attachments) : [];
    for (const item of attachments) {
      const chip = button(`${item.title} ×`, `移除附件 ${item.title}`, () => clearComposerAttachments(input, [item]));
      chip.className = "composer-attachment";
      chip.title = `${item.title} · ${item.scope}`;
      chips.append(chip);
    }
  };
  attachmentViews.set(input, renderAttachments);
  const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = ".md,.markdown,.pdf"; fileInput.multiple = true; fileInput.hidden = true;
  let uploading = false, disposed = false;
  const add = button("＋", "添加文件", () => {
    if (input.disabled || uploading) return;
    fileInput.click();
  });
  add.replaceChildren(controlIcon(document, "plus"));
  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])]; fileInput.value = "";
    if (!files.length || uploading) return;
    const context = options.getContext?.();
    if (!context?.treeId || !context.branchId) { status.textContent = "请先打开一段对话。"; return; }
    const existing = input.dataset.attachments ? JSON.parse(input.dataset.attachments) : [];
    if (files.length + existing.length > 4) { status.textContent = "每次最多添加 4 个文件。"; return; }
    uploading = true; add.disabled = true; input.dataset.attachmentPending = "true";
    const request = options.fetch ?? win?.fetch?.bind(win);
    const stillHere = () => !disposed && options.getContext?.().treeId === context.treeId && options.getContext?.().branchId === context.branchId;
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error("单个文件不能超过 20 MiB。");
        status.textContent = `正在添加 ${file.name}…`;
        const response = await request(`/api/trees/${encodeURIComponent(context.treeId)}/materials`, { method: "POST", headers: { "x-treeai-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: await file.arrayBuffer() });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || "文件导入失败。");
        let ready = null;
        for (let attempt = 0; attempt < 120; attempt++) {
          if (!stillHere()) throw new Error("对话已切换，已导入的文件仍保留在原思考的附件中。");
          const detailResponse = await request(`/api/trees/${encodeURIComponent(context.treeId)}/materials/${encodeURIComponent(payload.material.id)}`);
          if (!detailResponse.ok) throw new Error("无法读取附件状态，请稍后重试。");
          const detail = await detailResponse.json();
          const version = detail.versions.find(item => item.id === payload.version.id);
          if (version?.parseStatus === "ready") { ready = version; break; }
          if (version && !["pending", "parsing"].includes(version.parseStatus)) throw new Error("文件未能解析，可在附件列表中查看原因。");
          await new Promise(resolve => win.setTimeout(resolve, 500));
        }
        if (!ready) throw new Error("文件仍在处理，可稍后从附件中打开。");
        if (!stillHere()) throw new Error("对话已切换，文件保留在原思考中。");
        const attachments = input.dataset.attachments ? JSON.parse(input.dataset.attachments) : [];
        if (!attachments.some(item => item.versionId === ready.id && item.treeId === context.treeId && item.branchId === context.branchId)) attachments.push({ ...context, materialId: payload.material.id, versionId: ready.id, title: file.name, scope: ready.textUnits > 20000 ? "发送前 20,000 字" : "发送全文" });
        input.dataset.attachments = JSON.stringify(attachments); renderAttachments();
        await options.refreshMaterials?.();
      }
      status.textContent = "附件将随下次问题发送；每个文件最多包含前 20,000 字。";
    } catch (error) { status.textContent = error.message || "附件添加失败，请重试。"; }
    finally { uploading = false; add.disabled = false; input.dataset.attachmentPending = "false"; }
  });
  const model = document.createElement("select"); model.className = "question-model"; model.setAttribute("aria-label", "本次使用的模型");
  const option = (value, text) => { const el = document.createElement("option"); el.value = value; el.textContent = text; model.append(el); };
  option("", "当前模型");
  let loading = false, loaded = false;
  async function loadModels() {
    if (loaded || loading || !win?.fetch) return;
    loading = true;
    try {
      const response = await win.fetch("/api/settings/models");
      if (!response.ok) throw new Error("unavailable");
      const snapshot = await response.json();
      const choices = snapshot.models ?? [];
      model.replaceChildren(); option(snapshot.selection ? JSON.stringify(snapshot.selection) : "", choices.length ? "默认模型" : "当前模型");
      for (const item of choices) option(JSON.stringify({ providerId: item.providerId, modelId: item.modelId }), `${item.label} · ${item.providerId}`);
      model.value = document.documentElement?.dataset.composerModel || (snapshot.selection ? JSON.stringify(snapshot.selection) : "");
      loaded = true;
      if (!choices.length) status.textContent = "在设置中配置模型，重启后可在这里切换。";
    } catch { status.textContent = "暂时无法读取模型列表，请稍后重试。"; }
    finally { loading = false; }
  }
  model.addEventListener("focus", () => void loadModels());
  model.addEventListener("change", () => {
    if (!document.documentElement) return;
    document.documentElement.dataset.composerModel = model.value;
    for (const other of document.querySelectorAll(".question-model")) { if (other !== model && [...other.options].some(item => item.value === model.value)) other.value = model.value; }
    status.textContent = "";
  });
  let recognition = null;
  const stop = () => { if (!recognition) return; const session = recognition; recognition = null; session.abort(); voice.setAttribute("aria-pressed", "false"); voice.replaceChildren(controlIcon(document, "microphone")); };
  const voice = button("◉", "语音输入", () => {
    if (recognition) { stop(); status.textContent = "已停止语音输入。"; return; }
    if (input.disabled) return;
    const Speech = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
    if (!Speech) { status.textContent = "此浏览器不支持语音识别，可使用系统听写输入。"; return; }
    recognition = new Speech(); const session = recognition;
    session.lang = document.documentElement?.lang || "zh-CN";
    session.interimResults = false; session.continuous = true;
    session.onresult = event => {
      if (session !== recognition || !input.isConnected || input.disabled) { stop(); return; }
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) text += event.results[i][0].transcript;
      // Preserve edits made while recognition is running.
      input.value += (input.value && !/[\s\n]$/.test(input.value) ? " " : "") + text;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      status.textContent = "已转为文字，确认后发送。";
    };
    session.onerror = event => { status.textContent = event.error === "not-allowed" ? "未获得麦克风权限，可在浏览器设置中允许。" : "语音识别暂不可用，请重试或使用系统听写。"; stop(); };
    session.onend = () => { if (session === recognition) stop(); };
    try { session.start(); voice.setAttribute("aria-pressed", "true"); voice.replaceChildren(controlIcon(document, "stop")); status.textContent = "正在听…点击停止；文字不会自动发送。"; }
    catch { stop(); status.textContent = "语音识别未能启动。"; }
  });
  voice.replaceChildren(controlIcon(document, "microphone"));
  voice.setAttribute("aria-pressed", "false");
  // Stop capture if the question is removed, submitted or navigated away from.
  const observer = win?.MutationObserver ? new win.MutationObserver(() => { if (!input.isConnected || input.disabled) stop(); if (!input.isConnected) observer.disconnect(); }) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  row.append(chips, add, model, voice, fileInput, status);
  return { element: row, dispose: () => { disposed = true; stop(); observer?.disconnect(); attachmentViews.delete(input); } };
}
