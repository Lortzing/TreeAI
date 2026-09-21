/**
 * 反例：SessionReference 的引用三元组缺一不可。
 * 期望：本文件编译失败（缺少 entryId）。
 */
import type { SessionReference } from "../../../src/index.js";

// 必须编译失败：entryId（跨重启持久游标）是必填字段。
const reference: SessionReference = {
  sessionId: "sess-1" as SessionReference["sessionId"],
  sessionFile: "/tmp/treeai-fixtures/s.jsonl",
  piVersion: "0.85.1" as SessionReference["piVersion"],
  availability: { status: "available" },
};
