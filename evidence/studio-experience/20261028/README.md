# Studio 暖白改版与导航减负 — 2026-10-28

基线：`35ae4a012fd6beea0b66b9bb773dbe858dfedc45`（PR #29）。
主要代码：`62eef75b2b2f643475b3f35d6dd935039b6d30de`。
最终代码：`8a3890c9a938fb44360c6716742a2501c09d07d0`。
本地分支：`codex/studio-warm-navigation-resume`。未推送，未发布。

## 用户可见变化

- 暖白画布、浅米灰侧栏与松绿强调色；统一阅读、输入和支线工作面。
- 侧栏保留新建、搜索、历史、设置；路径、材料、更多导航集中到“资料与路径”。
- 设置独立全页；来源、运行详情与材料使用有中文可访问名称的图标。
- 空树问题起点只填草稿，不自动发送，也不覆盖现有输入。
- 修复导航选树时误收起工具、来源跳转时工具遮挡阅读器、工具入口清除回答选区，以及焦点返回隐藏按钮的问题。
- 最后修复来源抽屉刷新时覆盖 SVG 图标的旧逻辑；三个原有标签恢复断言改查中文 aria-label，保留关闭、Escape、焦点和展开状态断言。

[工作台](workspace.png) · [独立设置页](settings.png) · [下一阶段计划](../../../docs/development/studio-experience-next.md)

## 实际验证及版本边界

- 固定 Node 24.21.0 / npm 11.19.0；从此前工作区复制已安装依赖，workspace 符号链接仍为相对链接。依赖声明及锁文件无变化。
- 最终 `npm run typecheck` PASS：[日志](final-typecheck.log)。
- 最终 `npm test` **904/904 PASS，0 fail / skipped**：[日志](final-tests.log)。该次源码随后原样提交为最终代码 SHA；文件摘要见 [final-tested-files.sha256](final-tested-files.sha256)。
- Studio 资源审计：56 ESM + 12 CSS；computed paths：131 resources + 20 test globs PASS。见 [assets](assets.log)、[computed paths](computed-paths.log)。最终图标修正没有增加或移动资源。
- 完整 D4 Chrome Echo：**16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**：[日志](d4-full.log)、[原始摘要](d4-full-summary.json)。覆盖材料完整分母、真实鼠标选文、建枝、Return、丢响应与重启、导出恢复、搜索、大树导航、B6、桌面/390px 可用性和术语路径。
- 上项启动于主要代码工作候选；运行中保存主要代码提交，最后阶段修正了来源图标。原始摘要为 `62eef75...` / dirty；**不是最终 SHA 的完整干净重跑**。主要代码文件摘要见 [tested-files.sha256](tested-files.sha256)。
- 最终图标调整后补跑 D4 usability：**5 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**（4 boot + 1 usability），见[日志](d4-final-beta.log)、[摘要](d4-final-beta-summary.json)。该次源码随后原样保存为 `8a3890c...`，不改写原始 runner 身份字段。
- 浏览器实际点击来源图标 → 关闭：SVG 数量保持 1，中文 aria-label 恢复“来源记录”，aria-expanded=false，焦点回入口。独立设置打开/关闭、工作台布局截图已检查；预览使用临时 Echo 数据。
- B9 100 棵树 / 10100 分支：首次大树可用 458.1ms，操作 p95 45.0ms；B6 30 次材料打开 p95 156.1ms。只代表本机工程检查。

## 失败与保留记录

- 前一聊天完整浏览器运行 14 PASS / 2 FAIL（导航工具被误收起；选区被清除）：[原摘要](previous-browser-failure-summary.json)。
- 本次首次定向运行修复选区，但来源跳转后仍被工具覆盖：[原摘要](focused-failure-summary.json)。补修后导航 [5/5 通过](nav-fixed-summary.json)，然后完整回归通过。未删除或放宽原有断言和分母。
- 初始沙盒测试因 loopback listen EPERM 失败：[原日志](sandbox-test-failure.log)。授权本机端口执行通过；EPERM 不记为产品 PASS。
- 首次定向命令把两个 --only 值写成逗号列表，被参数校验拒绝；随后使用两个独立 --only 参数。失败原日志已被后续同路径运行覆盖；未计入验收。
- Claude Code 只读审阅失败：subtype=success、is_error=true、terminal_reason=api_error、DNS ENOTFOUND、无 permission_denials。任务与结果保留在 `/tmp/treeai-design-resume-review/`；主代理独立审阅。未宣称外部审阅成功或额度节省。
- 完整浏览器原始截图、日志、sidecars 保留于 `/tmp/treeai-design-resume-full/`；最终定向运行于 `/tmp/treeai-design-resume-final-beta/`；前一聊天产物和原工作区未改写或删除。

## 排除项

本轮未运行真实 Pi/厂商 API、安装包、多平台、远端 CI、offline D2/D4 verifier 或其独立 selftest、冻结质量评估与真人试用。Echo 只验证机制，不证明模型质量。用户后置真人试用；历史人工/物理/质量验收保持开放，未把暂缓当作通过。
