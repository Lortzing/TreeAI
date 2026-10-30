import { createHash } from "node:crypto";
import type { BranchId, TreeId, TurnId, UiGenerationContext, UiGenerationTask, ComparisonArtifact, UiGenerationState } from "@treeai/contracts";
import type { TreeDomainContext } from "./context.ts";
import { EntityNotFoundError, InvalidArgumentError } from "../errors.ts";
import { validateUiContext, validateComparisonArtifact } from "../generative-ui-validation.ts";

import { validateUiOwnership } from "../generative-ui-integrity.ts";

type Row = Record<string, string | number | null>;
export interface CreateUiTaskInput {
  treeId: TreeId; branchId: BranchId; anchorTurnId: TurnId; intentId: string;
  context: UiGenerationContext; model: string; reservedChars: number; dailyBudgetChars: number;
}
export class TreeGenerativeUiRepository {
  private readonly ctx: TreeDomainContext;
  constructor(ctx: TreeDomainContext) { this.ctx = ctx; }
  #decode(r: Row): UiGenerationTask {
    const context = validateUiContext(JSON.parse(String(r.context_json)));
    const artifact = r.artifact_json === null ? null : validateComparisonArtifact(JSON.parse(String(r.artifact_json)), context);
    return { id: String(r.id), treeId: r.tree_id as TreeId, branchId: r.branch_id as BranchId, anchorTurnId: r.anchor_turn_id as TurnId,
      intentId: String(r.intent_id), revision: Number(r.revision), contextHash: String(r.context_hash), context, model: String(r.model),
      state: r.state as UiGenerationState, artifact, error: r.error as string | null,
      reservedChars: Number(r.reserved_chars), chargedChars: Number(r.charged_chars), costUnknown: r.cost_unknown === 1,
      createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  get(treeId: TreeId, id: string): UiGenerationTask {
    const row = this.ctx.database().prepare("SELECT * FROM generative_ui_tasks WHERE tree_id=? AND id=?").get(treeId, id) as Row | undefined;
    if (!row) throw new EntityNotFoundError("UI generation task", id);
    return this.#decode(row);
  }
  findIntent(treeId: TreeId, intentId: string): UiGenerationTask | null {
    const row = this.ctx.database().prepare("SELECT * FROM generative_ui_tasks WHERE tree_id=? AND intent_id=?").get(treeId, intentId) as Row | undefined;
    return row ? this.#decode(row) : null;
  }
  list(treeId: TreeId, anchorTurnId: TurnId): UiGenerationTask[] {
    return (this.ctx.database().prepare("SELECT * FROM generative_ui_tasks WHERE tree_id=? AND anchor_turn_id=? ORDER BY revision DESC").all(treeId, anchorTurnId) as Row[]).map(r => this.#decode(r));
  }
  usage(day = this.ctx.now().slice(0, 10)): number {
    const row = this.ctx.database().prepare("SELECT COALESCE(SUM(CASE WHEN state IN ('queued','running') THEN reserved_chars ELSE charged_chars END),0) AS n FROM generative_ui_tasks WHERE substr(created_at,1,10)=?").get(day) as { n: number };
    return row.n;
  }
  create(input: CreateUiTaskInput): UiGenerationTask {
    return this.ctx.repository.transaction(() => {
      const context = validateUiContext(input.context);
      const encoded = JSON.stringify(context);
      const hash = createHash("sha256").update(encoded).digest("hex");
      if (!input.intentId.trim() || input.intentId.length > 120 || input.model.length > 300) throw new InvalidArgumentError("生成请求身份无效。");
      const old = this.findIntent(input.treeId, input.intentId);
      if (old) {
        if (old.contextHash !== hash || old.anchorTurnId !== input.anchorTurnId || old.branchId !== input.branchId || old.model !== input.model) throw new InvalidArgumentError("同一生成请求已绑定其他内容，请使用新的请求。");
        return old;
      }
      const turn = this.ctx.repository.getTurn(input.anchorTurnId);
      const branch = this.ctx.repository.getBranch(input.branchId);
      if (turn.treeId !== input.treeId || turn.branchId !== branch.id || branch.treeId !== input.treeId || turn.role !== "assistant") throw new InvalidArgumentError("对比卡必须属于当前树的模型回答。");
      validateUiOwnership(this.ctx.database(), input.treeId, input.branchId, input.anchorTurnId, context);
      if (!Number.isSafeInteger(input.reservedChars) || input.reservedChars <= 0 || !Number.isSafeInteger(input.dailyBudgetChars) || input.dailyBudgetChars < 0) throw new InvalidArgumentError("生成额度配置无效。");
      if (this.usage() + input.reservedChars > input.dailyBudgetChars) throw new InvalidArgumentError("今日对比卡生成额度不足；已有卡片仍可阅读。");
      const pending = this.ctx.database().prepare("SELECT COUNT(*) AS n FROM generative_ui_tasks WHERE state IN ('queued','running')").get() as { n: number };
      if (pending.n >= 4) throw new InvalidArgumentError("对比卡任务队列已满，请稍后重试。");
      const revision = (this.list(input.treeId, input.anchorTurnId)[0]?.revision ?? 0) + 1;
      const id = this.ctx.newId("ui"); const now = this.ctx.now();
      this.ctx.database().prepare(`INSERT INTO generative_ui_tasks VALUES (?,?,?,?,?,?,?,?,?,'queued',NULL,NULL,?,0,0,?,?)`).run(
        id, input.treeId, input.branchId, input.anchorTurnId, input.intentId, revision, hash, encoded, input.model, input.reservedChars, now, now);
      return this.get(input.treeId, id);
    });
  }
  start(treeId: TreeId, id: string): boolean {
    return this.ctx.database().prepare("UPDATE generative_ui_tasks SET state='running',updated_at=? WHERE tree_id=? AND id=? AND state='queued'").run(this.ctx.now(), treeId, id).changes === 1;
  }
  settle(treeId: TreeId, id: string, state: "succeeded" | "failed" | "cancelled", artifact: ComparisonArtifact | null, error: string | null, chargedChars: number, unknown: boolean): UiGenerationTask {
    return this.ctx.repository.transaction(() => {
      const old = this.get(treeId, id);
      if (old.state !== "running" && old.state !== "queued") return old;
      if (artifact) validateComparisonArtifact(artifact, old.context);
      if (!Number.isSafeInteger(chargedChars) || chargedChars < 0) throw new InvalidArgumentError("生成用量无效。");
      this.ctx.database().prepare("UPDATE generative_ui_tasks SET state=?,artifact_json=?,error=?,charged_chars=?,cost_unknown=?,updated_at=? WHERE tree_id=? AND id=?").run(
        state, artifact === null ? null : JSON.stringify(artifact), error, chargedChars, unknown ? 1 : 0, this.ctx.now(), treeId, id);
      return this.get(treeId, id);
    });
  }
  recover(): void {
    this.ctx.database().prepare("UPDATE generative_ui_tasks SET charged_chars=CASE WHEN state='running' THEN reserved_chars ELSE 0 END,cost_unknown=CASE WHEN state='running' THEN 1 ELSE 0 END,state='interrupted',error='上次生成被中断；未自动重新派发。可显式重新生成。',updated_at=? WHERE state IN ('queued','running')").run(this.ctx.now());
  }
}
