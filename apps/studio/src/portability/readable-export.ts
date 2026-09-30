/**
 * D4-5 可读导出 —— 人类可读 Markdown 渲染（charter §1 路径 6 / 契约 §5
 * `export --readable`）。
 *
 * 纯函数：facts 快照（ExportService.readFactsSnapshot 的冻结形状）→
 * `readable/` 下的 Markdown 文件集。无 runtime 依赖、无 IO、无时钟——
 * 同一快照 → 逐字节相同输出（进 manifest 校验，恢复端按普通条目验证）。
 *
 * 文件面：
 *  - `readable/README.md`：包内索引（各事实类行数 + 树/材料文件清单）；
 *  - `readable/materials/<materialId>.md`：材料元信息（版本链、解析状态、
 *    原件 hash、阅读位置、来源锚点引用）+ ready 版本规范文本全文；
 *  - `readable/trees/<treeId>.md`：树的分支/回合（user/assistant/return）、
 *    来源（Turn 来源 / 材料来源）、Return 采用记录、术语批注。
 */

import type { FactsFileShape } from "./package-format.ts";

export interface ReadableRenderInput {
  /** ExportService.readFactsSnapshot 的输出（表名 → {table, columns, rows}）。 */
  readonly facts: ReadonlyMap<string, FactsFileShape>;
  /** 内容寻址原件（仅用于统计大小展示；正文取 material_versions.canonical_text）。 */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

export interface ReadableFile {
  /** 包内 POSIX 相对路径（readable/ 前缀）。 */
  readonly path: string;
  readonly content: string;
}

/* ------------------------------------------------------------------ */
/* 行访问辅助（facts 快照 → 命名访问）                                   */
/* ------------------------------------------------------------------ */

interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  at(rowIndex: number): Row;
}

interface Row {
  get(column: string): string | number | null;
  str(column: string): string;
  strOrNull(column: string): string | null;
  intOrNull(column: string): number | null;
}

function tableOf(input: ReadableRenderInput, name: string): Table {
  const shape = input.facts.get(name);
  if (shape === undefined) {
    throw new Error(`readable export: facts snapshot is missing table '${name}'`);
  }
  const index = new Map(shape.columns.map((column, i) => [column, i]));
  return {
    columns: shape.columns,
    rows: shape.rows,
    at(rowIndex: number): Row {
      const row = shape.rows[rowIndex];
      if (row === undefined) throw new Error(`readable export: ${name} row ${rowIndex} out of range`);
      return {
        get(column: string): string | number | null {
          const i = index.get(column);
          if (i === undefined) throw new Error(`readable export: ${name} has no column '${column}'`);
          return row[i] ?? null;
        },
        str(column: string): string {
          const value = this.get(column);
          return typeof value === "string" ? value : String(value ?? "");
        },
        strOrNull(column: string): string | null {
          const value = this.get(column);
          return typeof value === "string" ? value : null;
        },
        intOrNull(column: string): number | null {
          const value = this.get(column);
          return typeof value === "number" ? value : null;
        },
      };
    },
  };
}

/** 多行文本按行前缀缩进（回合/解释正文的忠实呈现）。 */
function indentBlock(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 渲染全部可读文件（确定性顺序：README → materials → trees）。 */
export function renderReadableFiles(input: ReadableRenderInput): readonly ReadableFile[] {
  const forests = tableOf(input, "forests");
  const trees = tableOf(input, "trees");
  const branches = tableOf(input, "branches");
  const episodes = tableOf(input, "episodes");
  const runs = tableOf(input, "runs");
  const sessionReferences = tableOf(input, "session_references");
  const turns = tableOf(input, "turns");
  const branchOrigins = tableOf(input, "branch_origins");
  const activeNavigation = tableOf(input, "tree_active_navigation");
  const adoptionAttempts = tableOf(input, "return_adoption_attempts");
  const annotations = tableOf(input, "terminology_annotations");
  const dispatches = tableOf(input, "terminology_promotion_dispatches");
  const terminologyState = tableOf(input, "terminology_state");
  const materials = tableOf(input, "materials");
  const materialVersions = tableOf(input, "material_versions");
  const treeMaterialLinks = tableOf(input, "tree_material_links");
  const materialOrigins = tableOf(input, "material_branch_origins");
  const readingState = tableOf(input, "tree_material_reading_state");
  const firstQuestions = tableOf(input, "material_first_questions");

  const files: ReadableFile[] = [];

  /* ---------------- README.md（索引） ---------------- */

  const treeRows = Array.from({ length: trees.rows.length }, (_, i) => trees.at(i));
  const materialRows = Array.from({ length: materials.rows.length }, (_, i) => materials.at(i));
  const readmeLines: string[] = [
    "# TreeAI readable export",
    "",
    "Generated from the exported product facts (deterministic; same database renders byte-identical).",
    "This directory is for human reading — the authoritative restore source is the package manifest + facts.",
    "",
    "## Fact counts",
    "",
    "| category | rows |",
    "| --- | --- |",
    `| forests | ${forests.rows.length} |`,
    `| trees | ${trees.rows.length} |`,
    `| branches | ${branches.rows.length} |`,
    `| episodes | ${episodes.rows.length} |`,
    `| runs | ${runs.rows.length} |`,
    `| session references | ${sessionReferences.rows.length} |`,
    `| turns (incl. returns) | ${turns.rows.length} |`,
    `| turn origins | ${branchOrigins.rows.length} |`,
    `| material branch origins | ${materialOrigins.rows.length} |`,
    `| materials | ${materials.rows.length} |`,
    `| material versions | ${materialVersions.rows.length} |`,
    `| material blobs | ${input.blobs.size} |`,
    `| return adoption attempts | ${adoptionAttempts.rows.length} |`,
    `| terminology annotations | ${annotations.rows.length} |`,
    `| terminology dispatches | ${dispatches.rows.length} |`,
    `| terminology state keys | ${terminologyState.rows.length} |`,
    `| material first questions | ${firstQuestions.rows.length} |`,
    "",
    "## Trees",
    "",
  ];
  for (const tree of treeRows) {
    readmeLines.push(`- [${tree.str("id")}](trees/${tree.str("id")}.md) — created ${tree.str("created_at")}`);
  }
  readmeLines.push("", "## Materials", "");
  for (const material of materialRows) {
    readmeLines.push(`- [${material.str("title")} (${material.str("material_id")})](materials/${material.str("material_id")}.md)`);
  }
  readmeLines.push("");
  files.push({ path: "readable/README.md", content: readmeLines.join("\n") });

  /* ---------------- materials/<id>.md ---------------- */

  for (const material of materialRows) {
    const materialId = material.str("material_id");
    const lines: string[] = [
      `# ${material.str("title")}`,
      "",
      `- Material: \`${materialId}\``,
      `- Created: ${material.str("created_at")}`,
      "",
      "## Versions",
      "",
    ];
    const versionRows = Array.from({ length: materialVersions.rows.length }, (_, i) => materialVersions.at(i))
      .filter((version) => version.str("material_id") === materialId);
    versionRows.forEach((version, index) => {
      lines.push(
        `### v${index + 1} — ${version.str("parse_status")}` +
          `${version.strOrNull("parse_error") === null ? "" : ` (${version.strOrNull("parse_error")})`}`,
      );
      lines.push("");
      lines.push(`- Version: \`${version.str("version_id")}\``);
      lines.push(`- Imported: ${version.str("imported_at")}`);
      lines.push(`- Parser: ${version.str("parser_kind")} ${version.str("parser_version")}`);
      lines.push(`- Original bytes: ${version.str("size_bytes")} (sha256 \`${version.str("content_hash")}\`)`);
      lines.push(`- Canonical text: ${version.str("text_units")} UTF-16 units`);
      lines.push("");
    });

    const linkedTrees = Array.from({ length: treeMaterialLinks.rows.length }, (_, i) => treeMaterialLinks.at(i))
      .filter((link) => link.str("material_id") === materialId);
    if (linkedTrees.length > 0) {
      lines.push("## Linked trees", "");
      for (const link of linkedTrees) {
        lines.push(`- ${link.str("tree_id")} (linked ${link.str("linked_at")})`);
      }
      lines.push("");
    }

    const positions = Array.from({ length: readingState.rows.length }, (_, i) => readingState.at(i))
      .filter((state) => state.str("material_id") === materialId);
    if (positions.length > 0) {
      lines.push("## Reading positions", "");
      for (const position of positions) {
        lines.push(
          `- Tree ${position.str("tree_id")}: version \`${position.str("version_id")}\`` +
            `, block ${position.strOrNull("block_id") ?? "—"}${position.intOrNull("focus_start") === null ? "" : `, focus ${position.intOrNull("focus_start")}`} (updated ${position.str("updated_at")})`,
        );
      }
      lines.push("");
    }

    const originsForMaterial = Array.from({ length: materialOrigins.rows.length }, (_, i) => materialOrigins.at(i))
      .filter((origin) => origin.str("material_id") === materialId);
    if (originsForMaterial.length > 0) {
      lines.push("## Branches anchored in this material", "");
      for (const origin of originsForMaterial) {
        lines.push(
          `- Branch \`${origin.str("branch_id")}\` (tree ${origin.str("tree_id")}) at version ` +
            `\`${origin.str("version_id")}\` block ${origin.str("block_id")} ` +
            `[${origin.str("start")}, ${origin.str("end")}) — excerpt:`,
        );
        lines.push(indentBlock(origin.str("excerpt"), "    "));
        lines.push("");
      }
    }

    for (let index = 0; index < versionRows.length; index += 1) {
      const version = versionRows[index]!;
      if (version.str("parse_status") !== "ready") continue;
      lines.push(`## Text of v${index + 1} (\`${version.str("version_id")}\`)`, "");
      lines.push(version.str("canonical_text"));
      lines.push("");
    }
    files.push({ path: `readable/materials/${materialId}.md`, content: lines.join("\n") });
  }

  /* ---------------- trees/<id>.md ---------------- */

  for (const tree of treeRows) {
    const treeId = tree.str("id");
    const lines: string[] = [
      `# Tree ${treeId}`,
      "",
      `- Tree: \`${treeId}\` (forest \`${tree.str("forest_id")}\`)`,
      `- Created: ${tree.str("created_at")}`,
      "",
    ];
    const treeBranches = Array.from({ length: branches.rows.length }, (_, i) => branches.at(i))
      .filter((branch) => branch.str("tree_id") === treeId);
    for (const branch of treeBranches) {
      const branchId = branch.str("id");
      const parent = branch.strOrNull("parent_branch_id");
      lines.push(`## Branch \`${branchId}\`${parent === null ? " (root)" : ` (parent \`${parent}\`)`}`);
      lines.push("");

      /* 来源（每枝至多一条：Turn 来源或材料来源）。 */
      const turnOrigin = Array.from({ length: branchOrigins.rows.length }, (_, i) => branchOrigins.at(i))
        .find((origin) => origin.str("branch_id") === branchId);
      const materialOrigin = Array.from({ length: materialOrigins.rows.length }, (_, i) => materialOrigins.at(i))
        .find((origin) => origin.str("branch_id") === branchId);
      if (turnOrigin !== undefined) {
        lines.push(`- Origin (turn): from branch \`${turnOrigin.str("source_branch_id")}\``);
        lines.push(
          `  anchored at turn \`${turnOrigin.str("anchor_turn_id")}\` (Pi entry \`${turnOrigin.str("anchor_entry_id")}\`)` +
            ` [${turnOrigin.str("sel_start")}, ${turnOrigin.str("sel_end")}) — excerpt:`,
        );
        lines.push(indentBlock(turnOrigin.str("sel_text"), "    "));
      } else if (materialOrigin !== undefined) {
        lines.push(`- Origin (material): material \`${materialOrigin.str("material_id")}\``);
        lines.push(
          `  version \`${materialOrigin.str("version_id")}\` block ${materialOrigin.str("block_id")} ` +
            `[${materialOrigin.str("start")}, ${materialOrigin.str("end")}) — excerpt:`,
        );
        lines.push(indentBlock(materialOrigin.str("excerpt"), "    "));
      }
      lines.push("");

      /* 回合（user/assistant/return 按保存序）。 */
      const branchTurns = Array.from({ length: turns.rows.length }, (_, i) => turns.at(i))
        .filter((turn) => turn.str("branch_id") === branchId);
      if (branchTurns.length > 0) {
        lines.push("### Turns", "");
        for (const turn of branchTurns) {
          const role = turn.str("role");
          const runNote =
            role === "return"
              ? `from branch \`${turn.strOrNull("from_branch_id") ?? "—"}\`` +
                `, idempotency key \`${turn.strOrNull("idempotency_key") ?? "—"}\`` +
                (turn.strOrNull("delivered_run_id") === null
                  ? ", not yet adopted"
                  : `, adopted by run \`${turn.strOrNull("delivered_run_id")}\``)
              : `run \`${turn.strOrNull("run_id") ?? "—"}\`` +
                (turn.strOrNull("pi_entry_id") === null ? "" : `, Pi entry \`${turn.strOrNull("pi_entry_id")}\``);
          lines.push(`- **${role}** \`${turn.str("id")}\` (${runNote}) — ${turn.str("created_at")}`);
          lines.push("");
          lines.push(indentBlock(turn.str("text")));
          lines.push("");
        }
      }

      /* Return 采用尝试。 */
      const attemptsForTree = Array.from({ length: adoptionAttempts.rows.length }, (_, i) => adoptionAttempts.at(i));
      const branchReturnIds = new Set(branchTurns.filter((turn) => turn.str("role") === "return").map((turn) => turn.str("id")));
      const branchAttempts = attemptsForTree.filter((attempt) => branchReturnIds.has(attempt.str("return_turn_id")));
      if (branchAttempts.length > 0) {
        lines.push("### Return adoption attempts", "");
        for (const attempt of branchAttempts) {
          lines.push(`- Return \`${attempt.str("return_turn_id")}\` → run \`${attempt.str("run_id")}\` at ${attempt.str("attempted_at")}`);
        }
        lines.push("");
      }

      /* 术语批注（按枝）。 */
      const branchAnnotations = Array.from({ length: annotations.rows.length }, (_, i) => annotations.at(i))
        .filter((annotation) => annotation.str("branch_id") === branchId);
      if (branchAnnotations.length > 0) {
        lines.push("### Terminology annotations", "");
        for (const annotation of branchAnnotations) {
          lines.push(
            `- **${annotation.str("term")}** (\`${annotation.str("id")}\`, mode ${annotation.str("mode")}, ` +
              `anchor turn \`${annotation.str("anchor_turn_id")}\` [${annotation.str("sel_start")}, ${annotation.str("sel_end")})` +
              (annotation.strOrNull("promoted_branch_id") === null
                ? ""
                : `, promoted to branch \`${annotation.strOrNull("promoted_branch_id")}\``) +
              ")",
          );
          lines.push("");
          lines.push(indentBlock(annotation.str("explanation")));
          lines.push("");
        }
      }

      /* 运行（episode/run + session 可用性——缺 session 时如实呈现）。 */
      const branchEpisodes = Array.from({ length: episodes.rows.length }, (_, i) => episodes.at(i))
        .filter((episode) => episode.str("branch_id") === branchId);
      if (branchEpisodes.length > 0) {
        lines.push("### Runs", "");
        for (const episode of branchEpisodes) {
          const episodeRuns = Array.from({ length: runs.rows.length }, (_, i) => runs.at(i))
            .filter((run) => run.str("episode_id") === episode.str("id"));
          for (const run of episodeRuns) {
            const reference = Array.from({ length: sessionReferences.rows.length }, (_, i) => sessionReferences.at(i))
              .find((row) => row.str("run_id") === run.str("id"));
            const availability =
              reference === undefined
                ? "no session reference"
                : `${reference.str("availability_status")}${reference.strOrNull("availability_reason") === null ? "" : ` (${reference.strOrNull("availability_reason")})`}`;
            lines.push(
              `- Run \`${run.str("id")}\` (episode \`${episode.str("id")}\`): ${run.str("state")}` +
                (run.strOrNull("terminal_state") === null ? "" : ` → ${run.strOrNull("terminal_state")}`) +
                `, session ${availability}` +
                (run.strOrNull("failure_json") === null ? "" : `, failure: ${run.strOrNull("failure_json")}`),
            );
          }
        }
        lines.push("");
      }
    }

    /* 首问幂等记录（树内材料首问）。 */
    const treeFirstQuestions = Array.from({ length: firstQuestions.rows.length }, (_, i) => firstQuestions.at(i))
      .filter((question) => question.str("tree_id") === treeId);
    if (treeFirstQuestions.length > 0) {
      lines.push("## Material first questions (idempotency ledger)", "");
      for (const question of treeFirstQuestions) {
        lines.push(
          `- key \`${question.str("intent_key")}\` → branch \`${question.str("branch_id")}\` (${question.str("created_at")})`,
        );
      }
      lines.push("");
    }

    /* 活动导航（session 缺失时如实标注 unavailable）。 */
    const navigation = Array.from({ length: activeNavigation.rows.length }, (_, i) => activeNavigation.at(i)).find(
      (row) => row.str("tree_id") === treeId,
    );
    if (navigation !== undefined) {
      lines.push("## Active navigation", "");
      lines.push(`- Branch \`${navigation.str("branch_id")}\` (updated ${navigation.str("updated_at")})`);
      lines.push(
        `- Session ${navigation.str("session_id")} @ entry \`${navigation.str("entry_id")}\`: ` +
          `${navigation.str("availability_status")}` +
          (navigation.strOrNull("availability_reason") === null
            ? ""
            : ` (${navigation.strOrNull("availability_reason")})`) +
          " — a missing session never blocks reading; continue via an explicit new exploration",
      );
      lines.push("");
    }

    files.push({ path: `readable/trees/${treeId}.md`, content: lines.join("\n") });
  }

  return files;
}
