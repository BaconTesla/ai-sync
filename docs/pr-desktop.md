# feat: Electron desktop configuration library and selective sync

初始 Target: `feature/safe-sync-core` · Source: `feature/desktop-gui`

核心 PR 合并后，将 base 改为 `develop`；如果使用 squash merge，需要先 rebase 去掉已合并的核心提交。

## 内容
- 中文 GUI：设备共享、配置清单、搜索筛选、Skill / MCP 名称展示。
- 本机与对端并排内容预览、手动勾选、覆盖确认、打开备份。
- 安全 preload 和定向 IPC，sandbox / CSP / 禁止导航及权限。
- 新增文件以硬链接原子落盘，避免覆盖并发出现的同名文件。
- 隔离临时目录的 GUI 冒烟测试，支持通过本机 Tailscale 接口拉取。
- 运行、安全边界、备份恢复与分支说明。

## 验证
- `npm run check`：通过。
- `npm test`：10 项通过。
- `npm run test:smoke`：GUI 加载、预览、筛选、隔离通过；本机 Tailscale 地址上的完整拉取流程通过。
- `npm audit --audit-level=high`：未发现漏洞。

## 待验收
- 两台物理 Mac 的跨机测试。
- 尚未签名、公证或生成安装包。
- 不含字段级合并、自动同步、设备发现、GUI 恢复或 MCP 执行管理。

## 本地截图
`npm run test:smoke` 输出临时目录中的 `ai-sync-smoke.png` 路径。上传截图前请遮盖设备信息、IP 和本机路径；不要上传真实配对令牌。
