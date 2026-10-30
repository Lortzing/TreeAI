import type { BranchId, RunId, TreeId } from "@treeai/contracts";
import { InvalidArgumentError } from "../errors.ts";
import type { TreeDomainContext } from "./context.ts";

export interface PromptRequestRecord {
  readonly treeId: TreeId;
  readonly requestKey: string;
  readonly branchId: BranchId;
  readonly payloadHash: string;
  readonly runId: RunId | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

export function assertPromptRequestKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "" || key.length > 200) {
    throw new InvalidArgumentError("requestKey must be a non-empty string of at most 200 characters");
  }
}

export class TreePromptRequestsRepository {
  readonly #context: TreeDomainContext;
  constructor(context: TreeDomainContext) { this.#context = context; }

  find(treeId: TreeId, key: string): PromptRequestRecord | null {
    assertPromptRequestKey(key);
    const row = this.#context.database().prepare(`SELECT tree_id AS treeId, request_key AS requestKey,
      branch_id AS branchId, payload_hash AS payloadHash, run_id AS runId,
      failure_code AS failureCode, failure_message AS failureMessage
      FROM prompt_requests WHERE tree_id = ? AND request_key = ?`).get(treeId, key);
    return row ? row as unknown as PromptRequestRecord : null;
  }

  create(treeId: TreeId, key: string, branchId: BranchId, hash: string): void {
    assertPromptRequestKey(key);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new InvalidArgumentError("invalid prompt payload hash");
    this.#context.database().prepare(`INSERT INTO prompt_requests
      (tree_id, request_key, branch_id, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(treeId, key, branchId, hash, this.#context.now());
  }

  bind(treeId: TreeId, key: string, runId: RunId): void {
    const result = this.#context.database().prepare(`UPDATE prompt_requests SET run_id = ?
      WHERE tree_id = ? AND request_key = ? AND run_id IS NULL AND failure_code IS NULL`).run(runId, treeId, key);
    if (result.changes !== 1) throw new InvalidArgumentError("prompt request is already settled or bound");
  }

  failBeforeRun(treeId: TreeId, key: string, code: string, message: string): void {
    this.#context.database().prepare(`UPDATE prompt_requests SET failure_code = ?, failure_message = ?
      WHERE tree_id = ? AND request_key = ? AND run_id IS NULL AND failure_code IS NULL`)
      .run(code, message, treeId, key);
  }

  recoverInterrupted(): void {
    this.#context.database().prepare(`UPDATE prompt_requests SET failure_code = 'unknown',
      failure_message = '宿主已中断，本次请求未完成；请核对后重新发送。'
      WHERE run_id IS NULL AND failure_code IS NULL`).run();
  }
}
