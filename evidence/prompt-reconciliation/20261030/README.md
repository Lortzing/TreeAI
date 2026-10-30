# 普通提问对账验证（2026-10-30）

产品代码：`6d92d6e124a97e76fcb669f6436c53287f6b846d`，基于已合并的 `e682af0ca55e6c2db97a6e52f608e9ec0610cd55`。后续三个提交修复/扩展验收探针，没有改动产品代码；最终源码身份见 [source-hashes.json](source-hashes.json)。[行为与限制](../../../docs/development/prompt-reconciliation.md)描述可选带键接口、schema 12 与客户端保留策略。

## 检查与边界

- 七个工作区 `npm run typecheck`：[通过](types.log)。根测试 `tsc --noEmit -p tests/tsconfig.json` 通过（零诊断，[原始输出](root-types.log)）。误用根 base 配置会包含故意失败的 contracts negative fixtures；正式检查沿用工作区及 tests 自己的配置。
- 最终源码 `f84d70be11176088149541654133003b8490bc72` 的完整 `npm test`：**963/963 PASS，0 fail / 0 skipped**，结果在 [tests.log](tests.log)；保留所有原有测试名/语义断言。schema 10/11 的历史迁移前缀仍显式测试，升级终点改为当前 schema 12；没有删除失败断言。
- 请求/存储/HTTP/恢复专项：[6/6](requests.log)，覆盖同键在途与终态重放、改载荷冲突、树作用域、中止后显式新键、对准前/Run 中重启、缺失会话、事务回滚、无会话包导出恢复及旧接口。
- 控制器最终完整测试包含 7 项，覆盖响应丢失、刷新后同键、在途编辑、附件/模型/切树保护、终态失败后新键，以及会话缺失时纯查询；[早期 7 项专项日志](controllers.log)与最终完整测试互相核对。
- 原生 Chrome 对账探针：[PASS](browser-summary.json)，在干净的产品提交 `6d92d6e124a97e76fcb669f6436c53287f6b846d` 上运行。真实 loopback HTTP、Echo/Pi runtime 和 SQLite，CDP 在响应阶段丢弃已提交 POST，再丢弃首次状态 GET；删除临时 Pi 会话并刷新后，用空输入框的核对按钮找回已保存对话。恰好 1 个请求响应、1 个 Episode、1 条 user 和 1 条 assistant；对账后缺失会话的普通发送仍禁用。[截图](reconciled-after-reload.jpg)仅含合成问题。
- 原生 Chrome D3：[25 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN](d3-summary.json)，[日志](d3-final.log)。6 项为真实 Pi 模型错误/工具门检查，不能算 PASS。覆盖主线/双分支、配置后真实键盘发送、Return 保存和采用、上游失败、宿主重启、session 缺失、新探索、来源定位、长文/重复词/跨行选区。报告保留运行时 `abe770f...` 和 `dirty:true` 原值；该运行使用的最终探针字节随后原样提交，产品源码自 `6d92d6e...` 后未变，不冒充干净版本运行。
- [静态资源](assets.log)：105 ESM / 13 CSS；[计算路径](paths.log)：133 resources / 20 globs。新增顶层测试均由原有 globs 发现，public 没有新增模块路径，安装器继续包含原资源树。

## 发现并保留的失败

额外运行旧 D3 探针暴露三个既有问题：单轮分页器隐藏时一直重用空快照；仍假定默认快捷键是 Cmd/Ctrl+Enter；为自身有 id 的 summary 拼出末尾带 `>` 的非法选择器。产品页面和数据库当时已有回答，不能将超时报为产品丢失。

缓存问题用新增回归在原 main 文件上复现：[4 PASS / 1 FAIL](d3-baseline-regression.log)，修复后包含两项新增回归的 [7/7 专项通过](d3-unit.log)。原有断言、真实键盘事件、点击命中校验都保留；快捷键通过现有设置控件显式选择，未修改产品默认值。[第一次级联超时日志](d3-first-interrupted.log)保留，该次主动终止，无完整结果，不能算 PASS。

修复后原 D3 重启场景仍有 [23 PASS / 2 FAIL / 6 NOT_RUN](d3-before-recovery-update.log)：它直接用新问题覆盖停机期间尚未核对的请求，触发本次新增的载荷保护，随后留下待核对按钮。更新场景为先查询原键确认尚无记录、显式同键重试原问题并读取成功状态，再执行原有新问题续聊与会话缺失断言；这些断言没有删减，最终 25/0/6。

Claude Code 外部只读审查本次 50 秒超时，没有有效审查结论；最终差异与验收由主代理检查。

## 未关闭事项

本轮均使用合成输入和离线 Echo，不是模型质量、真实 Pi 工具、安全门整体、实体设备签收、3–5 人独立试用或跨天复用的证据。既有自动术语质量门保持关闭；没有重跑或改写那些门禁。长程上下文展示与真实材料纵向试用仍待下一阶段。

新增 schema 12 沿用严格导出包版本校验；旧包需要在匹配版本恢复后再升级，不宣称新增了旧包格式迁移。宿主中断可能无法判断供应商是否已计费/完成，原请求不会自动派发第二次。
