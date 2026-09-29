# evidence/d3/offline/ — 自动化离线证据

- 定位：D3 相关**自动化离线验证**的产物——Studio 测试套件与故障/幂等
  测试的自动化部分（W1 测试义务表「自动化（离线）」列，见
  `docs/d3/W1-product-contracts.md` §4）。全部为离线路径：无网络、无凭据、
  默认 echo driver。
- 产出命令：`npm test`（含 `apps/studio` 套件）、`npm run verify:d2`
  （已纳入 Studio 套件）等。

## 布局

沿用 `evidence/d2/` 的 run 布局：

```text
evidence/d3/offline/<UTC-run-id>/
├── environment.json   # Node/npm/TypeScript/Pi 版本、平台、commit SHA
├── result.json        # 逐项检查结果与退出码
└── logs/
```

## 规则

1. **只追加，不覆盖**；失败与 NOT_RUN 记录同样保留。
2. **绑定 commit SHA**：`environment.json` 必须记录运行时工作区 HEAD。
3. **secret scan**：写盘前与写盘后各扫描一次；发现泄露按验收器规则隔离
   处理，历史记录不改写。
4. **明确边界（issue #2）**：本目录证据只覆盖自动化可模拟的部分——
   双击 / 并发 / 重启收敛 / 中止 / 模型错误的注入式模拟，以及服务层
   fail-closed 语义。**响应丢失与缺失 session 的真实环境复现、全部
   UI 级验证（目标 Mac、窄窗、键盘焦点、prefers-reduced-motion）**
   属 `real-pi/` 与 `trials/` 的口径。**Echo / D2-live 结果不得替代
   真实 Pi 证据。**
5. 记录格式参照 `evidence/d3/templates/run-record.md`（如以文档形式
   补充说明，而非纯脚本产物时）。
