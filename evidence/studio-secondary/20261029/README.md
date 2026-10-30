# 二级页面精简与右栏收卡 — 2026-10-29

代码提交：`f08fe370d706788fa96727a4b644afa63a13d080`。
基线：`195d2bfceffcfcc4e62b785b4e82104b14bf11ff`。
仅本地提交，未推送或发布。

## 用户可见变化

- 阅读器、支线面板、来源抽屉的所有打开入口都会收起附件浮卡，包括重新打开当前材料。关闭阅读器后焦点回到收起的附件入口，不会重新展开浮卡。
- 阅读器默认显示正文、版本/文件信息入口和操作提示。解析器版本、文本偏移、加载计数和排查说明按需展开；失败重试、旧版本与来源变化仍直接提示。
- 材料提问默认展示标题、完整摘录和实际引用范围；长材料的截取限制继续直接说明。精确来源坐标、组合上下文和发送排查信息保留在详情。
- 来源页优先显示已保存的收获、批注与采用状态；运行日志、任务统计、估算用量收进技术详情，阅读偏好单独折叠。
- 路径与搜索结果默认显示名称、层级及完整路径，隐藏内部 ID；DOM 身份数据和精确导航行为保留。

[阅读器截图](reader.png) · [来源页截图](sources.png)。截图来自临时 Echo 工作区中的人工示例材料。

## 验证

测试在最终代码文件内容上执行，随后封存为上述本地提交。原始浏览器记录的 gitCommit/gitDirty 字段保留；不把本次工作区运行描述为启动于干净提交的重跑。

- `npm run typecheck`：PASS，[日志](types.log)。
- `npm test`：905/905 PASS，0 fail / skipped，[日志](tests.log)。
- `npm run audit:studio-assets` 与 `npm run audit:computed-paths`：PASS，[资源日志](assets.log)、[路径日志](computed-paths.log)。
- `node scripts/run-d4-browser.mjs --mode selftest --artifacts /tmp/treeai-secondary-d4-final`：**16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**，[日志](d4.log)、[结构化摘要](d4-summary.json)。完整原始产物在该 artifacts 目录。
- 新增/扩展断言覆盖三个右栏入口收卡、同材料重开、Escape 焦点不展开浮卡、默认隐藏元信息、来源页隐藏运行细节。导航探针改从 DOM 数据属性核对身份；原路径层数、冻结数量、偏移/摘要、来源一致性、重试和恢复断言保留。

## 失败记录与边界

- 首轮旧文案及 ID tooltip 定位导致 PDF、恢复与导航探针失败，Return 依赖项未运行。适配新文案和 DOM 身份属性，保留原语义断言及分母。
- 首轮 B6 记录了临时服务 502/connection-refused；后续完整运行的 B6 通过，未增加忽略规则或降低阈值。
- [首轮完整日志](failures/d4-first.log)、[结构化摘要](failures/d4-first-summary.json)、[早期 UI 文案断言失败](failures/ui-expectations.log)保留。其他原始调试日志仍在 `/tmp/treeai-secondary-*`。
- Claude Code 只读审查调用因 FailedToOpenSocket 失败（is_error=true，permission_denials=[]）；未循环重试，由主代理完成。
- 本轮未执行真实 Pi/厂商 API、远端 CI、多平台安装、offline D2/D4 verifier 或独立 selftest、真人质量评估与试用。Echo 只证明机制，不代表模型质量或整体验收。
- 依赖、锁文件、冻结夹具、评估分母和既有证据未变更。
