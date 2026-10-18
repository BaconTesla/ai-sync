# 依赖文档记录

实现前通过 `https://mcp.context7.com/mcp` 的 MCP `resolve-library-id` / `query-docs` 获取文档。

| 依赖 | Context7 library ID | 查阅主题 |
| --- | --- | --- |
| Electron | `/electron/electron` | BrowserWindow sandbox / contextIsolation；preload contextBridge；定向 IPC；校验 sender；禁止 Node integration |
| TypeScript | `/microsoft/typescript-website` | strict、rootDir/outDir、CommonJS/Node 模块、独立 DOM 编译配置 |
| JSON5 | `/json5/json5` | `parse` 读取带注释 / 尾逗号的 JSONC；NaN / Infinity 等非 JSON 值边界；解析错误脱敏 |
| Smol TOML | `/squirrelchat/smol-toml` | `parse` / `stringify`、`integersAsBigInt: true`、`numbersAsFloat: true` 保留整数及浮点类型；TomlDate 精度限制；原型污染防护 |

MCP 范围限制实现前先尝试检索 `jsonc-parser` / `microsoft/node-jsonc-parser`，Context7 未收录该库；未引入该依赖，改用已查阅文档的 JSON5 与 Smol TOML。JSONC / TOML 写回会重新序列化，注释和排版不保证保留，界面会在确认前提示；暂不支持无损处理的 TOML 日期 / 时间值在写入时拒绝处理。

采用 Electron 官方安全建议：渲染层不能访问 Node、不能任意调用 IPC，不加载远程页面，不允许新窗口或导航。后续引入新 package 前也必须先查询 Context7。

参考：
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.typescriptlang.org/tsconfig/
