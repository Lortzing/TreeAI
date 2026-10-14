/** catalog SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";

import type {
  CreateMaterialInput,
  MaterialRow,
  TreeMaterialLink,
} from "./model.ts";
import {
  MATERIAL_COLUMNS,
} from "./policy.ts";
import {
  rowToMaterial,
} from "./serialization.ts";
import {
  assertNonEmptyString,
  sha256Hex,
} from "./validation.ts";
import type {
  IsoTimestamp,
  Material,
  MaterialId,
  TreeId,
} from "@treeai/contracts";


import type {
  MaterialDomainContext,
} from "./context.ts";

export class MaterialCatalogRepository {
  readonly #context: MaterialDomainContext;
  constructor(context: MaterialDomainContext) { this.#context = context; }


  /* ------------------------------ 材料 ------------------------------ */

  createMaterial(input: CreateMaterialInput): Material {
    this.#context.assertOpen();
    assertNonEmptyString(input.title, "material title");
    const id = input.id ?? (this.#context.newId("material") as MaterialId);
    assertNonEmptyString(id, "material id");
    const createdAt = this.#context.now();
    try {
      this.#context.database()!
        .prepare("INSERT INTO materials (material_id, title, created_at) VALUES (?, ?, ?)")
        .run(id, input.title, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating material");
    }
    return { id, title: input.title, createdAt };
  }


  /** 全部材料（追加序 created_at, rowid）。 */
  listMaterials(): Material[] {
    this.#context.assertOpen();
    const rows = this.#context.database()!
      .prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials ORDER BY created_at, rowid`)
      .all() as unknown as MaterialRow[];
    return rows.map(rowToMaterial);
  }


  /** 树内已链接材料（链接序 linked_at, rowid）。 */
  listTreeMaterials(treeId: TreeId): Material[] {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT m.material_id, m.title, m.created_at
         FROM materials m
         JOIN tree_material_links l ON l.material_id = m.material_id
         WHERE l.tree_id = ?
         ORDER BY l.linked_at, l.rowid`,
      )
      .all(treeId) as unknown as MaterialRow[];
    return rows.map(rowToMaterial);
  }


  /** 树存在性探针（导入服务在写入前校验树作用域用；不读取树内容）。 */
  hasTree(treeId: TreeId): boolean {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    return this.#context.findTreeRow(treeId) !== undefined;
  }


  /* ------------------------------ 原件（内容寻址） ------------------------------ */

  /**
   * 内容寻址入库：content_hash = 原件字节 SHA-256；同字节全局一份
   * （冲突即已存在，原样保留——不重写、不报错）。返回 content_hash。
   */
  storeBlob(bytes: Uint8Array): string {
    this.#context.assertOpen();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new InvalidArgumentError("material bytes must be a non-empty Uint8Array");
    }
    const contentHash = sha256Hex(bytes);
    try {
      this.#context.database()!
        .prepare("INSERT INTO material_blobs (content_hash, bytes) VALUES (?, ?) ON CONFLICT(content_hash) DO NOTHING")
        .run(contentHash, bytes);
    } catch (error) {
      throw mapSqliteError(error, "storing material blob");
    }
    return contentHash;
  }


  /* ------------------------------ 树链接 ------------------------------ */

  /**
   * 链接材料到树（一树多材料、一材料多树）。幂等：已链接时返回既有
   * 链接（linked_at 保留首次链接时刻，不重写）。
   */
  linkTreeMaterial(treeId: TreeId, materialId: MaterialId): TreeMaterialLink {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    if (this.#context.findTreeRow(treeId) === undefined) throw new EntityNotFoundError("tree", treeId);
    if (this.#context.findMaterialRow(materialId) === undefined) throw new EntityNotFoundError("material", materialId);
    const linkedAt = this.#context.now();
    return this.#context.repository.transaction((): TreeMaterialLink => {
      const db = this.#context.database()!;
      try {
        db.prepare(
          "INSERT INTO tree_material_links (tree_id, material_id, linked_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(tree_id, material_id) DO NOTHING",
        ).run(treeId, materialId, linkedAt);
      } catch (error) {
        throw mapSqliteError(error, "linking material to tree");
      }
      const row = db
        .prepare("SELECT tree_id, material_id, linked_at FROM tree_material_links WHERE tree_id = ? AND material_id = ?")
        .get(treeId, materialId) as { tree_id: string; material_id: string; linked_at: string } | undefined;
      if (row === undefined) {
        throw new DatabaseCorruptError(
          `tree material link (${treeId}, ${materialId}) not readable after upsert (schema integrity violation)`,
        );
      }
      return {
        treeId: row.tree_id as TreeId,
        materialId: row.material_id as MaterialId,
        linkedAt: row.linked_at as IsoTimestamp,
      };
    });
  }


  /**
   * 解除树与材料的链接。返回是否确实删除了链接行（false = 本未链接）。
   * 只删链接行：材料、版本、来源锚点与阅读状态均为产品事实，不受影响。
   */
  unlinkTreeMaterial(treeId: TreeId, materialId: MaterialId): boolean {
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    try {
      const result = this.#context.database()!
        .prepare("DELETE FROM tree_material_links WHERE tree_id = ? AND material_id = ?")
        .run(treeId, materialId);
      return Number(result.changes) > 0;
    } catch (error) {
      throw mapSqliteError(error, "unlinking material from tree");
    }
  }
}
