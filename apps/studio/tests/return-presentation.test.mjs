import { test } from "node:test";
import assert from "node:assert/strict";
import { returnFallbackReason, returnAttemptsFor, createReturnExcerptElement } from "../public/features/return/presentation.js";

const anchor = {anchorTurnId:"t1",selection:{start:1,end:4,text:"ood"}};
test("Return fallback distinguishes unlocatable, drifted and other-branch sources",()=>{
  const turn={targetAnchor:anchor};
  assert.deepEqual(returnFallbackReason(null,turn),{kind:"missing",anchor:null});
  assert.equal(returnFallbackReason({branches:[]},turn).kind,"missing");
  assert.equal(returnFallbackReason({branches:[{turns:[{id:"t1",role:"assistant",branchId:"b1",text:"bad"}]}]},turn).kind,"changed");
  assert.deepEqual(returnFallbackReason({branches:[{turns:[{id:"t1",role:"assistant",branchId:"b1",text:"goods"}]}]},turn),
    {kind:"elsewhere",anchor,anchorBranchId:"b1"});
});
test("Return read model preserves attempt order, no synthetic delivered status",()=>{
  const a={turnId:"r1",runState:"aborted"},b={turnId:"r2",runState:"succeeded"};
  assert.deepEqual(returnAttemptsFor({returnAttempts:[a,b]},"r1"),[a]);
  assert.deepEqual(returnAttemptsFor({},"r1"),[]);
});
test("Return long excerpt retains exact saved text and accessible details/summary",()=>{
  const el=(tag)=>({tag,className:"",textContent:"",children:[],append(...nodes){this.children.push(...nodes)}});
  const create=createReturnExcerptElement({createElement:el});
  assert.equal(create("short"),null);
  const long="a".repeat(121);
  const details=create(long);
  assert.equal(details.tag,"details");
  assert.equal(details.children[0].tag,"summary");
  assert.equal(details.children[1].textContent,`“${long}”`);
});
