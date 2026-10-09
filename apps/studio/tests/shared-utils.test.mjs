import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsAtBottom } from "../public/shared/reading-position/scroll.js";
import { createSelectionOffsetsWithin } from "../public/shared/source/selection.js";
import { isElementNode, findReusableTurnElement } from "../public/core/dom.js";

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
