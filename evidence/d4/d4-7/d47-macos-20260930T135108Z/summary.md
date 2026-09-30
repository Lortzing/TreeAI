# D4-7 本机 macOS ARM64 真实安装实测 — d47-macos-20260930T135108Z

- 模式：local-real-macos（真机、真实平台数据目录、真实 open 命令）
- 主机：ProductName:		macOS；ProductVersion:		26.6.2；BuildVersion:		25G83 / arm64；Node v24.21.0
- 被测提交：fcb5fa33e89deebe1e5e020a5ec1bcddf636d6f9
- 产物：A=treeai-studio-0.1.0-d47local-a-darwin-arm64.tar.gz、B=treeai-studio-0.1.0-d47local-b-darwin-arm64.tar.gz（同一提交的两个版本号，验证升级机制）
- 安装路径（中文+空格）：/var/folders/h4/5vf7cdk17gn80ym2tdpg7tvr0000gn/T/treeai-d47-local/安装 目录（中文+空格）
- 真实数据目录：~/Library/Application Support/TreeAI（运行前不存在=false；结束后不存在=true）

## 结果：PASS 55 / FAIL 0

全部通过。

## 诚实边界
- Windows 11 x64 / Ubuntu 24.04 的干净安装实测属负责人目标机验证（B8 BLOCKED 部分），本机证据不替代。
- A/B 为同一提交的两个版本号：验证的是升级机制（停机/备份/替换/健康验证/回滚/数据不动）。
- 真实 Pi 冒烟（模型调用）未包含：本实测零凭据（与 D4-7 工程波边界一致）。

全部命令与退出码见 commands.log；环境见 environment.json。
