TreeAI D1 确定性夹具（fixtures）
================================
所有者：Agent D（d1-spikes/fixtures/ 为 Agent D 独占写入目录）
fixture 版本：d1-v1

一、用途
  本目录为 D1 五个统一场景（basic/tool/steer/abort/resume）提供完全确定性的
  输入文件。SDK 探针（Agent B，sdk-node）与 RPC 探针（Agent C，rpc-python）
  必须使用同一组 fixture 与同一提示词，保证对照公平。

二、最重要的规则
  1. 任何场景运行（读与写）都只能在 fixtures 的临时副本上进行；禁止直接
     读写本目录原始文件。临时副本由 scripts/make-run-dir 生成（见第五节）。
  2. 临时副本中的 readonly/ 已被去除写权限；场景若尝试写它应当失败，
     这正是「工具只访问授权 fixture」的验证点之一。
  3. 本目录内容冻结，完整性由 MANIFEST.sha256 跟踪；scripts/verify-d1 会
     校验 MANIFEST，任何对本目录的改动都会导致验收 FAIL。
  4. 本目录不含任何凭据、令牌或个人数据。若发现疑似秘密，按泄密事件处理：
     停止共享相关证据并登记 reports/blockers.md。

三、文件清单
  README.txt             本说明
  numbers.json           tool 场景的固定数值数据（16 个整数，pi 的数字）
  readonly/notes.md      只读说明性 fixture
  readonly/glossary.txt  只读术语表（五个场景与四种状态的定义）
  MANIFEST.sha256        上述数据文件的 SHA-256 清单

四、tool 场景标准校验问题（SDK 与 RPC 必须使用同一组）
  要求 Agent 读取（临时副本中的）numbers.json 并回答：
    Q1：values 一共有多少个元素？        期望答案：count = 16
    Q2：values 的总和是多少？            期望答案：sum = 80
    Q3：values 的最小值和最大值是多少？  期望答案：min = 1, max = 9
    Q4：values 的中位数是多少？          期望答案：median = 5
  判定由探针测试代码完成（对照 numbers.json 原文计算），
  不得只凭模型口述；返回内容必须与 fixture 一致。

五、生成临时运行目录
  命令：d1-spikes/scripts/make-run-dir
  输出：run dir 的路径（stdout 最后一行）。内含：
    <run>/fixtures/    本目录的完整副本（readonly/ 无写权限）
    <run>/work/        场景可写的工作目录
    <run>/RUN-INFO.txt 生成本副本的命令、时间与源清单摘要
  用后由调用方删除（验收脚本的自检模式会自行清理）。

六、本地校验 fixture 完整性
  cd d1-spikes/fixtures && shasum -a 256 -c MANIFEST.sha256   (macOS)
  cd d1-spikes/fixtures && sha256sum -c MANIFEST.sha256       (Linux)

七、相关契约
  证据文件布局与 JSON Schema 约定见 d1-spikes/schemas/README.md。
  统一验收入口为 d1-spikes/scripts/verify-d1。
