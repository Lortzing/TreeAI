import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsAtBottom } from "../public/shared/reading-position/scroll.js";
import { createSelectionOffsetsWithin } from "../public/shared/source/selection.js";
import { isElementNode, findReusableTurnElement } from "../public/core/dom.js";
import { createMarkdownRenderer } from "../public/core/views/markdown.js";
import { clampToGraphemeBoundaries } from "../public/shared/source/grapheme.js";

test("scroll follow keeps the 48px threshold and does not pull users reading above", () => {
  const isAtBottom = createIsAtBottom(48);
  assert.equal(isAtBottom({scrollTop:752,clientHeight:200,scrollHeight:1000}),true);
  assert.equal(isAtBottom({scrollTop:751,clientHeight:200,scrollHeight:1000}),false);
});
test("selection offsets reject source mismatch without creating an incorrect anchor", () => {
  const anchor = {};
  const range = {commonAncestorContainer:anchor,startContainer:anchor,startOffset:2,toString:()=> "llo",
    cloneRange:()=>({selectNodeContents(){},setEnd(){},toString:()=> "he"})};
  const select=createSelectionOffsetsWithin({getSelection:()=>({rangeCount:1,getRangeAt:()=>range})});
  const element={contains:node=>node===anchor};
  assert.deepEqual(select(element,"hello"),{start:2,end:5,text:"llo"});
  assert.equal(select(element,"hillo"),null);
});
test("DOM turn reuse excludes Return cards and requires exact turn text", () => {
  const make=(id,text,isReturn=false)=>({dataset:{turnId:id,turnText:text},
    classList:{contains:c=>c==="turn"||(isReturn&&c==="return")}});
  const normal=make("t1","text"),ret=make("t1","text",true);
  assert.equal(isElementNode(normal),true);
  assert.equal(findReusableTurnElement({children:[ret,normal]}, {id:"t1",text:"text"}),normal);
  assert.equal(findReusableTurnElement({children:[ret,normal]}, {id:"t1",text:"other"}),null);
});


test("R1 Markdown view preserves syntax, source offsets and styled text", () => {
  function element(tag) {
    return {
      tag, className: "", title: "", children: [],
      append(...nodes) { this.children.push(...nodes); },
      set textContent(value) { this.children = [{ textContent: value }]; },
      get textContent() { return this.children.map((node) => node.textContent).join(""); },
    };
  }
  const document = { createElement: element, createTextNode: (value) => ({ textContent: value }) };
  const { renderMarkdownInto } = createMarkdownRenderer(document);
  const source = "# Heading\nA **strong** [link](url) and 🚀\n\n~~~\nconst x = 1;\n~~~";
  const container = element("div");
  assert.equal(renderMarkdownInto(container, source, false), false);
  assert.equal(container.textContent, source);
  assert.ok(container.children.some((child) => child.className === "mat-h1"));
  assert.ok(container.children.some((child) => child.className === "mat-code-line"));
  assert.equal(container.textContent.indexOf("🚀"), source.indexOf("🚀"));
});

test("R1 Markdown view carries fenced-code state between material blocks", () => {
  const element = () => ({
    children: [], append(...nodes) { this.children.push(...nodes); },
    set textContent(value) { this.children = [{ textContent: value }]; },
    get textContent() { return this.children.map((node) => node.textContent).join(""); },
  });
  const document = { createElement: element, createTextNode: (value) => ({ textContent: value }) };
  const { renderMarkdownInto } = createMarkdownRenderer(document);
  const first = element();
  const open = renderMarkdownInto(first, "~~~\nconst x = 1;", false);
  assert.equal(open, true);
  assert.equal(first.textContent, "~~~\nconst x = 1;");
  const second = element();
  assert.equal(renderMarkdownInto(second, "const y = 2;\n~~~", open), false);
  assert.equal(second.textContent, "const y = 2;\n~~~");
});


test("R1 material selection snaps surrogate pairs and combining graphemes outwards", () => {
  assert.deepEqual(clampToGraphemeBoundaries("x🚀y", 2, 3), { start: 1, end: 3, snapped: true });
  assert.deepEqual(clampToGraphemeBoundaries("a\u0301b", 1, 2), { start: 0, end: 2, snapped: true });
  assert.deepEqual(clampToGraphemeBoundaries("x", 0, 1), { start: 0, end: 1, snapped: false });
  assert.equal(clampToGraphemeBoundaries("x", 0, 0), null);
});

test("R1 material selection keeps a joined emoji grapheme intact", () => {
  const text = "x👩‍💻y";
  assert.deepEqual(clampToGraphemeBoundaries(text, 2, text.length - 1), {
    start: 1, end: text.length - 1, snapped: true,
  });
});
