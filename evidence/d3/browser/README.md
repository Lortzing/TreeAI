# evidence/d3/browser/ — 浏览器 UI 级操作记录

- 定位：在**真实 Chromium 浏览器**中驱动**本地启动的 Studio 服务器**上的
  真实 Studio Web UI 所留下的记录——补齐 D3 验收（issue #6）工程侧尚缺的
  browser-UI 级录制。覆盖三类内容：
  - **echo driver 录制**：确定性 echo 驱动下的真实浏览器 UI 操作记录，
    **必须显著标注为 echo**，永远不得冒充或替代真实 Pi 证据；
  - **真实 Pi driver 录制**：真实模型驱动下的浏览器操作记录，必须写明
    driver / provider / model；
  - **真实浏览器样式与布局抽查**（computed style / layout spot check）。
- 每次运行一条记录：`browser/<UTC-run-id>-<slug>.md`，绑定运行时工作区的
  commit SHA；只追加，不得事后改写，需要补充就追加新记录（沿用
  `evidence/d3/README.md` 的纪律）。

## 必填环境（每条记录）

- Node / npm 版本（锁基线 Node 24.21.0 / npm 11.19.0）；
- 浏览器与驱动通道（Chromium 版本、自动化通道说明，不含用户名 / 机器标识）；
- Studio 启动参数（driver / provider / model；echo 录制写明 `--driver echo`）；
- 真实 Pi 录制：Pi 版本（`@earendil-works/pi-coding-agent` 实装版本，锁
  0.85.1）；API key 只经 `TREEAI_STUDIO_API_KEY` 注入——记录中**最多出现
  变量名，绝不出现值**。

## 记录必含

- **驱动类别**（echo / 真实 Pi）在标题与基本信息中醒目标注；
- 操作步骤逐条（做了什么、在哪个屏幕、预期是什么）；
- 脱敏 ID 清单（Tree / Branch / Run / Return，可区分即可，如前 8 位）；
- 样式 / 布局抽查：选择器、被查属性（computed style / 布局值）、期望与
  实测结果（如实）。

## JSON 附件（DOM 快照 / 可访问性树摘录）

- 可作为附件入库：`browser/<同记录 ID>/<名称>.json`（与记录同名、去掉
  `.md` 后缀的目录）；
- 附件与记录正文遵守**同一脱敏规则**：入库前先清理 DOM / 可访问性树中的
  本地绝对路径、用户名等（以 `<data-dir>` 之类占位符代替），再按区域规则
  做 secret scan。

## 规则

1. **只追加**；绑定 commit SHA；写盘前后 secret scan（区域规则见
   `evidence/d3/README.md`）。
2. **脱敏**：不得出现 API key / 凭据值（最多出现变量名）；不得出现可识别
   用户的本地绝对路径（以 `<data-dir>` 等占位符代替）；不得出现用户名 /
   机器标识。截图与任何二进制**不入仓**，记录内只留归档位置占位。
3. **Echo 醒目标注**：echo 录制不得作为真实 Pi 证据呈现；真实 Pi 浏览器
   录制沿用 `evidence/d3/real-pi/README.md` 的环境 / 版本 / 凭据要求。
4. 结论用 PASS / FAIL / BLOCKED / NOT_RUN 如实记录（沿用 D2 状态词）；
   不声明门禁结论。
