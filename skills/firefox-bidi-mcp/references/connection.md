# 连接与启动

> 从 SKILL.md §一 拆出。首次连浏览器、判断该不该起新的、处理会话占用时读这份。

### 1.1 两种起点：自己起 / 连已经在跑的

**先判断，再动手** —— 这两条路的处置完全不同：

```bash
# ① 端口已经在听？说明浏览器已经在跑（很可能用户自己开的），直接连，别再起
netstat -ano | grep LISTENING | grep ':9222'
```

| 情况 | 怎么做 |
|---|---|
| **端口在听** | ✅ **直接连**。⛔ **不要**再 `launch-firefox.mjs`（它带 `-no-remote --new-instance`，会另起一个实例） |
| **端口没听** | 用脚本起新的：`node scripts/launch-firefox.mjs --profile <PROFILE> --port <PORT>` |

⚠️ **`launch-firefox.mjs` 只管"起它自己的实例"，接别人已开的 Firefox 不在它的职责内** ——
文件头注释原话：「*an ALREADY RUNNING browser over its BiDi port. Starting that browser is an
[caller's] job*」，且它总是带 `-no-remote --new-instance`，**永不劫持已在跑的 Firefox**。

**chrome 层权限**：只在**启动时**读环境变量。

```bash
# 自己起：脚本已替你设好（除非加 --no-system-access）
# 连已在跑的：它启动时带没带 MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 取决于当初怎么开的
```

**判据**：`browser_profile_info` 返回里有 `systemAccess: 1` ⇒ chrome 层可用；
报 `System access is required` ⇒ 这个实例启动时没带环境变量，**只能重启它**才能补上。

⭐ **Windows 用户级变量**（`[Environment]::SetEnvironmentVariable(..., 'User')`）对
**用快捷方式启动的** Firefox 生效，但对**从 DSH 进程里 `Start-Process` 起的**不一定 ——
后者继承的是 DSH 的环境。要么显式传，要么用快捷方式起。

### 1.2 一个 Firefox 只能有一个 BiDi 会话

客户端被杀不会发 `session.end`，会**泄漏会话**，之后所有调用都报
`Maximum number of active sessions` 或 `already has an active BiDi session`
—— **只能重启 Firefox 才清得掉**。

⭐ **但先别急着重启**：多数时候是**本机有一个僵住的 MCP 进程占着**，处理它比重启浏览器便宜。

```powershell
# 列出占着会话的 MCP 进程（比对启动时间与 Firefox 的先后）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*DSHBrowserMCP*' } |
  Select-Object ProcessId, CreationDate
```

**判据**：有进程的 `CreationDate` **早于** Firefox 的启动时间 ⇒ 它就是占着会话的元凶。

⭐ **但不要用 `Stop-Process -Force` 硬杀**（2026-10-31 实测）：那是 `TerminateProcess`，Node 的
`SIGTERM`/`SIGINT`/stdin-end 处理器都来不及跑，`shutdown()` 里的 `session.end` 不会发出 ⇒
会话照样泄漏，Firefox 依旧报 `already has an active BiDi session`，**最后还是要重启 Firefox**。

**正确顺序**：

1. 先走**优雅退出**：关闭该进程的 stdin / `Ctrl+C` / 能触发 Node `SIGTERM` 处理器的路径
   （MCP 源码里 `SIGINT`/`SIGTERM`/stdin `end` 都会 `shutdown()` 并发送 `session.end`）；
2. 再启动新进程；
3. 用 `browser_list_tabs` 验证；仍报 `already has an active BiDi session` ⇒ 只能**重启 Firefox**。

⚠️ DSH 会**自动起一个新的** MCP 进程，所以杀完进程表里仍会看到 2 个 —— 新的那个才是候选。
⚠️ **跨进程不能“接管”旧会话**：BiDi 一个 session 绑一条 WebSocket，没有 resume/attach；
旧连接断了但 session 未 end 时，新连接既不能复用也不能结束它。

### 1.3 `browsing-context` id 每次 `session.new` 都会变

⇒ 别缓存，用 **URL 片段**匹配。
