# Studio 紧凑布局与附件浮卡 — 2026-10-28

代码提交：`c03b19e70b4ae0a53b250de6e562227b72046856`。
基线：`1455dad7ba89a60884eed822d5b81773e881d8ff`。
分支：`codex/studio-warm-navigation-resume`；仅本地提交，没有推送或发布。

## 用户可见变化

- 左侧栏可收为 64px 图标栏，并记住桌面收起状态；新建、搜索和设置仍可直接使用。窄屏保留抽屉。
- 顶部合并为单行 60px 工具栏。对话与关系图改为带中文可访问名称的图标；关系图复用原路径图标。
- 搜索展开为独立浮层，默认聚焦输入框，范围和类型按需展开；支持快捷键、关闭按钮、Escape 和点击外部关闭。
- 当前附件在独立圆角浮卡中列举；点击材料收起卡片，在右侧打开阅读器。宽屏保留左侧对话，窄屏使用覆盖阅读面。
- 材料版本、来源定位、选文、草稿与阅读位置使用原有控制器。修复触摸结束补发鼠标事件误清选区，以及来源抽屉被顶部图标遮挡的问题。

[附件浮卡](attachments.png) · [右侧阅读](reader.png) · [搜索浮层](search.png)
截图使用本机临时 Echo 工作区和专为预览编写的示例材料。

## 验证

- 最终提交上 `npm run typecheck`：PASS，见 [types.log](types.log)。
- 最终提交上 `npm test`：905/905 PASS，0 fail / skipped，见 [tests.log](tests.log)。
- 资源审计：56 ESM + 12 CSS；computed paths：131 resources + 20 test globs PASS，见 [assets.log](assets.log)、[computed-paths.log](computed-paths.log)。12 项 computed expressions 的动态边界仍按原 gates 记录。
- 最终提交上的完整 Chrome Echo D4：**16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**，干净提交重跑，结果见 [d4-summary.json](d4-summary.json)、[d4.log](d4.log)。原始 gitCommit / gitDirty 字段保留。
- 新增真实浏览器断言：64px 侧栏、单行顶栏、搜索不强制展开侧栏、聚焦输入框、独立附件卡片、选附件后收卡并与对话并列阅读；原宽/窄屏、键盘、触屏、草稿、来源与阅读位置断言保留。
- 导入验证改用明确的 `.material-name` 定位标题，不再误读新增文件类型图标；冻结材料、选区、负例、评估分母与业务断言未删改。
- 完整原始浏览器产物留在 `/tmp/treeai-compact-d4-committed/`，其中含截图、各领域 sidecar 与进程日志。

## 保留的失败和修复过程

- 初期探针沿用旧入口，误将桌面侧栏按钮当作窄屏抽屉；随后路径菜单挡住附件入口。探针改为真实关闭当前浮层、揭开目标 disclosure 后再点击。
- `beta-v4` 曾出现一次支线关闭等待超时；后续增加失败截图，后续运行未复现。没有降低超时或删除断言。
- `beta-v5` 由于错误导入未导出的 helper 失败；改为引用其实际所属模块。
- `beta-v6` 暴露触摸释放后的兼容鼠标事件清选区；修复为触屏 selectionchange 独立负责选区，并增加回归断言；`beta-v7` 5/5 PASS。
- 首次完整 D4 为 13 PASS / 3 FAIL：两项导入检查将文件图标读作标题，一项来源抽屉关闭按钮被顶栏盖住。修正后专项 7/7 PASS，再对最终提交执行完整回归。
- 原始失败摘要保存在 `failures/`；初期完整单元检查的旧文案/旧交互断言失败日志也保留。所有失败均未记为 PASS。
- 本轮没有重复调用此前 DNS 失败的 Claude Code 通道；主代理完成实现和验证。

## 边界

本轮没有运行真实 Pi/厂商 API、远端 CI、安装包、多平台、offline D2/D4 verifier 或其独立 selftest、冻结质量评估和真人试用。Echo 只验证机制，不代表模型质量或人工/物理验收。依赖和锁文件未改动，既有证据未删除。
