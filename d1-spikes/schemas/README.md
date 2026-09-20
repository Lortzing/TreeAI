TreeAI D1 共享 JSON Schema 与证据契约
======================================
所有者：Agent D（d1-spikes/schemas/ 为 Agent D 独占写入目录）
适用读者：Agent B（sdk-node）、Agent C（rpc-python）、Agent D（验收）

一、两个 Schema
  evidence-event.schema.json   原始事件（events.jsonl 中每行一个 JSON 对象）
  scenario-result.schema.json  场景结果（每个场景一个 result.json）

二、证据文件布局（verify-d1 按此查找）
  方案一（扁平布局，Agent C 采用）：
    d1-spikes/evidence/rpc/<scenario>.result.json     Agent C 产出
    d1-spikes/evidence/rpc/<scenario>.events.jsonl    Agent C 产出
  方案二（追加式 runs 布局，Agent B 采用，2026-09-18 交付）：
    d1-spikes/evidence/sdk/runs/<run-id>/<scenario>/result.json
    d1-spikes/evidence/sdk/runs/<run-id>/<scenario>/events.jsonl
    d1-spikes/evidence/sdk/runs/<run-id>/environment.json、run-summary.json
    （每次真实运行新建 run 目录，证据只追加，不改写历史 run）
  <scenario> ∈ {basic, tool, steer, abort, resume}
  verify-d1 解析规则（严格，不跨 run 拼接）：
    1. 某场景若在扁平布局存在 <scenario>.result.json，以扁平文件为准；
    2. 否则使用 runs/ 下"最新的完整 run"（五个场景的 result.json 齐备才算
       完整）中该场景的 result.json；所有 run 内结果引用的 evidenceFiles
       必须仍位于同一 run 目录，跨 run 引用判 FAIL；
    3. runs/ 存在但没有任何完整 run，且该场景也无扁平文件时，按交付不
       完整记 FAIL（并列出最新 run 缺失的场景）；
    4. 实现目录（sdk-node/ 或 rpc-python/）尚不存在时，对应场景记
       NOT_RUN；实现目录已存在但结果文件缺失时记 FAIL（交付不完整）。
  两种情况都会使 scripts/verify-d1 以非零退出码结束，不会伪造通过。

三、事件文件（events.jsonl）要求
  1. 每行一个 JSON 对象，符合 evidence-event.schema.json 的全部必填字段。
  2. seq 从 1 开始、在单个文件内严格递增（verify-d1 逐行校验）。
  3. 每行的 implementation、scenario 字段必须与文件所在目录和文件名一致。
  4. payload 必须先脱敏再落盘：删除密钥、Authorization/Bearer 头、绝对用户
     主目录路径（形如 /Users/<name>/... 或 /home/<name>/...）与非测试正文。
  5. 场景失败时，最后一个事件必须携带结构化 error 对象（不得静默丢弃）。
  6. 先写临时文件，场景结束后原子 rename 为正式文件。
  7. redactionVersion 当前为 "d1-v1"；脱敏规则如需变更，先与 Agent D 协调
     递增版本号，不得悄悄改动语义。

四、结果文件（result.json）要求
  1. 符合 scenario-result.schema.json；状态只用 PASS/FAIL/BLOCKED/NOT_RUN。
  2. 任务书中的 BLOCKED_CREDENTIALS 有两种等价编码（schema 修订
     2026-09-18，Agent D）：顶层 blockedReason="CREDENTIALS"（schema 原生
     编码），或 error.blockedReason="BLOCKED_CREDENTIALS"（任务书第 14 节
     字面编码，sdk-node 交付证据实际采用）。两者至少具备其一，取值枚举
     同 scenario-result.schema.json。本次修订是公开的契约变更（本节 +
     schema description 同步记录），不是静默放宽；此前的编码仍然有效。
  3. PASS 由 schema 强制：exitCode=0、command 非空、startedAt/endedAt 为
     真实 RFC3339 时间戳、evidenceFiles 至少 1 条。
  4. FAIL 由 schema 强制：exitCode 为非零整数、error 非 null。
  4a. 可信退出码保留（schema 修订 2026-09-20，Agent D）：exit 0 仅保留给
     PASS。FAIL 与 BLOCKED 必须携带非零整数 exitCode（BLOCKED 表示尝试
     已执行并被阻塞，进程已终止，退出码必须存在且非零）；NOT_RUN 不得
     声明 exitCode=0（未执行任何命令时 null 可接受）。全部历史 BLOCKED
     证据（2026-09-18 与 2026-09-20 各 run）实际 exitCode 均为 2，本次
     收紧不使任何已交付证据失效。scripts/verify-d1 的 check_exit_codes
     独立强制同一规则（纵深防御：即使结果文件 schema 校验失败，其
     status/exitCode 组合仍会被退出码检查覆盖）。公开修订，非静默变更。
  5. evidenceFiles 路径相对 d1-spikes/ 根目录书写，
     例如 "evidence/sdk/basic.events.jsonl" 或
     "evidence/sdk/runs/<run-id>/basic/events.jsonl"（verify-d1 按此解析
     存在性，并会校验其中的 .jsonl 事件文件；run 内结果不得引用其他 run
     的文件）。
  6. command 字段必须可被第三方原样重放：相对路径、无秘密、无交互输入。

五、environment.json（建议键，尚无强制 schema）
  {"piVersion": "...", "model": "...", "thinking": {...}, "node": "...",
   "python": "...", "packageManager": "...", "generatedAt": "..."}
  注意：该文件位于 evidence/ 根目录，不在任何 Agent 的独占写入范围内，
  归属需负责人澄清（已登记 reports/blockers.md 的 DELIVERY-004）。
  澄清前，B/C 可将各自环境信息写入自己 result.json 的 observations。

六、本地自检命令（均在仓库根目录执行）
  d1-spikes/scripts/schema-check d1-spikes/schemas/evidence-event.schema.json <file>...
  d1-spikes/scripts/check-secrets d1-spikes            # 秘密/脱敏扫描
  d1-spikes/scripts/make-run-dir                        # 生成 fixtures 临时副本
  d1-spikes/scripts/verify-d1                           # 统一验收（退出码见 --help）

七、公平对照要求（任务书第 5 节）
  同一 Pi 精确版本（禁止 latest / * / 未记录范围）、同一模型与 thinking
  配置、同一提示词、同一 fixture（一律通过 scripts/make-run-dir 生成的
  临时副本）、同一超时设置。场景判定标准见 fixtures/README.txt 第四节。
