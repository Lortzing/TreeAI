import assert from "node:assert/strict";
import test from "node:test";
import { validateComparison } from "@treeai/persistence";

function comparison() {
  return {
    kind: "comparison",
    title: "两种概念",
    concepts: [
      { key: "alpha", label: "概念甲" },
      { key: "beta", label: "概念乙" },
    ],
    rows: [
      {
        key: "dimension",
        dimension: "依据",
        cells: [
          { conceptKey: "alpha", text: "来源内容甲", sourceKeys: ["source-1"] },
          { conceptKey: "beta", text: "来源内容乙", sourceKeys: ["source-1"] },
        ],
        takeaway: "可比较",
        basis: "source-based",
      },
    ],
  };
}

test("接受合法的双概念对比卡", () => {
  const value = comparison();
  assert.deepEqual(validateComparison(value, ["source-1"]), value);
});

test("拒绝未知字段和不支持的组件类型", () => {
  assert.throws(() => validateComparison({ ...comparison(), extra: true }, ["source-1"]));
  assert.throws(
    () => validateComparison({ ...comparison(), kind: "unknown-component" }, ["source-1"]),
  );
});

test("拒绝重复概念键和重复行键", () => {
  const value = comparison();
  assert.throws(
    () =>
      validateComparison(
        {
          ...value,
          concepts: [{ key: "alpha", label: "概念甲" }, { key: "alpha", label: "概念乙" }],
        },
        ["source-1"],
      ),
  );
  assert.throws(
    () => validateComparison({ ...value, rows: [value.rows[0], value.rows[0]] }, ["source-1"]),
  );
});

test("拒绝伪造的来源引用", () => {
  const value = comparison();
  value.rows[0]!.cells[0]!.sourceKeys = ["source-forged"];
  assert.throws(() => validateComparison(value, ["source-1"]));
});

test("拒绝缺失的概念单元格", () => {
  const value = comparison();
  value.rows[0]!.cells.pop();
  assert.throws(() => validateComparison(value, ["source-1"]));
});

test("拒绝超过总字符上限的输出", () => {
  const concepts = [
    { key: "alpha", label: "概念甲" },
    { key: "beta", label: "概念乙" },
    { key: "gamma", label: "概念丙" },
  ];
  const rows = Array.from({ length: 6 }, (_, index) => ({
    key: `row-${index}`,
    dimension: "维度",
    cells: concepts.map((concept) => ({
      conceptKey: concept.key,
      text: "x".repeat(700),
      sourceKeys: [],
    })),
    takeaway: "总结",
    basis: "model-inference",
  }));
  assert.throws(() => validateComparison({ kind: "comparison", title: "对比", concepts, rows }, []));
});

test("将恶意 HTML 保留为普通文本", () => {
  const value = comparison();
  const html = "<script>alert(1)</script>";
  value.rows[0]!.cells[0]!.text = html;
  const result = validateComparison(value, ["source-1"]);
  assert.equal(result.rows[0]!.cells[0]!.text, html);
});
