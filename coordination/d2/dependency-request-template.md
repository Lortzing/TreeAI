# Dependency Request: `<agent-id>-<序号>`

> 复制本模板为 `coordination/d2/agent-<id>-dependency-request.md` 并填写。
> 由提出 Agent 维护；"Integrator 审核结论"一节只由 Integrator 填写。

- 提出者：Agent <ID>
- 日期：YYYY-MM-DD
- 目标 workspace：`packages/<name>` / `apps/runtime-smoke` / 根 devDependencies
- 依赖类型：dependencies / devDependencies
- 依赖名称与**精确版本**：`<name>@<x.y.z>`（禁止 `latest`、`*`、范围、Git HEAD）

## 用途

（为什么需要这个依赖；用于哪个模块的哪个功能；不引入它会怎样）

## 替代方案

（已考虑的替代品；现有依赖或标准库为何不足；为什么是这个版本）

## 风险

（供应链与维护状态；安装体积与 native 构建；与已锁基线 Node 24.21.0 / npm 11.19.0 / TS 5.9.3 / Pi 0.85.1 的冲突；license 兼容；对 clean install `npm ci` 的影响）

## Integrator 审核结论

（由 Integrator 填写）

- 结论：批准 / 驳回 / 待定
- 安装记录：命令、锁文件变更、验证退出码
- 日期：YYYY-MM-DD
