# evidence/d2/ — D2 证据区（追加式）

- 区域维护：Integrator（目录与规则）；`evidence/d2/runs/**` 的验收运行产物由 Agent F 的 `scripts/verify-d2` 写入。
- 依据：`TreeAI_D2_Agent执行任务书.md` §5（Agent F 证据要求）。

## 规则

1. **只追加，不覆盖**：禁止删除或改写任何历史 run；失败与 BLOCKED 的记录同样保留。
2. **验收运行布局**（Agent F 的 verify-d2 产出）：

   ```text
   evidence/d2/runs/<UTC-run-id>/
   ├── environment.json
   ├── result.json
   ├── events.jsonl
   ├── checks.json
   └── logs/
   ```

3. **秘密扫描**：任何日志写盘前和写盘后均须扫描；发现泄露按验收器规则处理，原始记录不删除。
4. **d1-spikes 只读**：D1 证据区不因 D2 验收被修改；D1 回归通过 `./d1-spikes/scripts/verify-d1 --repro` 原样执行（版本升级门禁）。
5. 当前状态：Gate 0。本目录尚无 verify 运行；Integrator 的 Gate 0 脚手架验证记录见 `gate-0/`（手写记录，非 verify-d2 运行产物）。
