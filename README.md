# firefox-bidi-mcp

通过 WebDriver BiDi 控制真实 Firefox 的 MCP server —— 177 个 `browser_*` 工具，覆盖网页、标签页、窗口、书签历史、设置、扩展、DevTools、翻译、证书等 17 个域。

> An MCP server that drives a real Firefox over WebDriver BiDi.

## 特点

- **只有一条通道**：一条 BiDi WebSocket 同时服务页面操作与浏览器内核层（chrome 上下文），不需要自研浏览器扩展
- **覆盖面广**：从点击输入、截图、网络，到改 prefs、装扩展、读书签历史与证书
- **写操作有标记**：每个工具带 MCP `annotations`，客户端可据此对写操作/破坏性操作要求确认
- **不劫持你的浏览器**：启动脚本永远另起实例，不会接管正在运行的 Firefox

## 前置条件

- Node.js ≥ 20
- Firefox（Developer Edition，或任何支持 WebDriver BiDi 的版本）
- 需要访问浏览器内核层时，Firefox 必须以 `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` 启动

## 安装

```bash
git clone https://github.com/XuanZhiYouXuan2025/firefox-bidi-mcp.git
cd firefox-bidi-mcp
npm install
npm run build
```

## 启动 Firefox

仓库自带启动脚本，它只负责「起一个新实例」，**不会**连接已在运行的浏览器：

```bash
node scripts/launch-firefox.mjs --profile <profile目录> --port 9222
```

- `--profile` **必填**；脚本从不猜档案路径（跑错档案比直接报错更糟）
- 默认带 `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`；加 `--no-system-access` 可关闭（届时只能用页面层工具）
- 已经在跑的 Firefox 不要再用它启动，直接连它的 BiDi 端口

## 接入 MCP 客户端

任何支持 stdio 传输的客户端都行：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["<绝对路径>/firefox-bidi-mcp/dist/index.js"],
      "env": { "DSH_BROWSER_BIDI_PORT": "9222" }
    }
  }
}
```

### 端口是怎么定的

按顺序取第一个可用的：`DSH_BROWSER_BIDI_PORT` → `~/.firefox-devtools-mcp/instances/<pid>.port`（取最新）→ `9222`。

> 环境变量沿用 `DSH_` 前缀，但它们与 DeepSeek Harness 没有强绑定，任何客户端都能用。

其他可选变量：`DSH_BROWSER_MAX_OUTPUT_CHARS`（默认 1000000）、`DSH_BROWSER_OUTPUT_DIR`（默认系统临时目录，用于放超大结果）。

## 工具

177 个 `browser_*` 工具的分组速查见 [`skills/firefox-bidi-mcp/references/tools.md`](skills/firefox-bidi-mcp/references/tools.md)。

⚠️ 该文件由 `npm run gen-docs` 从 `src/index.ts` 生成，**不要手改**；要加工具请改源码后重跑。

Firefox 内部 API 的反直觉行为、工具实现层面的坑、会话泄漏的处置，见 [`docs/gotchas.md`](docs/gotchas.md) —— 按需查，不是必读。

## 安全模型

- 工具用 MCP `annotations` 标注：`readOnlyHint: false` 表示会改变状态，`destructiveHint: true` 表示影响超出当前会话（改 prefs、导航等）
- **是否要求确认由客户端决定**，浏览器侧不强制
- 本 server 能读写 profile 数据（书签、历史、登录库、cookie）—— 请自行评估运行环境与目标档案

## 已知限制

- 一个 Firefox 实例同时只能有一个 BiDi 会话；客户端异常退出会**泄漏会话**，此时只能重启 Firefox
- `browsing-context` id 每次 `session.new` 后都会变，**不要缓存**
- 用 `Stop-Process -Force` 这类硬杀会跳过优雅退出，照样泄漏会话；优先关 stdin / `SIGINT` / `SIGTERM`

## 给 DSH 用户（可选）

仓库内的 `skills/firefox-bidi-mcp/` 是一个 DeepSeek Harness 技能，记录了这个 server 的使用纪律。**非 DSH 用户不需要它**；DSH 专属内容（技能安装、实例占着浏览器时的处置、与 Cua 配合做「真人输入」）见 [`docs/dsh-integration.md`](docs/dsh-integration.md)。

```powershell
# Windows：把技能以 junction 挂进 DSH 的 skills 目录
./scripts/install-skill.ps1 -DshHome <你的 DSH_HOME>
```

## 开发

```bash
npm run build      # tsc 编译到 dist/
npm run gen-docs   # 从源码重新生成 tools.md
```

## 许可证

[MIT](LICENSE)
