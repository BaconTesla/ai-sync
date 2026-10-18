# AI Sync

面向 Mac mini / MacBook 的 AI Agent 配置同步桌面工具。通过 Tailscale 私有网络手动拉取 Skills、MCP 和配置，先预览、再选择、覆盖前备份。

项目正在开发。同步协议不执行远程命令，不自动启动 MCP 服务，不同步删除操作。

## 开发流程

- `main`：稳定分支。
- `develop`：开发集成分支。
- `feature/*`：单个功能分支；测试通过后 push 并创建面向 `develop` 的 PR。
- 发布时从 `develop` 向 `main` 发 PR。
- 不将真实配置、配对令牌、密钥或个人 Skills 提交到仓库。

尚未配置远程仓库，push / PR 需在提供远程地址后执行。
