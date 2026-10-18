# AI Sync

用 GUI 同步 Mac mini / MacBook 上的 **Skills 和 MCP 服务定义**，不共享模型偏好、权限、历史等其他设置。基于 **Electron + TypeScript**，通过 **Tailscale IPv4 + 配对令牌**直接在设备间手动拉取，不依赖云端同步服务。

> 第一版：**v0.2.1（开发预览版）**。完整功能以 `main` 为使用入口，仍不是已签名的 macOS 安装包。先用不重要的配置验证，再用于日常环境。

## 已实现

- 本机 Skills / MCP 清单：一个 Skill 一项，按 Agent、Skills、MCP 筛选与搜索。
- 点击 Skill 展示可折叠的文件树，默认预览 `SKILL.md`，点击子文件预览内容。搜索子文件名仍返回整个 Skill，不拆成独立文件条目。
- Skill 文本预览；JSON / JSONC / Codex TOML 中只提取顶层 MCP 服务定义供展示与共享，不传输完整配置。仅展示声明，不执行或探测服务。
- MCP 按服务名称合并：新增服务加入，同名服务经确认后整条替换，本机独有服务保留。模型、权限、历史等其他设置值保持不变。
- 手动开启只读共享，绑定指定的 Tailscale IPv4，随机 256-bit 配对令牌。
- 拉取前展示本机 / 对端内容，区分新增、不同、相同。**默认不勾选任何文件**。
- 明确勾选并二次确认；覆盖前备份；预览后本机文件变化则拒绝覆盖。
- 路径白名单、符号链接拦截、文本与大小限制、常见内嵌凭据过滤。
- 渲染进程隔离：sandbox、contextIsolation、定向 IPC、CSP、禁用导航与权限。

## 启动

建议 Node.js 24 LTS，macOS，npm。首次获取第一版：

```sh
git clone --branch main https://github.com/BaconTesla/ai-sync.git
cd ai-sync
npm ci
npm start
```

已有仓库时，先关闭旧版应用，在工作区没有未提交修改的情况下切换到 `main` 并更新：

```sh
git fetch origin
git switch main
git pull --ff-only
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
3. 显示本机令牌并安全复制给 **目标设备**。令牌授予读取所有通过过滤的 Skills 与 MCP 定义的权限，不授予读取完整 Agent 设置的接口，不要发到公开聊天或提交到 Git。
4. 在目标设备填入源设备的 IP、端口和令牌，点击“连接并预览”。
5. 点击 Skill 名称查看文件树和各文件的本机 / 对端内容，勾选整个 Skill 后点击“拉取所选”。它所有新增或有差异的可共享文件会一起列入写入清单，相同文件不重写，本机独有文件不删除。安全过滤仍生效，树中只展示通过过滤的文件，其他文件见排除提示。MCP 只合并对应文件的 MCP 字段；当前以一个来源文件中的 MCP 服务组为选择单位，不支持单独勾选组内某个服务。
6. 用完在源设备停止共享，或直接关闭窗口。重置令牌会同时关闭共享，旧令牌失效。
7. 反方向同步时交换源设备和目标设备即可。

**Skills 在界面中按整个 Skill 选择，底层逐文件写入；MCP 只合并服务定义，绝不接受其他设置字段。** 同名 MCP 服务会按对端定义整条替换，不合并服务内部字段；本机独有服务不会删除。当前不判断哪一份更新，差异条目必须手动勾选并确认。

MCP 写入时会重新序列化配置文件，**格式会调整，注释可能移除**，但其他设置值保留，写入前备份完整原文件。无法安全解析或合并时拒绝写入，不回退到整文件复制。Codex TOML 中日期 / 时间值的无损写入暂不支持，遇到此类本机文件会拒绝合并。

预览有效期 5 分钟；拉取时使用已经校验的快照。包括非 MCP 设置在内，本机原文件在预览后发生任何内容变化都会中止写入。

**两台设备必须使用此范围限制版本。** 协议已升级到 `/v2/snapshot`；旧版整文件同步端点已关闭，也不会向旧端点请求配置。升级前请先关闭两台设备上的旧版应用，再运行新版。

### 支持的默认路径

路径相对于用户 HOME：

| Agent | Skills | MCP 来源（只提取 MCP 字段） |
| --- | --- | --- |
| Claude Code | `.claude/skills/**` | `.claude/settings.json`、`.claude.json` |
| Codex | `.codex/skills/**` | `.codex/config.toml` |
| Gemini CLI | `.gemini/skills/**` | `.gemini/settings.json` |
| OpenCode | `.config/opencode/skills/**` | `.config/opencode/opencode.json`、`opencode.jsonc` |
| Shared | `.agents/skills/**` | — |

不扫描整个 HOME，不读取项目级配置，不同步 `.env`、`auth.json`、认证目录、隐藏 Skill 文件或 `node_modules`，不跟随符号链接。单文件上限 256 KiB，文本总量 4 MiB，最多 500 个文件。MCP 定义可包含设备相关绝对路径，拉取后可能需要手动调整。

JSON / JSONC 只选择顶层 `mcpServers`（Claude / Gemini）或 `mcp`（OpenCode），Codex TOML 只选择顶层 `mcp_servers`。`.claude.json` 的项目列表及其嵌套 MCP 不会共享。没有顶层 MCP 定义的设置文件不出现在同步清单中；解析失败的文件只报告通用错误，不将原文或解析器的敏感片段发给对端。不保证支持每个工具的全部配置版本。

### Skill 的识别与展示

- 以 `SKILL.md`（文件名大小写不敏感）所在目录识别一个 Skill，子目录有自己的 `SKILL.md` 时独立分组，不并入父 Skill。
- 名称优先使用 `SKILL.md` frontmatter 中简单单行的 `name`，其次使用该文件的一级标题，最后回退到目录名。此处不是完整 YAML 解析器；复杂 YAML 名称使用回退规则。
- 脚本、参考文档、模板等归属于对应 Skill，只在点击后的文件树中展开。同名 Skill 在不同 Agent / 路径中仍独立显示。
- 没有可共享 `SKILL.md` 的散落文件不当作独立 Skill，也不共享。若入口文件被安全过滤，其附属文件也会被排除。
- 顶部条目数量、勾选数量按 Skill / MCP 服务组计算；确认对话框会另外列出实际要写入的文件数。
- “勾选整个 Skill”不是跨文件原子事务，仍受大小、类型、凭据过滤限制，也不保证被过滤掉的依赖文件能够使用。请先查看排除提示。

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
- **凭据过滤是保守启发式，不是完整 DLP，也不能保证识别所有密钥。** 常见 token、password、API key 和私钥会导致对应 Skill 文件或整个 MCP 服务组被排除；非 MCP 字段中的密钥不会被提取或传输。使用 `${ENV_NAME}` / `{env:NAME}` 等引用代替硬编码。任何配置都应在开启共享前人工检查。
- 配对令牌保存在本机应用数据目录，文件权限 `0600`。不进入仓库，不在默认 UI 明文显示；没有接入 Keychain。
- MCP / Skills 在此应用中不会执行，但你的 Agent 后续可能加载它们。只从可信设备拉取，审查脚本、命令和 MCP 配置。
- 本地恶意进程、并发修改文件系统的攻击者不在安全保证范围。写入前做内容校验和路径检查，并用原子替换减少误覆盖，但不是跨进程锁或事务。

## Git / PR 工作流

- `main`：第一版及后续发布的使用入口，不再需要切换到具体功能分支。
- `develop`：后续开发集成分支。
- `feature/*`：后续单个功能从 `develop` 建分支，完成后 push 并创建面向 `develop` 的 PR；验收后再通过发布 PR 集成到 `main`。

远程仓库：[BaconTesla/ai-sync](https://github.com/BaconTesla/ai-sync)。第一版的四个功能 PR 已合并并完整集成到 `develop`：

1. [PR #1：同步核心](https://github.com/BaconTesla/ai-sync/pull/1)。
2. [PR #2：桌面 GUI](https://github.com/BaconTesla/ai-sync/pull/2)，合并前已将目标分支改为 `develop`。
3. [PR #3：仅同步 Skills 与 MCP](https://github.com/BaconTesla/ai-sync/pull/3)。
4. [PR #4：Skill 名称分组与文件树](https://github.com/BaconTesla/ai-sync/pull/4)。

文件树先合入范围限制分支，再合入 GUI；完整 GUI 最后进入 `develop`，通过[发布 PR #5](https://github.com/BaconTesla/ai-sync/pull/5)集成到 `main`。功能分支保留作开发历史，日常使用请以 `main` 为准。第一版说明见 [`docs/releases/v0.2.1.md`](docs/releases/v0.2.1.md)。

仓库已配置 macOS CI 工作流。本地类型检查、32 项测试和 GUI 冒烟测试通过；第一批功能 PR 检查时 GitHub 未返回 CI 记录，不将其视为远程 CI 通过。集成后 GitHub 已触发 macOS CI，发布 PR 必须等待其检查通过再合并。新 package 引入前必须先通过 Context7 查询最新文档，记录见 [`docs/context7.md`](docs/context7.md)。

## 后续计划

- 两台物理 Mac 的跨机验收与大目录性能测试。
- Agent adapter、自定义受信路径和更精细的共享白名单。
- 单个 MCP 服务的勾选、结构化编辑、环境变量映射，以及保留原注释和排版的局部编辑。
- 设备发现、Keychain 配对凭据、设备信任与撤销。
- 三方差异 / 冲突策略、备份恢复 GUI，再考虑自动同步。
- `.app` / DMG 构建、签名、公证和发布流程。
