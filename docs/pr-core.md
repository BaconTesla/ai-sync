# feat: authenticated safe configuration pull engine

Target: `develop` · Source: `feature/safe-sync-core`

## 内容
- HOME 相对路径白名单和 Agent 分类。
- Tailscale IPv4 绑定、256-bit 令牌鉴权、只读 HTTP snapshot。
- 路径穿越 / 符号链接 / 超限文件 / 常见凭据拦截。
- 内存快照预览、整文件拉取、覆盖前备份、乐观并发检查。
- macOS CI 与 Context7 依赖文档记录。

## 验证
- `npm test`：10 项测试通过，包括临时目录双设备 HTTP 模拟。
- 不读取或修改真实 Agent 配置。

## 限制
- 不是自动双向同步，不同步删除，不执行远程代码。
- 凭据过滤是启发式，不保证完整识别。
- 跨文件写入不是事务。

GUI 在后续 stacked PR 中实现。
