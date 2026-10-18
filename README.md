# AI Sync

用 GUI 同步 Mac mini / MacBook 上的 AI Agent 配置。基于 **Electron + TypeScript**，通过 **Tailscale IPv4 + 配对令牌**直接在设备间手动拉取，不依赖云端同步服务。

> 当前为可运行的开发版 MVP，不是已签名的 macOS 安装包。先用不重要的配置验证，再用于日常环境。

## 已实现

- 本机配置清单：按 Agent、Skills、MCP / 配置筛选与搜索。
- Skill 文本预览；JSON / Codex TOML 中 MCP 服务名称展示。仅展示声明，不执行或探测服务。
- 手动开启只读共享，绑定指定的 Tailscale IPv4，随机 256-bit 配对令牌。
- 拉取前展示本机 / 对端内容，区分新增、不同、相同。**默认不勾选任何文件**。
- 明确勾选并二次确认；覆盖前备份；预览后本机文件变化则拒绝覆盖。
- 路径白名单、符号链接拦截、文本与大小限制、常见内嵌凭据过滤。
- 渲染进程隔离：sandbox、contextIsolation、定向 IPC、CSP、禁用导航与权限。

## 启动

建议 Node.js 24 LTS，macOS，npm。

```sh
npm ci
npm start
```

首次运行需要下载 Electron 二进制。如果当前网络需代理，确保 Electron 下载进程也能访问 GitHub；npm registry 可访问不代表 GitHub Release 可访问。可按 Electron 官方安装文档配置下载代理，不需要修改业务代码。

```sh
npm run check       # TypeScript 检查
npm test            # 核心与 HTTP 集成测试（全部使用临时目录）
npm run test:smoke  # macOS GUI 冒烟测试，需要图形会话
```

GUI 冒烟测试使用独立临时 HOME 和应用数据目录，不读写你的 Agent 配置。存在 Tailscale IPv4 时，还会在该地址运行临时只读对端，实际点击预览、冲突选择、确认与拉取；否则跳过该项。它不是两台物理设备的跨机验收。

## 两台 Mac 怎么用

1. 两台设备安装并登录同一个 Tailscale 网络，分别运行 `npm start`。
2. 在 **源设备** 的“共享本机”中选择 / 填写本机 Tailscale IPv4，点击“开启共享”。默认端口 `47191`。
3. 显示本机令牌并安全复制给 **目标设备**。令牌授予读取所有通过过滤的白名单配置的权限，不要发到公开聊天或提交到 Git。
4. 在目标设备填入源设备的 IP、端口和令牌，点击“连接并预览”。
5. 查看本机 / 对端原文，勾选需要的文件，点击“拉取所选”，确认后写入目标设备的相同相对路径。
6. 用完在源设备停止共享，或直接关闭窗口。重置令牌会同时关闭共享，旧令牌失效。
7. 反方向同步时交换源设备和目标设备即可。

**不同文件是整文件覆盖，不是字段合并。** 当前不判断“哪一份更新”，不自动处理冲突。预览有效期 5 分钟；拉取时使用已经校验的快照，而不是重新下载可能变化的远程文件。

### 支持的默认路径

路径相对于用户 HOME：

| Agent | Skills | 配置 / MCP |
| --- | --- | --- |
| Claude Code | `.claude/skills/**` | `.claude/settings.json`、`.claude.json` |
| Codex | `.codex/skills/**` | `.codex/config.toml` |
| Gemini CLI | `.gemini/skills/**` | `.gemini/settings.json` |
| OpenCode | `.config/opencode/skills/**` | `.config/opencode/opencode.json`、`opencode.jsonc` |
| Shared | `.agents/skills/**` | — |

不扫描整个 HOME，不读取项目级配置，不同步 `.env`、`auth.json`、认证目录、隐藏 Skill 文件或 `node_modules`，不跟随符号链接。单文件上限 256 KiB，文本总量 4 MiB，最多 500 个文件。配置可包含设备相关绝对路径，拉取后可能需要手动调整。

JSONC 可以同步及查看原文，但当前不解析其服务列表；MCP 名称统计仅覆盖直接的 JSON `mcpServers` / `mcp` 和简单的 TOML `[mcp_servers.name]` 声明。不保证支持每个工具的全部配置版本。

### 备份与恢复

“打开备份”会打开应用数据目录中的 `backups/`。每次覆盖保留原来的相对路径，例如：

```text
backups/<同步时间-唯一ID>/.claude/settings.json
```

macOS 开发版应用数据目录通常为 `~/Library/Application Support/ai-sync/`，以界面实际打开的路径为准。备份文件权限为 `0600`，目录为 `0700`。新增文件无原内容，不生成备份。

恢复目前需要手动将备份复制回对应 HOME 路径；Finder 中可按 `⌘⇧.` 显示隐藏目录。跨文件同步不是全局事务：中途失败可能已有部分文件成功，错误信息会报告数量与备份位置；不会自动回滚或删除文件。备份不自动清理。

## 安全边界

- 使用普通 HTTP，仅允许 `100.64.0.0/10` 的 IPv4，依赖 Tailscale 提供链路加密和设备身份。当前不支持 MagicDNS、IPv6、HTTPS 或自动发现。
- 应用只校验地址范围，不验证 Tailscale 控制面的设备身份。仅绑定你确认属于 Tailscale 的本机地址；共享前检查 IP。不要做公网端口转发、Funnel 或将令牌交给不可信设备。
- **凭据过滤是保守启发式，不是完整 DLP，也不能保证识别所有密钥。** 常见 token、password、API key 和私钥会导致整个文件被排除；使用 `${ENV_NAME}` / `{env:NAME}` 等引用代替硬编码。任何配置都应在开启共享前人工检查。
- 配对令牌保存在本机应用数据目录，文件权限 `0600`。不进入仓库，不在默认 UI 明文显示；没有接入 Keychain。
- MCP / Skills 在此应用中不会执行，但你的 Agent 后续可能加载它们。只从可信设备拉取，审查脚本、命令和 MCP 配置。
- 本地恶意进程、并发修改文件系统的攻击者不在安全保证范围。写入前做内容校验和路径检查，并用原子替换减少误覆盖，但不是跨进程锁或事务。

## Git / PR 工作流

- `main`：稳定基线。
- `develop`：开发集成，功能经 PR 后进入。
- `feature/safe-sync-core`：同步核心与测试。
- `feature/desktop-gui`：GUI，基于核心功能的 stacked branch。

远程仓库：[BaconTesla/ai-sync](https://github.com/BaconTesla/ai-sync)。四个分支已推送，功能通过以下 PR 审查，尚未合并：

1. [PR #1：同步核心](https://github.com/BaconTesla/ai-sync/pull/1)，`feature/safe-sync-core` → `develop`。
2. [PR #2：桌面 GUI](https://github.com/BaconTesla/ai-sync/pull/2)，`feature/desktop-gui` → `feature/safe-sync-core`（stacked PR）。

核心 PR 合并后，把 GUI PR 的 base 改为 `develop`；若采用 squash merge，需要先 rebase 清理已合并的核心提交。功能验收完成后，再创建 `develop` → `main` 的发布 PR。

PR 合并前，如需运行完整 MVP，请使用 GUI 分支：

```sh
git clone --branch feature/desktop-gui https://github.com/BaconTesla/ai-sync.git
cd ai-sync
npm ci
npm start
```

CI 在 macOS 上运行类型编译和核心测试。新 package 引入前必须先通过 Context7 查询最新文档，记录见 [`docs/context7.md`](docs/context7.md)。

## 后续计划

- 两台物理 Mac 的跨机验收与大目录性能测试。
- Agent adapter、自定义受信路径和更精细的共享白名单。
- MCP 字段级合并、结构化编辑与环境变量映射。
- 设备发现、Keychain 配对凭据、设备信任与撤销。
- 三方差异 / 冲突策略、备份恢复 GUI，再考虑自动同步。
- `.app` / DMG 构建、签名、公证和发布流程。
