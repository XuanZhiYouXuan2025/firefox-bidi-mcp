---
name: browser-mcp
description: 用 dsh-browser-mcp 控制 Firefox —— 177 个 browser_* 工具的选择纪律、连接前提与安全边界
whenToUse: 需要通过 dsh-browser-mcp 操作 Firefox（网页/标签页/窗口/书签历史/设置/扩展/DevTools/翻译/证书）时；或工具返回空对象、超时、看似不可用时
---

# browser-mcp — Firefox 控制的总纪律

> 服务：`dsh-browser-mcp`（177 个 `browser_*` 工具，17 个域）
> 传输：BiDi（主）+ Marionette（仅 GPC 与个别内部 helper）
> 工具清单：`references/tools.md`（由源码生成，⛔ 别手改）
> 踩坑与实测记录：`docs/gotchas.md`（按需查，非必读）
> DSH 专属集成：`docs/dsh-integration.md`
> 命令一律相对**仓库根**（含 `package.json` 的那层）

## 一、开跑之前

### 1.1 先判断：自己起 / 连已在跑的

```bash
# 端口在听 ⇒ 浏览器已经在跑，直接连
netstat -ano | grep LISTENING | grep ':9222'
```

| 情况 | 怎么做 |
|---|---|
| **端口在听** | ✅ 直接连。⛔ 不要再 `launch-firefox.mjs`（它带 `-no-remote --new-instance`，会另起一个实例） |
| **端口没听** | `node scripts/launch-firefox.mjs --profile <PROFILE> --port <PORT>` |

`launch-firefox.mjs` 只管「起它自己的实例」，**永不劫持已在跑的 Firefox**。

**chrome 层权限只在启动时读环境变量**（`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`）。
判据：`browser_profile_info` 返回里有 `systemAccess: 1` ⇒ chrome 层可用；报 `System access is required` ⇒ 这个实例启动时没带，只能重启它。

### 1.2 一个 Firefox 只能有一个 BiDi 会话

客户端被杀不会发 `session.end` ⇒ 会话泄漏 ⇒ 之后所有调用报 `Maximum number of active sessions`。

处置顺序：

1. 先找僵住的 MCP 进程（多数时候是它占着），**优雅退出**（关 stdin / Ctrl+C）
2. ⛔ 不要 `Stop-Process -Force` —— 那会跳过 Node 的退出处理器，`session.end` 发不出去，会话照样泄漏
3. 仍报错 ⇒ 只能重启 Firefox

### 1.3 `browsing-context` id 每次 `session.new` 都会变

⇒ 别缓存，用 URL 片段匹配。

### 1.4 用 `context` 参数锁定目标标签页

以下工具支持可选 `context`（来自 `browser_list_tabs`）：

`navigate` · `evaluate` · `click` · `type` · `page_info` · `screenshot` · `scroll` · `hover` · `press_key`

指定 `context` 时**不需要 `activate_tab`，也不会抢前台**——BiDi 直接对目标 context 执行。

**后台操作流程**：

1. `browser_new_window { url }` 或 `browser_new_tab { url }` 拿到 context id
2. 之后所有动作都传 `context: <id>`
3. 用 `browser_list_tabs` 校验目标 URL（只读，不切前台）
4. 收工 `close_tab` / `close_window`

⚠️ 仍不支持 `context` 的工具（`upload_file` / `pdf` / `mouse_action` / `set_viewport` 等）作用于活动标签页——用后以 `browser_page_info` 核对。
⛔ 不要把窗口 id（clientWindow）当 tab context 传。

## 二、选工具的三条纪律

1. **先找现成的，别自己拼 JS**。177 个工具覆盖 17 个域；`browser_evaluate` 是退路不是首选
2. **要「浏览器内部状态」走专用工具**：内存 → `browser_memory_usage`、诊断 → `browser_troubleshoot`、证书 → `browser_certificate_manage`
3. **写操作前先读**：`browser_list_*` / `browser_get_*` 拿现状，再动手，动完再读回验证

## 三、安全边界

- **不要在用户正在看的标签页上做写操作**——导航、点击、输入、关标签，先另开窗口。完整判据见 `docs/dsh-integration.md`
- **页面层拿不到特权**：`browser_evaluate` 跑在页面里，没有 `Services`/`Cc`/`Ci`/`ChromeUtils`。要碰浏览器内部必须走 chrome 上下文（工具内部用 `withChrome`）
- **元素「存在」≠「可见」**：读 `body.textContent` 会把隐藏模板一起读出来。判据：`el.offsetParent || el.getClientRects().length`
- **改动过的 pref 要恢复**：收工前用 `browser_troubleshoot` 的 `modifiedPreferences` 复查

## 四、收工（缺一步都算没做完）

1. `node scripts/launch-firefox.mjs --stop --port <PORT>`
2. 读回：该端口不再 LISTENING
3. 读回：带窗口的 firefox 进程数回到基线（**窗口也算遗留，不只是进程**）
4. 恢复改动过的 pref

## 五、执行环境

- 测试**只用测试档案**（单独建一个 profile 目录），⛔ 不碰主力实例与主力档案
- ⛔ 不打印凭据
- 每个「已验证」必须附实测输出；⛔「应该能行」不算验证
