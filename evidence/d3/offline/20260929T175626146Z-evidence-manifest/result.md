# D3 离线证据 manifest — `0b18784`（2026-09-29）

绑定提交：`0b1878467b733d7dd99d527710d32c00753eea8f`（工作区存在未提交改动（gitDirty = true））。
运行环境：Node v24.21.0 / npm 11.19.0 / darwin arm64。
本记录由 `npm run record:d3`（scripts/record-d3-evidence.mjs）生成，只登记事实
（命令、退出码、耗时、产物 SHA-256），不声明任何门禁结论。

## 命令结果（按执行顺序）

| 命令 | 退出码 | 耗时 |
| --- | --- | --- |
| `git rev-parse HEAD` | 0 | 9ms |
| `[HOME]/.local/share/fnm/node-versions/v24.21.0/installation/bin/node --version` | 0 | 11ms |
| `npm --version` | 0 | 50ms |
| `[HOME]/.local/share/fnm/node-versions/v24.21.0/installation/bin/node --check apps/studio/public/app.js` | 0 | 20ms |
| `npm run typecheck` | 0 | 3678ms |
| `npm test --workspace @treeai/studio` | 0 | 6010ms |
| `npm test` | 0 | 17499ms |
| `npm run verify:d2` | 3 | 24114ms |

完整输出尾部（各命令末 40 行，已脱敏）见 `manifest.json` 的 `commands[].outputTail`。

## 退出判据

- 本 manifest 生成脚本退出 0 的判据：`node --check apps/studio/public/app.js`、
  `npm run typecheck`、`npm test --workspace @treeai/studio`、`npm test`、
  SHA 绑定（git rev-parse HEAD）全部退出 0。
- `npm run verify:d2` 的退出码如实记录，**不计入**上述判据——CI 中由
  d2-offline workflow 单独把关。

## 产物哈希（Studio 前端基线输入）

| 文件 | SHA-256 |
| --- | --- |
| `apps/studio/public/app.js` | `9b4357ada3e056d59464808182b810e57c5462ce77be78f47f55e56890a8e0fd` |
| `apps/studio/public/index.html` | `9a6bb736890f3c7004c107618692e8ae6a1272be219a07ca92183ec6a59bcf6c` |
| `apps/studio/public/style.css` | `211b28b5c97cf112005822c6e205af09cc1f6d5ae9a3dd6688d845066d904951` |

`manifest.json` 的 `artifacts` 另含本 run 目录两个产物（result.md 与
manifest.json 自身）的 SHA-256；manifest 自哈希按空占位规则计算（见其 notes）。

## 边界（如实声明）

- 本 manifest 只覆盖**离线自动化**。真实 Pi Studio 操作证据、故障/幂等序列
  与 3–5 人试用记录按 evidence/d3/README.md 归 `real-pi/` 与 `trials/`
  口径另行记录（Go 条件要求全部证据同 SHA）。
- 命令输出仅保留末 40 行；绝对路径与秘密形状内容在写盘前掩蔽，
  写盘后对 run 目录复扫（仓库 secret-scanner 规则）。
- Studio 的 UI 自动化覆盖是脚本化 DOM 套件（apps/studio/tests/ui-probe.test.ts），
  非真实浏览器 E2E——像素级视觉基线不在其覆盖范围。
