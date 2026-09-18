# TreeAI D1 — RPC-Python 探针（Agent C）

一次性（可删除）的 Python spike：把 `pi --mode rpc` 作为子进程驱动，
验证 Pi RPC 协议在五个统一场景（basic / tool / steer / abort / resume）下
的可观测性、进程生命周期与失败路径。**这不是正式 Python 后端**：没有
通用 RuntimeAdapter、没有服务层、没有对 Pi 源码的 fork 或修改。

- 实现标识（证据中 `implementation` 字段）：`rpc-python`
- 独占写入范围：`d1-spikes/rpc-python/`、`d1-spikes/evidence/rpc/`
- 语言/依赖：纯 CPython 标准库（零第三方运行时依赖）
- 参考解释器：CPython 3.12.14（uv 0.12.13 管理，`.python-version` 锁定）；
  兼容系统 CPython 3.9.6（两套解释器均通过全部 59 个测试）
- Pi CLI：`@earendil-works/pi-coding-agent` 0.85.1（全局安装，Node 24），
  本机实测可用 provider `tal-token-plan-06c64a09`（model
  `deepseek-v4.1-flash`），thinking off。**环境观察**：另一个本地
  provider `tal-token-plan-copy-copy` 通过 `pi auth check` 且 print
  模式可用，但在 `--mode rpc` 下对所有模型一律 403（证据：
  `evidence/rpc/observation-copycopy-403.json`）。**Agent B 对齐状态**
  （2026-09-18 复核，见 `environment-rpc-python.json` 的
  `agentBAlignment`）：sdk-node 已交付，其锁定的 pi 依赖与本探针的
  pi CLI 均为 **0.85.1**（Node v24.21.0、thinking off 亦一致）；
  但 sdk-node 以 pi 默认 provider（copy-copy）运行，五个场景全部
  因同一 403 BLOCKED —— 与本探针记录的 provider 403 是同一现象。
  因此 pi 版本已对齐，**可用 provider/model 基线仍未对齐**，
  属 PENDING_OWNER（见下文“需要负责人决定的事项”）。

---

## 1. 目录结构

```
rpc-python/
  probe.py                    入口（从 d1-spikes/ 根可原样重放）
  requirements.txt            依赖锁定说明（零第三方依赖）
  .python-version             3.12.14
  fixtures/                   本地兜底 fixture（共享 fixtures 缺席时使用）
  src/pi_rpc_probe/
    transport.py              子进程 + 严格 JSONL framing（LF-only）
    client.py                 请求关联、事件分发、派生运行状态机
    evidence.py               脱敏、原子 JSONL、场景结果
    scenarios.py              五个统一场景 + 看门狗 + 夹具校验
    envcheck.py               环境事实记录（版本/凭据就绪状态）
    crash_probe.py            宿主崩溃清理探针
    crash_driver.py           崩溃探针的牺牲宿主进程（被 SIGKILL）
  tests/
    fake_pi.py                可编程假 pi 服务器（协议单元测试用）
    test_transport.py         framing / stderr 隔离 / 退出码 / 回收
    test_client.py            请求关联 / 超时 / 事件分发 / since-index
    test_evidence.py          脱敏 / 原子写 / 结果结构 / append-only
    test_scenarios.py         五场景 PASS/FAIL/BLOCKED 路径 + CLI 退出码
    test_integration.py       真实 pi 冒烟（有 pi 且凭据就绪才运行）
```

## 2. 环境准备

```bash
# 1) Pi CLI（精确版本；与 Agent B 相同）
npm install -g @earendil-works/pi-coding-agent@0.85.1
pi --version                      # 期望 0.85.1
pi auth check --provider <provider>   # 期望 ready

# 2) Python（零第三方依赖；参考解释器）
uv venv --python 3.12.14          # 或直接用系统 python3 >= 3.9

# 3) 单元测试（无需真实凭据；假 pi 服务器驱动全部协议路径）
cd d1-spikes/rpc-python
PYTHONPATH=src python3 -m unittest discover -s tests -v
# 参考解释器：
PYTHONPATH=src ~/.local/share/uv/python/cpython-3.12-*/bin/python3.12 \
  -m unittest discover -s tests
```

注意：`d1-spikes/scripts/verify-d1` 用 `python -m pytest -q` 跑本目录测试。
本机当前没有安装 pytest；测试本身是纯 unittest 风格、pytest 兼容，
装上 pytest 即可运行（该差异已作为环境观察记录，属负责人/Agent D
侧的验收工具链问题，不在本探针写入范围内）。

## 3. 探针命令（全部从 d1-spikes/ 根执行，可原样重放）

```bash
# 环境记录（版本、凭据就绪状态、Agent B 对齐状态）
python3 rpc-python/probe.py env-check

# 单个场景（evidence/rpc/<scenario>.{events.jsonl,result.json}）
python3 rpc-python/probe.py run --scenario basic
python3 rpc-python/probe.py run --scenario tool
python3 rpc-python/probe.py run --scenario steer
python3 rpc-python/probe.py run --scenario abort
python3 rpc-python/probe.py run --scenario resume

# 全部五个场景
python3 rpc-python/probe.py run

# 宿主崩溃清理探针（额外证据，不属于五场景）
python3 rpc-python/probe.py crash-probe
```

常用参数：`--pi-bin`（默认 `pi`）、`--provider`、`--model`、`--thinking`、
`--out`（默认 `d1-spikes/evidence/rpc`）、`--fixture-dir`、`--run-dir`、
`--request-timeout`（默认 120s）、`--timeout-factor`。

**tool 场景与共享 fixture 契约**：当 `d1-spikes/fixtures/`（Agent D）与
`d1-spikes/scripts/make-run-dir` 存在时，`run --scenario tool` 会自动生成
一次性运行目录（fixtures 完整副本，`readonly/` 去写权限），场景 cwd 即
副本中的 `fixtures/`，结束后自动清理。也可手工：
`bash d1-spikes/scripts/make-run-dir` 然后传 `--run-dir <路径>`（此时由
调用方负责删除）。判定答案（count/sum/min/max/median）由探针直接对照
副本中的 numbers.json 计算，绝不采信模型口述。

## 4. 退出码

| 场景 CLI 退出码 | 含义 |
|---|---|
| 0 | 全部 PASS |
| 1 | 任一 FAIL |
| 2 | 无 FAIL 但有 BLOCKED（无凭据时为 BLOCKED + blockedReason=CREDENTIALS，绝不伪造 PASS） |
| 3 | 无 FAIL/BLOCKED 但有 NOT_RUN |

`result.json` 的 `exitCode` 即第三方重放 `command` 观察到的探针退出码
（PASS→0 / FAIL→1 / BLOCKED→2）；pi 子进程自身的退出码记录在
observations 里。

## 5. 证据布局与格式

```
d1-spikes/evidence/rpc/
  basic.events.jsonl   tool.events.jsonl   steer.events.jsonl
  abort.events.jsonl   resume.events.jsonl
  basic.result.json    tool.result.json    …
  environment-rpc-python.json    crash-probe.json
```

- 每行事件：`seq`（单文件内从 1 严格递增）/ `observedAt` /
  `implementation` / `scenario` / `sessionId` / `piEventType` /
  `runState` / `payload` / `redactionVersion`（`d1-v1`），符合 Agent D
  的 `evidence-event.schema.json`。
- 结果：符合 `scenario-result.schema.json`；FAIL 时最后一行事件携带
  结构化 `error`（必含 `message`）。
- 所有文件先写 `.tmp` 再原子 rename；脱敏（sk-/rk- 密钥、Bearer、
  api_key、`/Users/<name>`→`<HOME>`）在落盘前完成；stderr 只进独立
  文件、进程退出后以脱敏 tail 折叠为 `probe_note` 事件，原始文件删除
  ——stdout JSONL 解析通道里永远没有 stderr 字节。

## 6. RPC 协议观察（与 SDK 的差异点）

以下为本探针实现与真实 pi 0.85.1 交互中确认的事实，细节以
`evidence/rpc/*.events.jsonl` 为准：

1. **无推送式运行状态**。RPC 的 `get_state` 是纯拉取；SDK 有可直接读
   的状态对象。本探针因此自建了派生状态机
   （`agent_start`→running，`compaction_start`→compacting，
   `agent_settled`→idle；`agent_end` 不回 idle，因为可能有 retry/排队
   续跑）——这是 RPC 接入方必须额外实现的状态机。
2. **带 id 的不一定是响应**。只有 `type=="response"` 是命令响应；
   `bash_execution_update` 等事件会回显发起命令的 id，误当响应会破坏
   关联（有专门测试覆盖）。
3. **abort 语义**：`abort` 命令要等到 agent 空闲才返回响应；被中断的
   消息 `stopReason` 为 `aborted`。abort 后进程仍可用于新会话。
4. **steer 语义**：`steer` 请求立即确认，但注入效果只能从
   `queue_update` 与后续 assistant 输出推断，协议没有
   “steer 已送达”事件。
5. **resume 机制**：`--session-dir <dir> --session-id <uuid>`（同 cwd）
   可跨宿主进程恢复；`switch_session(sessionPath)` 是显式兜底路径
   （场景代码两条都实现了，实际行为记录在 resume 证据中）。
6. **startup 噪声**：本地扩展（如 pi-switch）会主动发
   `extension_ui_request` 无请求事件，客户端必须容忍。
7. **正常退出**：关闭 stdin（EOF）后 pi 自行退出、退出码 0，
   启动约 0.6s。
8. **能力缺口（相对 SDK）**：无内嵌编程 API（一切经 JSONL 命令）、
   无会话内权限策略 API（仅有启动期 `--tools` 白名单）、流式增量以
   `assistantMessageEvent` 增量事件呈现而非回调。
9. **协议成本**：宿主必须自行处理 LF-only framing（U+2028/U+2029 在
   JSON 字符串里合法，不能按通用换行切分）、逐请求关联、stdin/stdout
  /stderr 三通道线程模型、以及超时后 SIGKILL 回收。

## 7. 子进程清理矩阵

| 情形 | 行为 | 验证 |
|---|---|---|
| 正常结束 | finally 里 `close()`：关 stdin→等待→terminate→kill，幂等 | 每场景 finally + 单测 |
| 场景超时 | 看门狗线程在 deadline+5s `kill_now()`（SIGKILL），解除阻塞 | `test_timeout_fails_and_reclaims_process` |
| 命令超时 | `RpcTimeoutError`（有类型），进程随后被 finally 回收 | `test_request_timeout_is_typed` |
| 子进程先死 | stdout EOF→派发线程回收 pending 请求为 `ProcessExitedError`（带退出码与 stderr tail） | `test_exit_during_pending_request` |
| 宿主崩溃 | 内核关闭驱动进程的管道 fd→pi 看到 stdin EOF；崩溃探针实测孤儿子进程是否自行退出、多久、是否需要强制回收 | `crash-probe` 证据 |

临时目录同样不留残留：五个场景与 crash-probe 的工作目录在
finally 里删除（含 make-run-dir 副本，先恢复写权限再删，调用方
`--run-dir` 传入的除外）；单元测试的临时目录由 `tests/helpers.py`
的 atexit 钩子统一回收（每次全套测试运行后零残留，实测验证）。

## 8. 局限

- 判定依赖模型确实输出指定词（pong/steered/READ_FAILED/…）；模型不
  听话时是 FAIL 而非协议错误 —— 与 SDK 探针同一条件，公平对照。
- steer 的“已生效”只能从输出推断（见 6.4）。
- resume 依赖 pi 的会话持久化行为，`--session-id` 与
  `switch_session` 两条路径的实测差异记录在证据 observations 里。
- 崩溃探针在 macOS 上无 PDEATHSIG 等价物；孤儿子进程行为依赖 pi
  观察 stdin EOF。
- 本探针不读取、不打印、不复制任何凭据；凭据不可用时输出
  BLOCKED + blockedReason=CREDENTIALS。

## 9. 需要负责人决定的事项（PENDING_OWNER）

以下决策本探针一律不自行做出，只提供证据：

1. **SDK vs RPC** 作为正式接入方式（两探针对照数据齐备后决定）。
2. **正式宿主语言/版本**（Python 3.12.14 仅为本次 spike 的参考锁定）。
3. **provider/model/thinking 基线**。pi 版本已对齐（双方均 0.85.1，
   记录在 `environment-rpc-python.json` 的 `agentBAlignment`）；但
   Agent B（sdk-node）以 pi 默认 provider `tal-token-plan-copy-copy`
   运行，五场景全部 403 BLOCKED，而本探针显式切换到
   `tal-token-plan-06c64a09`/`deepseek-v4.1-flash` 才得到五场景
   PASS。两边跑通的 provider/model 并不一致，统一基线待负责人定夺。
4. **权限策略**（RPC 侧只有启动期 `--tools` 白名单；更细的策略需要
   负责人定夺）。
5. `d1-spikes/evidence/environment.json`（共享环境记录）归属未定
   （Agent D 已登记 DELIVERY-004）；本探针只写自己范围内的
   `evidence/rpc/environment-rpc-python.json`。
