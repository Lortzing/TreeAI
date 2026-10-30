const KEY = "treeai.appearance";
const THEMES = ["warm", "sage"];
const SEND_KEYS = ["enter", "control-enter", "shift-enter"];

export function readAppearance(storage) {
  let saved;
  try { saved = JSON.parse(storage?.getItem(KEY) ?? "null"); } catch { /* optional storage */ }
  return { theme: THEMES.includes(saved?.theme) ? saved.theme : "warm",
    sendKey: SEND_KEYS.includes(saved?.sendKey) ? saved.sendKey : "enter" };
}

export function isSendKey(event, sendKey) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return false;
  const control = !!(event.ctrlKey || event.metaKey);
  if (sendKey === "control-enter") return control && !event.shiftKey;
  if (sendKey === "shift-enter") return !!event.shiftKey && !control;
  return !control && !event.shiftKey;
}

/** Handles only AI question editors; Return confirmation and search retain their own semantics. */
export function handleComposerKey(event, input, send, document) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  if (event.repeat) { event.preventDefault(); return; }
  if (isSendKey(event, (document.documentElement ?? document.body)?.dataset.sendKey ?? "enter")) {
    event.preventDefault();
    if (!input.disabled) send();
  } else if ((event.ctrlKey || event.metaKey || event.altKey) && !input.disabled) {
    // Browsers do not consistently insert a newline for modified Enter.
    event.preventDefault();
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + "\n" + input.value.slice(end);
    input.setSelectionRange?.(start + 1, start + 1);
    const EventCtor = document.defaultView?.Event;
    if (EventCtor) input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  }
}

export function registerAppearance({ document, window }) {
  let storage;
  try { storage = window.localStorage; } catch { /* denied storage */ }
  let value = readAppearance(storage);
  const theme = document.getElementById("appearance-theme");
  const key = document.getElementById("composer-send-key");
  const status = document.getElementById("appearance-status");
  const inputStatus = document.getElementById("input-preference-status");
  const choices = [...(document.querySelectorAll?.("[data-theme-choice]") ?? [])];
  const apply = () => {
    if (document.documentElement) {
      document.documentElement.dataset.theme = value.theme;
      document.documentElement.dataset.sendKey = value.sendKey;
    }
    if (theme) theme.value = value.theme;
    for (const choice of choices) choice.setAttribute("aria-pressed", String(choice.dataset.themeChoice === value.theme));
    const shortcutHint = document.getElementById("input-shortcut-hint");
    if (shortcutHint) shortcutHint.textContent = value.sendKey === "enter" ? "Ctrl + Enter 或 Shift + Enter 换行" : "Enter 换行";
    if (key) key.value = value.sendKey;
    const hint = document.querySelector?.(".composer-context");
    if (hint) hint.textContent = ({ enter: "Enter 发送 · Ctrl + Enter 换行", "control-enter": "Ctrl / ⌘ + Enter 发送 · Enter 换行", "shift-enter": "Shift + Enter 发送 · Enter 换行" })[value.sendKey];
  };
  const change = () => {
    value = { theme: THEMES.includes(theme?.value) ? theme.value : value.theme, sendKey: SEND_KEYS.includes(key?.value) ? key.value : value.sendKey };
    apply();
    try { if (!storage) throw new Error("storage unavailable"); storage.setItem(KEY, JSON.stringify(value)); if (inputStatus) inputStatus.textContent = ""; if (status) status.textContent = "已自动保存。"; }
    catch { for (const target of [status, inputStatus]) if (target) target.textContent = "已在本页应用；浏览器未允许保存偏好。"; }
  };
  const sync = (event) => { if (event.key === KEY || event.key === null) { value = readAppearance(storage); apply(); } };
  const choose = event => { theme.value = event.currentTarget.dataset.themeChoice; change(); };
  for (const choice of choices) choice.addEventListener("click", choose);
  apply();
  theme?.addEventListener("change", change); key?.addEventListener("change", change);
  window.addEventListener?.("storage", sync);
  return () => { for (const choice of choices) choice.removeEventListener("click", choose); theme?.removeEventListener("change", change); key?.removeEventListener("change", change); window.removeEventListener?.("storage", sync); };
}
