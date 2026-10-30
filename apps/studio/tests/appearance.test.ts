import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser modules intentionally have no TS declaration.
import { isSendKey, handleComposerKey, readAppearance, registerAppearance } from "../public/core/controllers/appearance.js";

test("send shortcuts distinguish every modifier and suppress IME/held Enter", () => {
  for (const key of ["enter", "control-enter", "shift-enter"]) {
    for (const mods of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }]) {
      const event = { key: "Enter", ...mods };
      const expected = key === "enter" ? Object.keys(mods).length === 0 : key === "shift-enter" ? !!mods.shiftKey && !mods.ctrlKey : !!(mods.ctrlKey || mods.metaKey) && !mods.shiftKey;
      assert.equal(isSendKey(event, key), expected);
      for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) assert.equal(isSendKey({ ...event, ...guard }, key), false);
    }
  }
});

test("modified newline replaces selection, emits draft update and never sends", () => {
  let submitted = 0, changes = 0;
  const input = Object.assign(new EventTarget(), { value: "abc", selectionStart: 1, selectionEnd: 2, disabled: false });
  input.addEventListener("input", () => changes++);
  const document = { documentElement: { dataset: { sendKey: "enter" } }, defaultView: { Event } };
  handleComposerKey({ key: "Enter", ctrlKey: true, preventDefault() {} }, input, () => submitted++, document);
  assert.equal(input.value, "a\nc"); assert.equal(changes, 1); assert.equal(submitted, 0);
  handleComposerKey({ key: "Enter", isComposing: true, preventDefault() { throw new Error("IME must retain control"); } }, input, () => submitted++, document);
  assert.equal(submitted, 0);
  handleComposerKey({ key: "Enter", preventDefault() {} }, input, () => submitted++, document);
  assert.equal(submitted, 1);
});

test("appearance defaults to warm, validates storage and applies even when storage is blocked", () => {
  assert.deepEqual(readAppearance({ getItem: () => '{"theme":"invalid","sendKey":"anything"}' }), { theme: "warm", sendKey: "enter" });
  const theme = Object.assign(new EventTarget(), { value: "" });
  const key = Object.assign(new EventTarget(), { value: "" });
  const status = { textContent: "" };
  const root = { dataset: {} as Record<string, string> };
  const nodes: Record<string, unknown> = { "appearance-theme": theme, "composer-send-key": key, "appearance-status": status };
  const document = { documentElement: root, getElementById: (id: string) => nodes[id], querySelector: () => null };
  const window = Object.assign(new EventTarget(), { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  const dispose = registerAppearance({ document, window });
  assert.equal(root.dataset.theme, "warm");
  theme.value = "sage"; key.value = "shift-enter"; theme.dispatchEvent(new Event("change"));
  assert.equal(root.dataset.theme, "sage"); assert.equal(root.dataset.sendKey, "shift-enter"); assert.match(status.textContent, /本页/);
  dispose(); theme.value = "warm"; theme.dispatchEvent(new Event("change")); assert.equal(root.dataset.theme, "sage");
});

// @ts-expect-error Browser modules intentionally have no TS declaration.
import { attachedQuestion } from "../public/core/controllers/composer-tools.js";
test("attachment presentation hides internal URLs while preserving source identity and malformed user text", () => {
  const text = "附件：[Notes.md](/api/trees/tree-1/materials/material-1/versions/version-1/file)（v1 · 全文）\n\nWhat changed?";
  const result = attachedQuestion(text);
  assert.equal(result.text, "What changed?");
  assert.equal(result.files[0].versionId, "version-1");
  assert.equal(result.files[0].title, "Notes.md");
  assert.deepEqual(attachedQuestion("附件：[not a source](https://example.com)\n\nQuestion"), { text: "附件：[not a source](https://example.com)\n\nQuestion", files: [] });
  const malformed = text.replace("tree-1", "%zz");
  assert.deepEqual(attachedQuestion(malformed), { text: malformed, files: [] });
});
