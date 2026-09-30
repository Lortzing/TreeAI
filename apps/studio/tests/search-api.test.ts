/**
 * D4-4 找回既有思考 —— 搜索 HTTP API 测试（issue #8 工作包 D4-4；真实
 * node:http 服务 + fetch + 离线 echo 驱动；D4 契约 §3）。
 *
 * 覆盖：
 * - 两个端点的 happy path：POST /api/trees/:treeId/search（当前树范围）
 *   与 POST /api/search（全部树）；响应 {hits:[SearchHit]}；
 * - 契约裁剪面：可空字段缺省（非 null——材料命中携带
 *   materialId/materialTitle/versionId/versionLabel/blockId，批注命中全部
 *   省略）；引擎附加 refId/matchType/matchCount 剥离；材料命中的
 *   start/end 是版本 canonicalText 内偏移（经分块读取面切片回查一致）；
 * - 范围：单树检索不泄漏他树事实；全部树检索跨树可见（treeTitle = 树 id）；
 * - kinds 过滤透传引擎（重复成员无害折叠）；
 * - 拒绝面：空/纯空白/非字符串 text → 400；kinds 非数组/空数组/未知成员/
 *   非字符串成员 → 400；坏 JSON body → 400；未知树 → 404；GET → 405；
 *   未装配（search 不注入）→ 503 search-not-wired；
 * - 零命中诚实面：语料中不存在的查询 → 200 {hits: []}（不编造）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { BranchId, SessionReference, TerminologyMode, TreeId, Turn } from "@treeai/contracts";
import { createStudioServer } from "../src/server.ts";
import { SearchService } from "../src/search/search-service.ts";
import { cleanupDir, makeStudioInstance, makeTempDataDir, type StudioInstance } from "./helpers.ts";

const staticDir = fileURLToPath(new URL("../public/", import.meta.url));
const ENCODER = new TextEncoder();

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** 轮询等待条件成立（解析任务是微任务/近即时，留足余量）。 */
async function until(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

interface JsonOutcome {
  status: number;
  body: any;
}

async function readOutcome(response: Response): Promise<JsonOutcome> {
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* 204 等无 body 响应 */
  }
  return { status: response.status, body: parsed };
}

async function call(url: string, method: string, body?: unknown): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readOutcome(response);
}

interface RunningStudio {
  port: number;
  /** 底层实例（仓储直写 SQLite，用于播种已保存产品事实）。 */
  instance: StudioInstance;
  url(path: string): string;
  close(): Promise<void>;
}

async function startStudio(dir: string, registry: RunningStudio[], wireSearch = true): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir);
  const search = new SearchService({
    treeRepository: studio.repository,
    materialRepository: studio.materialRepository,
  });
  const server = createStudioServer({
    service: studio.service,
    staticDir,
    materials: studio.materials,
    ...(wireSearch ? { search } : {}),
  });
  const port = await server.listen(0);
  let closed = false;
  const running: RunningStudio = {
    port,
    instance: studio,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await studio.shutdown();
    },
  };
  registry.push(running);
  return running;
}

async function closeAll(registry: RunningStudio[]): Promise<void> {
  for (const running of registry) {
    try {
      await running.close();
    } catch {
      /* 关闭失败不掩盖测试断言失败 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 播种（已保存产品事实，走真实仓储/导入流水线）                          */
/* ------------------------------------------------------------------ */

function sessionRef(): SessionReference {
  return {
    sessionId: "search-api-test" as SessionReference["sessionId"],
    sessionFile: "/tmp/search-api-test-session.jsonl",
    entryId: "entry-1" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  };
}

function seedAssistantTurn(
  studio: StudioInstance,
  treeId: TreeId,
  branchId: BranchId,
  text: string,
): Turn {
  const episode = studio.repository.createEpisode(branchId);
  const run = studio.repository.createRun(episode.id, sessionRef());
  return studio.repository.createTurn({
    treeId,
    branchId,
    episodeId: episode.id,
    runId: run.id,
    role: "assistant",
    text,
    piEntryId: null,
  });
}

/** 导入材料并等待 ready。 */
async function importReady(studio: StudioInstance, treeId: TreeId, filename: string, bytes: Uint8Array) {
  const result = await studio.materials.importMaterial(treeId, { filename, bytes });
  await until(
    () =>
      studio.materials
        .getMaterialDetail(treeId, result.material.id)
        .versions.some((version) => version.id === result.version.id && version.parseStatus === "ready"),
    `the parse of ${filename} to become ready`,
  );
  return result;
}

const MATERIAL_TEXT = "分代回收的写屏障记录跨代引用。\n\n第二段正文保持完整。";

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

test("scoped search returns contract-shaped material hits positioned in the canonical text", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { tree } = studio.instance.service.createTree();
    const material = await importReady(studio.instance, tree.id, "搜索材料.md", utf8(MATERIAL_TEXT));

    const outcome = await call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "POST", {
      text: "写屏障",
    });
    assert.equal(outcome.status, 200);
    assert.ok(Array.isArray(outcome.body.hits));
    assert.equal(outcome.body.hits.length, 1);
    const hit = outcome.body.hits[0];

    /* 契约字段全数在场且取值正确。 */
    assert.equal(hit.kind, "material");
    assert.equal(hit.treeId, tree.id);
    assert.equal(hit.treeTitle, tree.id, "product trees carry no display name — the tree id is the title");
    assert.equal(hit.materialId, material.material.id);
    assert.equal(hit.materialTitle, "搜索材料.md");
    assert.equal(hit.versionId, material.version.id);
    assert.equal(hit.versionLabel, "v1");
    assert.equal(hit.oldVersion, false);
    assert.equal(hit.blockId, "blk-0");
    assert.ok(typeof hit.start === "number" && typeof hit.end === "number");
    assert.ok(hit.excerpt.includes("写屏障"));
    assert.equal(hit.title, "搜索材料.md");
    assert.ok(typeof hit.createdAt === "string" && hit.createdAt.length > 0);

    /* 引擎附加字段剥离。 */
    for (const extra of ["refId", "matchType", "matchCount"]) {
      assert.ok(!(extra in hit), `the contract SearchHit must not carry the engine-only field '${extra}'`);
    }

    /* start/end 是版本 canonicalText 内偏移：分块读取面切片回查一致。 */
    const page = studio.instance.materials.readVersionBlocks(tree.id, material.material.id, material.version.id, {});
    const canonicalText = page.blocks.map((entry: { text: string }) => entry.text).join("");
    assert.equal(canonicalText.slice(hit.start, hit.end), "写屏障");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("annotation hits omit the material-only fields; absent queries return an honest empty list", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { tree, trunkBranch } = studio.instance.service.createTree();
    const answer = seedAssistantTurn(
      studio.instance,
      tree.id,
      trunkBranch.id,
      "词法作用域在定义点绑定环境，组合体随定义点固定。",
    );
    studio.instance.repository.createTerminologyAnnotation({
      treeId: tree.id,
      branchId: trunkBranch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 5, text: "词法作用域" },
      sourceHash: "test-source-hash",
      term: "词法作用域",
      explanation: "词法作用域在定义点绑定环境；跨材料找回时按批注正文检索。",
      mode: "term" as TerminologyMode,
    });

    const outcome = await call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "POST", {
      text: "定义点绑定环境",
    });
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.hits.length, 2);
    const annotationHit = outcome.body.hits[0];
    assert.equal(annotationHit.kind, "annotation");
    assert.ok(annotationHit.excerpt.includes("定义点绑定环境"));
    assert.equal(annotationHit.oldVersion, false);
    assert.ok(typeof annotationHit.start === "number" && typeof annotationHit.end === "number");
    /* 材料专有字段缺省（非 null——契约裁剪面）。 */
    for (const field of ["materialId", "materialTitle", "versionId", "versionLabel", "blockId"]) {
      assert.ok(!(field in annotationHit), `annotation hits must omit '${field}'`);
    }

    /* 零命中：语料中不存在——如实空数组，不编造。 */
    const absent = await call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "POST", {
      text: "马卡龙烘焙温度",
    });
    assert.equal(absent.status, 200);
    assert.deepEqual(absent.body, { hits: [] });
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("/api/search spans all trees; a scoped search never leaks another tree's facts", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const first = studio.instance.service.createTree();
    const second = studio.instance.service.createTree();
    await importReady(studio.instance, first.tree.id, "材料一.md", utf8(MATERIAL_TEXT));
    const answer = seedAssistantTurn(
      studio.instance,
      second.tree.id,
      second.trunkBranch.id,
      "闭包捕获定义点处的词法环境组合体。",
    );
    studio.instance.repository.createTerminologyAnnotation({
      treeId: second.tree.id,
      branchId: second.trunkBranch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 2, text: "闭包" },
      sourceHash: "test-source-hash",
      term: "闭包",
      explanation: "闭包组合体：环境与函数体的绑定。",
      mode: "term" as TerminologyMode,
    });

    /* 材料只在树一：树二范围内检索不到。 */
    const scoped = await call(
      studio.url(`/api/trees/${encodeURIComponent(second.tree.id)}/search`),
      "POST",
      { text: "写屏障" },
    );
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body, { hits: [] });

    /* 全部树范围：两棵树的事实都可见。 */
    const allMaterial = await call(studio.url("/api/search"), "POST", { text: "写屏障" });
    assert.equal(allMaterial.status, 200);
    assert.equal(allMaterial.body.hits.length, 1);
    assert.equal(allMaterial.body.hits[0].treeId, first.tree.id);

    const allAnnotation = await call(studio.url("/api/search"), "POST", { text: "组合体" });
    assert.equal(allAnnotation.status, 200);
    assert.ok(allAnnotation.body.hits.length >= 2);
    assert.ok(
      allAnnotation.body.hits.every((hit: any) => hit.treeId === second.tree.id),
      "the query text lives only in tree two",
    );
    assert.ok(
      allAnnotation.body.hits.some((hit: any) => hit.treeTitle === second.tree.id),
      "treeTitle is carried for cross-tree result display",
    );
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("kinds filter passes through to the engine", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { tree, trunkBranch } = studio.instance.service.createTree();
    await importReady(studio.instance, tree.id, "组合体材料.md", utf8("组合体出现在材料正文里。\n\n第二段。"));
    const answer = seedAssistantTurn(studio.instance, tree.id, trunkBranch.id, "组合体出现在回答正文里。");
    studio.instance.repository.createTerminologyAnnotation({
      treeId: tree.id,
      branchId: trunkBranch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 4, text: "组合体出" },
      sourceHash: "test-source-hash",
      term: "组合体",
      explanation: "组合体出现在批注解释里。",
      mode: "term" as TerminologyMode,
    });

    const scoped = (body: unknown): Promise<JsonOutcome> =>
      call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "POST", body);

    assert.deepEqual(
      (await scoped({ text: "组合体" })).body.hits.map((hit: any) => hit.kind),
      ["annotation", "turn", "material"],
    );
    assert.deepEqual(
      (await scoped({ text: "组合体", kinds: ["annotation"] })).body.hits.map((hit: any) => hit.kind),
      ["annotation"],
    );
    assert.deepEqual(
      (await scoped({ text: "组合体", kinds: ["material", "turn"] })).body.hits.map((hit: any) => hit.kind),
      ["turn", "material"],
    );
    assert.deepEqual(
      (await scoped({ text: "组合体", kinds: ["annotation", "annotation"] })).body.hits.map((hit: any) => hit.kind),
      ["annotation"],
      "duplicate kind entries collapse harmlessly",
    );
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("rejections: blank/wrong-type text, malformed kinds, bad JSON → 400", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { tree } = studio.instance.service.createTree();
    const scoped = (body: unknown): Promise<JsonOutcome> =>
      call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "POST", body);

    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: null }]) {
      const outcome = await scoped(body);
      assert.equal(outcome.status, 400, `text ${JSON.stringify(body.text)} must be rejected`);
      assert.equal(outcome.body.error.code, "invalid-argument");
    }
    for (const kinds of ["annotation", [], ["bogus"], [1], null]) {
      const outcome = await scoped({ text: "组合体", kinds });
      assert.equal(outcome.status, 400, `kinds ${JSON.stringify(kinds)} must be rejected`);
      assert.equal(outcome.body.error.code, "invalid-argument");
    }
    /* /api/search 同一校验面。 */
    const global = await call(studio.url("/api/search"), "POST", { text: "" });
    assert.equal(global.status, 400);
    const globalKinds = await call(studio.url("/api/search"), "POST", { text: "组合体", kinds: [] });
    assert.equal(globalKinds.status, 400);

    /* 坏 JSON body → 400（读体路径的既有纪律）。 */
    const raw = await fetch(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal((await readOutcome(raw)).status, 400);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("unknown tree → 404; non-POST methods → 405; unwired search → 503", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const unknown = await call(
      studio.url("/api/trees/tree-does-not-exist/search"),
      "POST",
      { text: "任意" },
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "not-found");

    const { tree } = studio.instance.service.createTree();
    const getScoped = await call(studio.url(`/api/trees/${encodeURIComponent(tree.id)}/search`), "GET");
    assert.equal(getScoped.status, 405);
    const getGlobal = await call(studio.url("/api/search"), "GET");
    assert.equal(getGlobal.status, 405);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }

  /* 未装配（search 不注入）→ 503 search-not-wired（503 先于方法/树校验）。 */
  const bareDir = makeTempDataDir();
  const bareRunning: RunningStudio[] = [];
  try {
    const bare = await startStudio(bareDir, bareRunning, false);
    const unwiredScoped = await call(bare.url("/api/trees/any-tree/search"), "POST", { text: "任意" });
    assert.equal(unwiredScoped.status, 503);
    assert.equal(unwiredScoped.body.error.code, "search-not-wired");
    const unwiredGlobal = await call(bare.url("/api/search"), "POST", { text: "任意" });
    assert.equal(unwiredGlobal.status, 503);
    assert.equal(unwiredGlobal.body.error.code, "search-not-wired");
  } finally {
    await closeAll(bareRunning);
    cleanupDir(bareDir);
  }
});
