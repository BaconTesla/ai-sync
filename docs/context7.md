# 依赖文档记录

实现前通过 `https://mcp.context7.com/mcp` 的 MCP `resolve-library-id` / `query-docs` 获取文档。

| 依赖 | Context7 library ID | 查阅主题 |
| --- | --- | --- |
| Electron | `/electron/electron` | BrowserWindow sandbox / contextIsolation；preload contextBridge；定向 IPC；校验 sender；禁止 Node integration |
| TypeScript | `/microsoft/typescript-website` | strict、rootDir/outDir、CommonJS/Node 模块、独立 DOM 编译配置 |

采用 Electron 官方安全建议：渲染层不能访问 Node、不能任意调用 IPC，不加载远程页面，不允许新窗口或导航。后续引入新 package 前也必须先查询 Context7。

参考：
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.typescriptlang.org/tsconfig/
